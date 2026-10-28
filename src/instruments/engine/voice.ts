import type { SampleBank } from './bank'
import { INTERP_RADIUS, readAt } from './interp'
import type { LoopMode, SampleZone } from './types'

export interface VoiceOptions {
  /** Output sample rate. */
  sampleRate?: number
  bank?: SampleBank
  /** Linear amplitude. When omitted, zone gain times velocity is used. */
  gain?: number
  /** Extra cents, from the instrument tune control. */
  tune?: number
  attack?: number
  decay?: number
  sustain?: number
  release?: number
  /** Loop crossfade in source frames. */
  loopCrossfade?: number
}

export interface SampleZoneVoice {
  readonly zoneId: string
  readonly note: number
  readonly velocity: number
  readonly active: boolean
  release(velocity?: number): void
  choke(): void
  /** Add this voice into the buffers. */
  render(left: Float32Array, right: Float32Array): void
  position(): number
}

const QUIET = 0.0008

function unitVelocity(velocity: number) {
  if (!(velocity > 0)) return 0
  if (velocity > 1) return Math.max(0, Math.min(1, velocity / 127))
  return Math.min(1, velocity)
}

function soft(sample: number) {
  if (!Number.isFinite(sample)) return 0
  if (sample > 1 || sample < -1) return Math.tanh(sample)
  return sample
}

/**
 * One zone, one note.
 * `velocity` is 0–1, matching the rest of the DAW. Values above 1 are MIDI 1–127.
 * The voice streams: it plays whatever the bank has resident and asks for the next page ahead of the playhead.
 */
export function createSampleZoneVoice(zone: SampleZone, note: number, velocity: number, options: VoiceOptions = {}): SampleZoneVoice {
  const outputRate = options.sampleRate && options.sampleRate > 0 ? options.sampleRate : 48000
  const bank = options.bank
  const amplitude = options.gain != null ? options.gain : zone.gain * unitVelocity(velocity)
  const attackSec = options.attack ?? zone.attack ?? 0
  const decaySec = options.decay ?? zone.decay ?? 0
  const sustain = options.sustain ?? zone.sustain ?? 1
  const releaseSec = options.release ?? zone.release ?? 0.2
  let attackSamples = Math.max(0, attackSec * outputRate)
  let decaySamples = Math.max(1, decaySec * outputRate)
  let releaseSamples = Math.max(1, releaseSec * outputRate)
  const cents = zone.tune + (options.tune ?? 0)
  let sourceRate = outputRate
  let end = zone.end > zone.start ? zone.end : 0
  let pos = Math.max(0, zone.start)
  let dir = 1
  let env = attackSamples <= 1 ? 1 : 0
  let released = false
  let active = amplitude > 0 && Boolean(zone.sampleId)
  let looping = zone.loopMode === 'forward' || zone.loopMode === 'sustain' || zone.loopMode === 'pingpong'
  let pending = false
  let mute = 0
  let last = 0
  const oneshot = zone.loopMode === 'oneshot'
  const pan = Math.max(-1, Math.min(1, zone.pan || 0))
  const leftGain = Math.cos(((pan + 1) * Math.PI) / 4)
  const rightGain = Math.sin(((pan + 1) * Math.PI) / 4)

  const meta = () => bank?.info(zone.sampleId) ?? null

  const rateFor = () => {
    const info = meta()
    if (info) {
      sourceRate = info.sampleRate || outputRate
      if (!(end > pos)) end = info.frames
    }
    const semis = note - zone.root + cents / 100
    return (sourceRate / outputRate) * 2 ** (semis / 12)
  }

  const loopBounds = () => {
    const loopStart = Math.max(0, Math.min(end, zone.loopStart))
    const loopEnd = zone.loopEnd > loopStart ? Math.min(end || zone.loopEnd, zone.loopEnd) : 0
    const length = loopEnd - loopStart
    const asked = options.loopCrossfade ?? zone.loopCrossfade
    const cross = looping && length > 8 ? Math.max(0, Math.min(Math.floor(length / 2) - 1, Math.round(asked))) : 0
    return { loopStart, loopEnd, cross, length }
  }

  const windowAt = (at: number) => {
    if (!bank) return null
    const origin = Math.floor(at) - INTERP_RADIUS
    const frames = INTERP_RADIUS * 2 + 4
    const got = bank.read(zone.sampleId, origin, frames)
    if (got) return { got, origin }
    if (!pending) {
      pending = true
      const from = Math.max(0, Math.floor(at) - 64)
      void bank.prefetch(zone.sampleId, from, 8192).finally(() => {
        pending = false
      })
    }
    return null
  }

  const sampleAt = (at: number) => {
    const found = windowAt(at)
    if (!found) return null
    const left = readAt(found.got[0] ?? new Float32Array(), found.origin, at)
    const right = found.got[1] ? readAt(found.got[1], found.origin, at) : left
    return [left, right]
  }

  const loopedSample = (at: number, mode: LoopMode) => {
    const { loopStart, loopEnd, cross } = loopBounds()
    if (cross > 1 && mode !== 'pingpong' && at >= loopEnd - cross && at < loopEnd) {
      const i = at - (loopEnd - cross)
      const t = i / cross
      const dry = sampleAt(at)
      const wet = sampleAt(loopStart + i)
      if (!dry || !wet) return dry ?? wet
      const a = Math.cos(t * Math.PI * 0.5)
      const b = Math.sin(t * Math.PI * 0.5)
      return [dry[0] * a + wet[0] * b, dry[1] * a + wet[1] * b]
    }
    return sampleAt(at)
  }

  const advance = (rate: number) => {
    const { loopStart, loopEnd, cross, length } = loopBounds()
    const mode = zone.loopMode
    const sustainLoop = mode === 'forward' || mode === 'pingpong' || (mode === 'sustain' && !released)
    pos += rate * dir
    if (!sustainLoop || length < 2) {
      if (end > 0 && pos >= end) active = false
      return
    }
    if (mode === 'pingpong') {
      if (pos >= loopEnd) {
        pos = loopEnd - (pos - loopEnd)
        dir = -1
      } else if (pos <= loopStart) {
        pos = loopStart + (loopStart - pos)
        dir = 1
      }
      return
    }
    if (pos >= loopEnd) {
      const into = pos - loopEnd + cross
      pos = loopStart + into
      if (pos >= loopEnd) pos = loopStart + ((pos - loopStart) % length)
    } else if (pos < loopStart && dir < 0) pos = loopStart
  }

  const stepEnv = () => {
    if (!released) {
      if (env < 1 && attackSamples > 1) env = Math.min(1, env + 1 / attackSamples)
      else if (decaySamples > 1 && env > sustain + 0.0001) env += (sustain - env) * (1 - Math.exp(-1 / decaySamples))
      else env = Math.max(env, sustain)
      return
    }
    env *= Math.exp(-1 / releaseSamples)
    if (env < QUIET) active = false
  }

  if (bank) {
    void bank.open(zone.sampleId).then((info) => {
      if (!info) return
      sourceRate = info.sampleRate || sourceRate
      if (!(end > pos)) end = info.frames
      const { loopStart, loopEnd } = loopBounds()
      if (loopEnd > loopStart) void bank.prefetch(zone.sampleId, Math.max(0, loopStart - 16), loopEnd - loopStart + 32)
    })
  }

  return {
    zoneId: zone.id,
    note,
    velocity: unitVelocity(velocity),
    get active() {
      return active
    },
    release() {
      if (oneshot) return
      released = true
      if (zone.loopMode === 'sustain') looping = false
    },
    choke() {
      released = true
      releaseSamples = Math.max(1, 0.008 * outputRate)
      attackSamples = 0
      decaySamples = 1
    },
    position() {
      return pos
    },
    render(left, right) {
      const frames = left.length
      const rate = Math.max(0.0001, rateFor())
      for (let i = 0; i < frames; i++) {
        if (!active) break
        stepEnv()
        if (!active) break
        const pair = loopedSample(pos, zone.loopMode)
        let sampleL = last
        let sampleR = last
        if (pair) {
          mute = Math.max(0, mute - 1 / 64)
          sampleL = pair[0] * (1 - mute) + last * mute
          sampleR = pair[1] * (1 - mute) + last * mute
          last = (sampleL + sampleR) * 0.5
        } else {
          mute = Math.min(1, mute + 1 / 64)
          sampleL *= 1 - mute
          sampleR *= 1 - mute
        }
        const shaped = env * amplitude
        left[i] = soft((left[i] || 0) + sampleL * shaped * leftGain)
        if (right.length > i) right[i] = soft((right[i] || 0) + sampleR * shaped * rightGain)
        advance(rate)
      }
    },
  }
}

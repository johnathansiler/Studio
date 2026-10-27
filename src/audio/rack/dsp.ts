import {
  allocateVoice,
  applyMod,
  audioCycle,
  DEVICE_PARAMS,
  isEffect,
  isInstrument,
  nextArp,
  paramAt,
  zoneFor,
  type Cable,
  type DeviceKind,
  type RackAutomation,
  type RackDevice,
  type RackState,
  type VoiceRef,
} from '../../model/rack'
import { knockNoteOn, knockStep, knockVoice } from './knock'
import { renderTone, tableFromAudio, type PlayVoice, type SynthState } from './synth'
import { drumStepIndex } from '../../model/steps'

export interface SampleBuffer {
  sampleRate: number
  channels: Float32Array[]
}

export interface NoteEvent {
  sample: number
  pitch: number
  vel: number
  slide?: boolean
}

interface Mem {
  phase: number
  phase2: number
  low: number
  band: number
  pos: number
  amp: number
  fenv: number
}

interface Voice extends VoiceRef, PlayVoice {
  vel: number
  mem: Record<string, Mem>
  synth: Record<string, SynthState>
  knockGen: number
  knockSlide: boolean
}

interface Fx {
  env: number
  phase: number
  delay: Float32Array
  delayPos: number
  combs: Float32Array[]
  combPos: number[]
  low: number
  band: number
  lp: number
}

function mem(): Mem {
  return { phase: 0, phase2: 0, low: 0, band: 0, pos: 0, amp: 0, fenv: 0 }
}

function san(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  return Math.max(-1.5, Math.min(1.5, value))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
}

function env(value: number, released: boolean, attackMs: number, decayMs: number, sustain: number, releaseMs: number, sr: number) {
  if (!released) {
    const attack = Math.max(1, (attackMs / 1000) * sr)
    if (value < 0.999) return Math.min(1, value + 1 / attack)
    const decay = Math.max(1, (decayMs / 1000) * sr)
    return value + (sustain - value) * (1 - Math.exp(-1 / decay))
  }
  const release = Math.max(1, (releaseMs / 1000) * sr)
  return value * Math.exp(-1 / release)
}

function svf(state: Mem, input: number, cutoff: number, res: number, sr: number, highpass: boolean) {
  const f = 2 * Math.sin(Math.min(Math.PI * 0.45, (Math.PI * clamp(cutoff, 20, sr * 0.45)) / sr))
  const q = clamp(1 - res * 0.92, 0.08, 1)
  state.low = san(state.low + f * state.band)
  const high = san(input - state.low - q * state.band)
  state.band = san(state.band + f * high)
  return highpass ? high : state.low
}

export class RackRuntime {
  readonly sampleRate: number
  sampleTime = 0
  private voices: Voice[] = []
  private held: number[] = []
  private fx = new Map<string, Fx>()
  private cv: Record<string, number> = {}
  private usingArp = false
  private arpNote: number | null = null
  private arpOn = false
  private drumStep = -1
  private lastNote = 0
  private frame = 0
  private tables = new Map<string, Float32Array[]>()
  private knockDelta = 0

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
  }

  note(pitch: number, vel: number, polyphony = 8, slide = false) {
    const midi = Math.round(pitch)
    if (vel <= 0.0001) {
      this.held = this.held.filter((note) => note !== midi)
      for (const voice of this.voices) if (voice.note === midi) voice.released = true
      return
    }
    if (!this.held.includes(midi)) this.held.push(midi)
    if (slide) {
      const heldVoice = this.voices.find((voice) => voice.active && !voice.released)
      if (heldVoice && heldVoice.note !== midi) {
        heldVoice.note = midi
        heldVoice.vel = vel
        heldVoice.age = 0
        heldVoice.bend = 0
        heldVoice.knockSlide = true
        heldVoice.knockGen = (heldVoice.knockGen || 0) + 1
        return
      }
    }
    const slot = allocateVoice(this.voices, midi, polyphony) as Voice
    slot.vel = vel
    slot.mem = {}
    slot.synth = {}
    slot.bend = 0
    slot.pressure = 0
    slot.glideFrom = this.lastNote || midi
    this.lastNote = midi
    slot.knockSlide = false
    slot.knockGen = (slot.knockGen || 0) + 1
  }

  express(pitch: number, bend: number, pressure: number) {
    const midi = Math.round(pitch)
    for (const voice of this.voices) {
      if (!voice.active || voice.note !== midi) continue
      voice.bend = bend
      voice.pressure = pressure
    }
  }

  activeVoices() {
    return this.voices.filter((voice) => voice.active).length
  }

  allOff() {
    this.held = []
    for (const voice of this.voices) voice.released = true
  }

  render(rack: RackState, frames: number, tempo: number, quality: 'full' | 'eco', buffers: Map<string, SampleBuffer>, lanes?: RackAutomation[], beat = 0) {
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const limit = quality === 'eco' ? Math.min(4, rack.polyphony) : rack.polyphony
    while (this.voices.filter((voice) => voice.active).length > limit) {
      const extra = this.voices.filter((voice) => voice.active).sort((a, b) => b.age - a.age)[0]
      if (!extra) break
      extra.active = false
    }
    const cyclic = audioCycle(rack.cables)
    const audioCables = cyclic ? [] : rack.cables.filter((cable) => cable.toPort === 'audio' || cable.toPort === 'audio2')
    const modCables = rack.cables.filter((cable) => cable.toPort !== 'audio' && cable.toPort !== 'audio2')
    const beatSamples = Math.max(1, (60 / Math.max(1, tempo)) * this.sampleRate)
    for (let i = 0; i < frames; i++) {
      const time = this.sampleTime + i
      this.frame = time
      this.fillControl(rack, time, beatSamples, tempo)
      const params = new Map(rack.devices.map((device) => [device.id, this.params(device, modCables, lanes, beat + i / beatSamples)]))
      const produced = new Map<string, number>()
      let bus = 0
      this.knockDelta = 0
      for (const device of rack.devices) {
        const wired = audioCables.filter((cable) => cable.to === device.id)
        const input = wired.length
          ? wired.reduce((sum, cable) => sum + (produced.get(cable.from) || 0) * cable.amount, 0)
          : bus
        const sample = this.device(device, params.get(device.id) ?? device.params, input, limit, buffers, quality, time, beatSamples)
        produced.set(device.id, sample)
        if (wired.length) {
          if (isEffect(device.kind) || device.kind === 'mix') bus = sample
        } else if (isInstrument(device.kind)) bus += sample
        else if (isEffect(device.kind)) bus = sample
      }
      const out = san(bus)
      const widened = rack.devices.some((device) => device.kind === 'knock')
      left[i] = out
      right[i] = widened ? san(bus + this.knockDelta) : out * 0.98
    }
    this.sampleTime += frames
    return [left, right]
  }

  private params(device: RackDevice, cables: Cable[], lanes: RackAutomation[] | undefined, beat: number) {
    const next = { ...device.params }
    for (const item of DEVICE_PARAMS[device.kind]) {
      let value = paramAt(lanes, device.id, item.id, beat, next[item.id] ?? item.default)
      for (const cable of cables) {
        if (cable.to !== device.id || cable.toPort !== item.id) continue
        value = applyMod(value, cable.amount, this.cv[`${cable.from}:${cable.fromPort}`] || 0, item.min, item.max)
      }
      next[item.id] = value
    }
    return next
  }

  private fillControl(rack: RackState, time: number, beatSamples: number, _tempo: number) {
    this.usingArp = false
    for (const device of rack.devices) {
      if (device.kind === 'seq') {
        const rate = Math.max(0.05, device.params.rate || 1)
        const step = Math.floor(time / (beatSamples * rate)) % 8
        this.cv[`${device.id}:cv`] = device.params[`s${step}`] || 0
      } else if (device.kind === 'arp') {
        const rate = Math.max(0.05, device.params.rate || 0.25)
        const stepLen = beatSamples * rate
        const step = Math.floor(time / stepLen)
        const gate = (time % stepLen) / stepLen < (device.params.gate || 0.5)
        const pitch = nextArp(this.held, step, device.params.mode || 0, device.params.octaves || 1)
        this.cv[`${device.id}:pitch`] = pitch == null ? 0 : pitch / 127
        this.cv[`${device.id}:gate`] = gate && pitch != null ? 1 : 0
        this.usingArp = true
        this.arpNote = pitch
        this.arpOn = Boolean(gate && pitch != null)
      }
    }
  }

  private playedNote(voice: Voice) {
    if (!this.usingArp) return voice.note
    if (!this.arpOn || this.arpNote == null) return null
    return this.arpNote
  }

  private voiceMem(voice: Voice, id: string) {
    return (voice.mem[id] ??= mem())
  }

  private fxState(id: string, kind: DeviceKind): Fx {
    const found = this.fx.get(id)
    if (found) return found
    const combs = kind === 'reverb' ? Array.from({ length: 4 }, (_, index) => new Float32Array(800 + index * 230)) : []
    const created: Fx = { env: 0, phase: 0, delay: new Float32Array(this.sampleRate * 2), delayPos: 0, combs, combPos: combs.map(() => 0), low: 0, band: 0, lp: 0 }
    this.fx.set(id, created)
    return created
  }

  private device(device: RackDevice, params: Record<string, number>, input: number, limit: number, buffers: Map<string, SampleBuffer>, quality: 'full' | 'eco', time: number, beatSamples: number) {
    if (device.kind === 'knock') return this.knock(device, params, buffers, quality, input, beatSamples)
    if (device.kind === 'sub' || device.kind === 'fm' || device.kind === 'wave') return this.tone(device, params, quality, buffers)
    if (device.kind === 'sampler') return this.sampler(device, params, limit, buffers)
    if (device.kind === 'drum') return this.drum(device, params, buffers, time, beatSamples)
    if (device.kind === 'eq') return this.eq(device, params, input)
    if (device.kind === 'comp') return this.comp(device, params, input)
    if (device.kind === 'delay') return this.delay(device, params, input, beatSamples)
    if (device.kind === 'reverb') return this.reverb(device, params, input, quality)
    if (device.kind === 'chorus') return this.chorus(device, params, input)
    if (device.kind === 'dist') return this.dist(params, input)
    if (device.kind === 'filter') return this.filter(device, params, input)
    if (device.kind === 'mix') return san(input * (params.gain ?? 1))
    if (device.kind === 'split') {
      const sample = san(input * (params.gain ?? 1))
      this.cv[`${device.id}:audio2`] = sample
      return sample
    }
    return input
  }

  private knock(device: RackDevice, params: Record<string, number>, buffers: Map<string, SampleBuffer>, quality: 'full' | 'eco', side: number, beatSamples: number) {
    const zone = device.zones[0]
    const asset = zone ? buffers.get(zone.bufferId) : undefined
    const buffer = asset?.channels[0] ?? null
    const bufferR = asset?.channels[1] ?? null
    let mix = 0
    for (const voice of this.voices) {
      if (!voice.active) continue
      const state = knockVoice(voice)
      if (state.gen !== (voice.knockGen || 0)) {
        knockNoteOn(state, voice.note, voice.vel, !!voice.knockSlide, params, this.sampleRate, beatSamples)
        state.gen = voice.knockGen || 0
      }
      const step = knockStep(
        state,
        params,
        this.sampleRate,
        beatSamples,
        voice.released,
        voice.bend || 0,
        side,
        buffer,
        bufferR,
        asset?.sampleRate || this.sampleRate,
        quality,
      )
      if (step.done) {
        voice.active = false
        continue
      }
      mix += step.mono
      this.knockDelta += step.delta
    }
    return san(mix)
  }

  private tone(device: RackDevice, params: Record<string, number>, quality: 'full' | 'eco', buffers: Map<string, SampleBuffer>) {
    let table: Float32Array[] | null = null
    const zone = device.zones[0]
    const channel = zone ? buffers.get(zone.bufferId)?.channels[0] : undefined
    if (device.kind === 'wave' && zone && channel?.length) {
      const key = `${zone.bufferId}:${channel.length}`
      let built = this.tables.get(key)
      if (!built) {
        built = tableFromAudio(channel)
        this.tables.set(key, built)
      }
      table = built
    }
    return renderTone(device.kind, {
      sr: this.sampleRate,
      time: this.frame,
      quality,
      params,
      voices: this.voices,
      played: (voice) => this.playedNote(voice as Voice),
      table,
      fx: this.fxState(device.id, device.kind),
      publish: (port, value) => {
        this.cv[`${device.id}:${port}`] = value
      },
      deviceId: device.id,
    })
  }

  private sampler(device: RackDevice, params: Record<string, number>, _limit: number, buffers: Map<string, SampleBuffer>) {
    const sr = this.sampleRate
    let mix = 0
    for (const voice of this.voices) {
      if (!voice.active) continue
      const state = this.voiceMem(voice, device.id)
      state.amp = env(state.amp, voice.released, params.attack, params.decay, params.sustain, params.release, sr)
      if (voice.released && state.amp < 0.0008) {
        voice.active = false
        continue
      }
      const played = this.playedNote(voice)
      if (played == null) continue
      const zone = zoneFor(device.zones, played)
      const buffer = zone ? buffers.get(zone.bufferId)?.channels[0] : undefined
      let sample = 0
      if (buffer?.length && zone) {
        const rate = (buffers.get(zone.bufferId)!.sampleRate / sr) * 2 ** ((played - zone.root + (params.tune || 0) + zone.tune) / 12)
        const loop = params.loop >= 0.5
        const start = Math.floor(zone.loopStart * buffer.length)
        const end = Math.max(start + 2, Math.floor(zone.loopEnd * buffer.length))
        let pos = state.pos
        if (loop && pos >= end) pos = start + ((pos - start) % (end - start))
        const index = Math.floor(pos)
        if (index >= 0 && index < buffer.length) {
          const next = buffer[Math.min(buffer.length - 1, index + 1)] || 0
          const frac = pos - index
          sample = (buffer[index] || 0) * (1 - frac) + next * frac
        } else if (!loop) voice.released = true
        state.pos = pos + rate
      } else {
        state.phase += midiHz(played + (params.tune || 0)) / sr
        sample = Math.sin(2 * Math.PI * state.phase) * 0.2
      }
      mix += sample * state.amp * voice.vel
    }
    return san(mix)
  }

  private drum(device: RackDevice, params: Record<string, number>, buffers: Map<string, SampleBuffer>, time: number, beatSamples: number) {
    const step = drumStepIndex(time, beatSamples, device.pattern.length || 16, params.swing || 0)
    const state = this.fxState(device.id, 'drum')
    if (step !== this.drumStep) {
      this.drumStep = step
      const mask = device.pattern[step] || 0
      ;(state as Fx & { mask?: number }).mask = mask
      if (mask) state.phase = 0
    }
    const mask = (state as Fx & { mask?: number }).mask || 0
    let mix = 0
    for (let pad = 0; pad < 16; pad++) {
      if ((mask & (1 << pad)) === 0) continue
      const spec = device.pads[pad]
      const decay = Math.max(0.02, spec?.decay || 0.2)
      const envAmp = Math.exp(-(state.phase / this.sampleRate) / decay)
      const buffer = spec?.bufferId ? buffers.get(spec.bufferId)?.channels[0] : undefined
      if (buffer?.length) {
        const index = Math.floor(state.phase * 2 ** ((spec?.tune || 0) / 12))
        if (index < buffer.length) mix += (buffer[index] || 0) * envAmp
      } else {
        const hz = midiHz(36 + (spec?.tune || pad))
        const tone = Math.sin(2 * Math.PI * hz * (state.phase / this.sampleRate))
        const noise = ((Math.imul(pad + 1 + Math.floor(state.phase), 1103515245) >>> 16) / 32768) - 1
        mix += (tone * 0.6 + noise * 0.4) * envAmp * 0.3
      }
    }
    state.phase += 1
    return san(mix * (params.level ?? 0.8))
  }

  private eq(device: RackDevice, params: Record<string, number>, input: number) {
    const state = this.fxState(device.id, 'eq')
    const low = svf({ phase: 0, phase2: 0, low: state.low, band: state.band, pos: 0, amp: 0, fenv: 0 }, input, 180, 0, this.sampleRate, false)
    state.low = low
    const shelf = input + (params.low || 0) / 18 * low
    const mid = shelf * (1 + (params.mid || 0) / 18)
    void params.midF
    const high = shelf - low
    return san(mid + (params.high || 0) / 18 * high)
  }

  private comp(device: RackDevice, params: Record<string, number>, input: number) {
    const state = this.fxState(device.id, 'comp')
    const attack = Math.max(1, ((params.attack || 10) / 1000) * this.sampleRate)
    const release = Math.max(1, ((params.release || 80) / 1000) * this.sampleRate)
    const det = Math.abs(input)
    state.env += (det - state.env) * (1 / (det > state.env ? attack : release))
    const threshold = 10 ** ((params.threshold || 0) / 20)
    const over = state.env > threshold && threshold > 0 ? state.env / threshold : 1
    const ratio = Math.max(1, params.ratio || 1)
    const gain = over > 1 ? over ** (1 / ratio - 1) : 1
    const makeup = 10 ** ((params.makeup || 0) / 20)
    return san(input * gain * makeup)
  }

  private delay(device: RackDevice, params: Record<string, number>, input: number, beatSamples: number) {
    const state = this.fxState(device.id, 'delay')
    const taps = Math.max(1, Math.round(beatSamples * (params.time || 0.5)))
    const index = state.delayPos % state.delay.length
    const readAt = (state.delayPos - taps + state.delay.length) % state.delay.length
    const wet = state.delay[readAt] || 0
    state.delay[index] = san(input + wet * (params.feedback || 0))
    state.delayPos += 1
    const mix = params.mix ?? 0
    return san(input * (1 - mix) + wet * mix)
  }

  private reverb(device: RackDevice, params: Record<string, number>, input: number, quality: 'full' | 'eco') {
    const state = this.fxState(device.id, 'reverb')
    const count = quality === 'eco' ? 2 : state.combs.length
    let wet = 0
    const feedback = 0.55 + (params.size || 0.5) * 0.35
    for (let i = 0; i < count; i++) {
      const comb = state.combs[i]
      const pos = state.combPos[i] % comb.length
      const delayed = comb[pos] || 0
      comb[pos] = san(input * 0.2 + delayed * feedback)
      state.combPos[i] = pos + 1
      wet += delayed
    }
    wet /= Math.max(1, count)
    const mix = params.mix ?? 0
    return san(input * (1 - mix) + wet * mix)
  }

  private chorus(device: RackDevice, params: Record<string, number>, input: number) {
    const state = this.fxState(device.id, 'chorus')
    state.phase += (params.rate || 0.3) / this.sampleRate
    const depth = 200 + (params.depth || 0.3) * 600
    const taps = Math.floor(400 + (Math.sin(2 * Math.PI * state.phase) * 0.5 + 0.5) * depth)
    const index = state.delayPos % state.delay.length
    state.delay[index] = input
    const readAt = (state.delayPos - taps + state.delay.length) % state.delay.length
    state.delayPos += 1
    const mix = params.mix ?? 0
    return san(input * (1 - mix) + (state.delay[readAt] || 0) * mix)
  }

  private dist(params: Record<string, number>, input: number) {
    const drive = 1 + (params.drive || 0) * 12
    const wet = Math.tanh(input * drive)
    const mix = params.mix ?? 0
    return san(input * (1 - mix) + wet * mix)
  }

  private filter(device: RackDevice, params: Record<string, number>, input: number) {
    const state = this.fxState(device.id, 'filter')
    const holder: Mem = { phase: 0, phase2: 0, low: state.low, band: state.band, pos: 0, amp: 0, fenv: 0 }
    const sample = svf(holder, input, params.cutoff || 4000, params.res || 0, this.sampleRate, (params.mode || 0) >= 0.5)
    state.low = holder.low
    state.band = holder.band
    return sample
  }
}

export function renderNotes(rack: RackState, events: NoteEvent[], sampleRate: number, tempo: number, length: number, buffers = new Map<string, SampleBuffer>(), lanes?: RackAutomation[]) {
  const runtime = new RackRuntime(sampleRate)
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || b.vel - a.vel)
  const left = new Float32Array(length)
  const right = new Float32Array(length)
  let cursor = 0
  let offset = 0
  const block = 128
  while (offset < length) {
    while (cursor < ordered.length && ordered[cursor].sample <= offset) {
      runtime.note(ordered[cursor].pitch, ordered[cursor].vel, rack.polyphony, !!ordered[cursor].slide)
      cursor += 1
    }
    const next = ordered[cursor]?.sample ?? length
    const count = Math.min(block, length - offset, Math.max(1, next - offset))
    const rendered = runtime.render(rack, count, tempo, 'full', buffers, lanes, (offset / sampleRate) * (tempo / 60))
    left.set(rendered[0], offset)
    right.set(rendered[1], offset)
    offset += count
  }
  return [left, right]
}

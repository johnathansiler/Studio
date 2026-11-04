import { descriptor, FACTORY, tuneLatency } from './catalog'
import {
  TUNE_TRACE_FRAMES,
  correctionRate,
  keyFromHist,
  matchRegion,
  throatCoeff,
  trackingGate,
  tuneLiveHop,
  tuneLiveLatency,
  tuneSnapMidi,
  vocalNotes,
  type VocalMidiNote,
} from './autoTune'
import { clamp, sanitize } from './dsp'
import { Psola, type PitchFrame } from '../stretch/voice'
import type { BlockContext, PluginModule, Processor } from './types'

interface SnapState {
  smoothed: number
  center: number
  quiet: number
  lastNote: number
  phase: number
  age: number
}

interface KeyLock {
  root: number
  scale: number
  ready: boolean
  hist: number[]
}

export interface TuneProcessor extends Processor {
  vocalMidi: VocalMidiNote[]
  note(pitch: number, vel: number): void
}

export function createTune(sampleRate: number): TuneProcessor {
  const hq = new Psola(sampleRate, 2)
  const live = new Psola(sampleRate, 2, tuneLiveHop(sampleRate))
  const voices = [0, 1, 2, 3].map(() => ({
    hq: new Psola(sampleRate, 2),
    live: new Psola(sampleRate, 2, tuneLiveHop(sampleRate)),
    state: freshSnap(),
  }))
  const lead = freshSnap()
  const lock: KeyLock = { root: 0, scale: 0, ready: false, hist: new Array(12).fill(0) }
  let midiNote = -1
  let path: 'dry' | 'live' | 'hq' = 'dry'
  let harmonyOn = false
  const throatLow = [0, 0]
  const scratch = [new Float32Array(8192), new Float32Array(8192)]
  const trace = new Float32Array(TUNE_TRACE_FRAMES * 2)
  const sung: VocalMidiNote[] = []
  const remember = (detected: number, corrected: number) => {
    trace.copyWithin(0, 2)
    trace[trace.length - 2] = detected > 0 ? detected : 0
    trace[trace.length - 1] = corrected > 0 ? corrected : 0
  }
  const clearLead = () => {
    lead.smoothed = 0
    lead.center = 0
    lead.quiet = 0
    lead.lastNote = -1
    lead.phase = 0
    lead.age = 0
    lock.ready = false
    lock.hist.fill(0)
    throatLow[0] = 0
    throatLow[1] = 0
  }
  return {
    latencySamples: 0,
    trace,
    vocalMidi: sung,
    note(pitch, vel) {
      midiNote = vel > 0 ? Math.max(0, Math.min(127, Math.round(pitch))) : -1
    },
    reset() {
      hq.reset()
      live.reset()
      for (const voice of voices) {
        voice.hq.reset()
        voice.live.reset()
        copySnap(voice.state, freshSnap())
      }
      clearLead()
      midiNote = -1
      path = 'dry'
      harmonyOn = false
      trace.fill(0)
      sung.length = 0
    },
    process(input, output, params, ctx) {
      if ((params.amount ?? 0) <= 0.001) {
        if (path !== 'dry') {
          hq.reset()
          live.reset()
          for (const voice of voices) {
            voice.hq.reset()
            voice.live.reset()
          }
          clearLead()
          path = 'dry'
        }
        this.latencySamples = 0
        trace.fill(0)
        sung.length = 0
        copyThrough(input, output)
        return
      }
      const monitoring = ctx.offline === false && (params.hq ?? 0) < 0.5
      const nextPath = monitoring ? 'live' : 'hq'
      const engine = monitoring ? live : hq
      if (path !== nextPath) {
        engine.reset()
        for (const voice of voices) (monitoring ? voice.live : voice.hq).reset()
        clearLead()
        for (const voice of voices) copySnap(voice.state, freshSnap())
        path = nextPath
        harmonyOn = false
      }
      this.latencySamples = monitoring ? tuneLiveLatency(ctx.sampleRate) : tuneLatency(ctx.sampleRate)
      const hop = monitoring ? tuneLiveHop(ctx.sampleRate) : ctx.quality === 'eco' ? 256 : 128
      const held = heldNote(params, midiNote)
      const midiOpen = (params.midi ?? 0) >= 0.5 && held < 0
      const useHarmony = !midiOpen && harmonyRequested(params)
      if (useHarmony && !harmonyOn) {
        for (const voice of voices) {
          ;(monitoring ? voice.live : voice.hq).reset()
          copySnap(voice.state, freshSnap())
        }
      }
      harmonyOn = useHarmony
      drive(engine, input, output, params, ctx, lead, 0, true, lock, held, hop, remember)
      if (useHarmony) {
        const frames = Math.min(output[0]?.length ?? 0, scratch[0].length)
        const gain = clamp(params.harmony ?? 0, 0, 1) * 0.32
        for (let v = 0; v < 4; v++) {
          const interval = Math.round(params[`h${v + 1}`] ?? 0)
          if (!interval || frames <= 0) continue
          const voice = voices[v]
          const bus = monitoring ? voice.live : voice.hq
          const piece = [input[0]?.subarray(0, frames) ?? scratch[0].subarray(0, 0), input[Math.min(1, input.length - 1)]?.subarray(0, frames) ?? input[0]?.subarray(0, frames) ?? scratch[0].subarray(0, 0)]
          const dest = [scratch[0].subarray(0, frames), scratch[1].subarray(0, frames)]
          drive(bus, piece, dest, params, ctx, voice.state, interval, false, lock, held, hop, null)
          const leftGain = gain * (v % 2 === 0 ? 0.7 : 0.3)
          const rightGain = gain * (v % 2 === 0 ? 0.3 : 0.7)
          for (let i = 0; i < frames; i++) {
            if (output[0]) output[0][i] = sanitize((output[0][i] ?? 0) + scratch[0][i] * leftGain)
            if (output[1]) output[1][i] = sanitize((output[1][i] ?? 0) + scratch[1][i] * rightGain)
          }
        }
      }
      applyThroat(output, params.throat ?? 0, ctx.sampleRate, throatLow)
      if ((params.vocal ?? 0) >= 0.5) {
        const found = vocalNotes(trace, params.a4 || 440)
        sung.length = 0
        for (const note of found) sung.push(note)
      } else if (sung.length) sung.length = 0
    },
  }
}

function freshSnap(): SnapState {
  return { smoothed: 0, center: 0, quiet: 0, lastNote: -1, phase: 0, age: 0 }
}

function copySnap(into: SnapState, from: SnapState) {
  into.smoothed = from.smoothed
  into.center = from.center
  into.quiet = from.quiet
  into.lastNote = from.lastNote
  into.phase = from.phase
  into.age = from.age
}

function heldNote(params: Record<string, number>, midiNote: number) {
  const paramHeld = Math.round(params.holdMidi ?? -1)
  if (paramHeld >= 0 && paramHeld <= 127) return paramHeld
  return midiNote >= 0 && midiNote <= 127 ? midiNote : -1
}

function harmonyRequested(params: Record<string, number>) {
  if ((params.harmony ?? 0) <= 0.001) return false
  for (let i = 1; i <= 4; i++) if (Math.round(params[`h${i}`] ?? 0) !== 0) return true
  return false
}

function drive(
  engine: Psola,
  input: Float32Array[],
  output: Float32Array[],
  params: Record<string, number>,
  ctx: BlockContext,
  state: SnapState,
  extra: number,
  updateKey: boolean,
  lock: KeyLock,
  held: number,
  hop: number,
  remember: ((detected: number, corrected: number) => void) | null,
) {
  engine.process(
    input,
    output,
    (frame) => {
      const corrected = targetHz(frame, params, ctx, state, extra, updateKey, lock, held, hop)
      if (corrected <= 0) {
        state.quiet += 1
        if (state.quiet > 4) {
          state.smoothed = 0
          state.center = 0
          state.lastNote = -1
          state.age = 0
        }
      } else state.quiet = 0
      if (remember) remember(frame.hz, corrected)
      return corrected
    },
    ctx.sampleRate,
    params.minHz || 80,
    params.maxHz || 900,
    hop,
    params.formant ?? 0,
  )
}

function targetHz(
  frame: PitchFrame,
  params: Record<string, number>,
  ctx: BlockContext,
  state: SnapState,
  extra: number,
  updateKey: boolean,
  lock: KeyLock,
  held: number,
  hop: number,
) {
  if (frame.hz <= 0 || frame.confidence < trackingGate(params.tracking ?? 0.5)) return 0
  const ref = clamp(params.a4 ?? 440, 430, 450)
  const midi = 69 + 12 * Math.log2(frame.hz / ref) + (params.transpose || 0) + extra
  const heardPc = ((Math.round(midi) % 12) + 12) % 12
  if ((Math.round(params.bypassMask || 0) & (1 << heardPc)) !== 0) return 0
  const midiOn = (params.midi ?? 0) >= 0.5
  if (midiOn && (held < 0 || held > 127)) return 0
  if (updateKey && (params.autoKey ?? 0) >= 0.5) {
    for (let i = 0; i < 12; i++) lock.hist[i] *= 0.998
    lock.hist[heardPc] += 1
    const guess = keyFromHist(lock.hist)
    if (guess) {
      lock.root = guess.root
      lock.scale = guess.scaleIndex
      lock.ready = true
    }
  }
  const follow = lock.ready && (params.autoKey ?? 0) >= 0.5
  const snapParams = follow ? { ...params, root: lock.root, scaleIndex: lock.scale, mode: 1, custom: 0, mask: 0 } : params
  const snapped = held >= 0 && held <= 127 ? held + extra : tuneSnapMidi(midi, snapParams, ctx)
  const region = matchRegion(params, snapped)
  const nudgePc = ((Math.round(snapped) % 12) + 12) % 12
  const classNudge = clamp(params[`n${nudgePc}`] ?? 0, -200, 200) / 100
  const nudge = region ? clamp(region.ct, -200, 200) / 100 : classNudge
  const goal = ref * 2 ** ((snapped + nudge - 69) / 12)
  const slow = state.center || frame.hz
  state.center = slow + (frame.hz - slow) * 0.08
  const human = clamp(params.humanize ?? 0, 0, 1)
  const amount = region ? clamp(region.amt, 0, 1) : clamp(params.amount ?? 0, 0, 1)
  const classic = (params.color ?? 0) >= 0.5
  const flex = classic ? 0 : clamp(params.flex ?? 0, 0, 1)
  const centsOff = 1200 * Math.log2(frame.hz / goal)
  const window = flex * 40
  const pull = Math.sign(centsOff) * Math.max(0, Math.abs(centsOff) - window)
  const flexed = frame.hz * 2 ** (-pull / 1200)
  const kept = flexed + human * (frame.hz - flexed)
  let aimed = frame.hz + amount * (kept - frame.hz)
  const vibe = clamp(params.vibrato ?? 0, 0, 1)
  if (vibe > 0) aimed += vibe * (frame.hz - slow)
  const note = Math.round(snapped)
  const changed = state.lastNote >= 0 && note !== state.lastNote
  state.lastNote = note
  const depth = clamp(params.vibeDepth ?? 0, 0, 100)
  if (depth > 0) {
    const rateHz = clamp(params.vibeRate ?? 5, 0.2, 8)
    state.phase += 2 * Math.PI * rateHz * (hop / ctx.sampleRate)
    if (state.phase > Math.PI * 2) state.phase -= Math.PI * 2
    if (changed) state.age = 0
    else state.age += hop
    const onset = clamp(params.vibeOnset ?? 0, 0, 1) * ctx.sampleRate * 0.5
    if (state.age >= onset) aimed *= 2 ** ((Math.sin(state.phase) * depth) / 1200)
  }
  const speed = clamp(params.retune ?? 0.5, 0.02, 1)
  const rate = correctionRate(speed, classic, params.transition ?? 1, changed)
  const prev = state.smoothed || frame.hz
  const next = prev + (aimed - prev) * rate
  state.smoothed = next
  return clamp(next, 40, 2000)
}

function applyThroat(output: Float32Array[], throat: number, sampleRate: number, low: number[]) {
  const tilt = clamp(throat, -1, 1)
  if (Math.abs(tilt) < 1e-6) return
  const coeff = throatCoeff(sampleRate)
  const mix = tilt * 0.85
  const frames = output[0]?.length ?? 0
  for (let c = 0; c < output.length && c < 2; c++) {
    const channel = output[c]
    if (!channel) continue
    for (let i = 0; i < frames; i++) {
      const sample = channel[i] ?? 0
      low[c] += coeff * (sample - low[c])
      channel[i] = sanitize(sample + mix * (sample - low[c]))
    }
  }
}

const plugin: PluginModule = { descriptor: descriptor('tune')!, presets: FACTORY.tune, create: createTune }
export default plugin

function copyThrough(input: Float32Array[], output: Float32Array[]) {
  const n = input[0]?.length ?? 0
  for (let c = 0; c < output.length; c++) {
    const src = input[Math.min(c, input.length - 1)]
    for (let i = 0; i < n; i++) output[c][i] = sanitize(src?.[i] ?? 0)
  }
}

import { smoothParam } from './paramCurve'

export interface StripNodes {
  input: GainNode
  eqLow: BiquadFilterNode
  eqMid: BiquadFilterNode
  eqHigh: BiquadFilterNode
  comp: DynamicsCompressorNode
  delay: DelayNode
  delayFb: GainNode
  delayWet: GainNode
  delaySend: GainNode
  convolver: ConvolverNode
  revWet: GainNode
  revSend: GainNode
  pan: StereoPannerNode
  fader: GainNode
  mute: GainNode
  analyser: AnalyserNode
  output: GainNode
  irDecay: number
  /** True while the dynamics node is in the signal path. A disabled compressor stays out of the chain. */
  compLive: boolean
}

export function createStrip(ctx: BaseAudioContext): StripNodes {
  const input = ctx.createGain()
  const eqLow = ctx.createBiquadFilter()
  eqLow.type = 'lowshelf'
  eqLow.frequency.value = 140
  const eqMid = ctx.createBiquadFilter()
  eqMid.type = 'peaking'
  eqMid.frequency.value = 1000
  eqMid.Q.value = 0.85
  const eqHigh = ctx.createBiquadFilter()
  eqHigh.type = 'highshelf'
  eqHigh.frequency.value = 6500
  const comp = ctx.createDynamicsCompressor()
  const delay = ctx.createDelay(1.5)
  const delayFb = ctx.createGain()
  const delayWet = ctx.createGain()
  const delaySend = ctx.createGain()
  const convolver = ctx.createConvolver()
  const revWet = ctx.createGain()
  const revSend = ctx.createGain()
  const pan = ctx.createStereoPanner()
  const fader = ctx.createGain()
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.35
  const mute = ctx.createGain()
  const post = ctx.createGain()
  post.gain.value = 1

  input.connect(eqLow)
  eqLow.connect(eqMid)
  eqMid.connect(eqHigh)
  eqHigh.connect(pan)
  eqHigh.connect(delaySend)
  eqHigh.connect(revSend)
  comp.connect(pan)
  comp.connect(delaySend)
  delaySend.connect(delay)
  delay.connect(delayFb)
  delayFb.connect(delay)
  delay.connect(delayWet)
  delayWet.connect(pan)
  comp.connect(revSend)
  revSend.connect(convolver)
  convolver.connect(revWet)
  revWet.connect(pan)
  // Post-fader and post-mute, so the mixer strip and the arrange header read the same signal and a muted track stays silent.
  pan.connect(fader)
  fader.connect(mute)
  mute.connect(analyser)
  analyser.connect(post)

  delayWet.gain.value = 0
  delaySend.gain.value = 0
  revWet.gain.value = 0
  revSend.gain.value = 0

  return {
    input,
    eqLow,
    eqMid,
    eqHigh,
    comp,
    delay,
    delayFb,
    delayWet,
    delaySend,
    convolver,
    revWet,
    revSend,
    pan,
    fader,
    mute,
    analyser,
    output: post,
    irDecay: 0,
    compLive: false,
  }
}

/** Drop every connection so a removed track can leave the graph while playback continues. */
export function releaseStrip(strip: StripNodes) {
  const nodes: AudioNode[] = [
    strip.input, strip.eqLow, strip.eqMid, strip.eqHigh, strip.comp,
    strip.delay, strip.delayFb, strip.delayWet, strip.delaySend,
    strip.convolver, strip.revWet, strip.revSend,
    strip.pan, strip.fader, strip.mute, strip.analyser, strip.output,
  ]
  for (const node of nodes) {
    try { node.disconnect() } catch { /* already disconnected */ }
  }
}

export function applyInserts(
  ctx: BaseAudioContext,
  strip: StripNodes,
  inserts: { type: string; enabled: boolean; params: Record<string, number> }[],
) {
  const now = ctx.currentTime || 0
  const eq = inserts.find((i) => i.type === 'eq' && i.enabled)
  smoothParam(strip.eqLow.gain, eq ? eq.params.low || 0 : 0, now)
  smoothParam(strip.eqMid.gain, eq ? eq.params.mid || 0 : 0, now)
  smoothParam(strip.eqMid.frequency, eq ? clamp(eq.params.midFreq || 1000, 200, 8000) : 1000, now)
  smoothParam(strip.eqHigh.gain, eq ? eq.params.high || 0 : 0, now)

  const comp = inserts.find((i) => i.type === 'compressor' && i.enabled)
  const wantComp = Boolean(comp)
  if (wantComp !== strip.compLive) {
    try { strip.eqHigh.disconnect() } catch { /* the shelf is being rewired */ }
    if (wantComp) strip.eqHigh.connect(strip.comp)
    else {
      strip.eqHigh.connect(strip.pan)
      strip.eqHigh.connect(strip.delaySend)
      strip.eqHigh.connect(strip.revSend)
    }
    strip.compLive = wantComp
  }
  if (comp) {
    smoothParam(strip.comp.threshold, comp.params.threshold ?? -18, now)
    smoothParam(strip.comp.knee, comp.params.knee ?? 8, now)
    smoothParam(strip.comp.ratio, comp.params.ratio ?? 3, now)
    smoothParam(strip.comp.attack, comp.params.attack ?? 0.003, now)
    smoothParam(strip.comp.release, comp.params.release ?? 0.12, now)
  } else {
    smoothParam(strip.comp.threshold, 0, now)
    smoothParam(strip.comp.knee, 0, now)
    smoothParam(strip.comp.ratio, 1, now)
    smoothParam(strip.comp.attack, 0.003, now)
    smoothParam(strip.comp.release, 0.25, now)
  }

  const delay = inserts.find((i) => i.type === 'delay' && i.enabled)
  if (delay) {
    smoothParam(strip.delay.delayTime, clamp(delay.params.time ?? 0.22, 0, 1.2), now)
    smoothParam(strip.delayFb.gain, clamp(delay.params.feedback ?? 0.3, 0, 0.85), now)
    const mix = clamp(delay.params.mix ?? 0.2, 0, 1)
    smoothParam(strip.delaySend.gain, mix, now)
    smoothParam(strip.delayWet.gain, 1, now)
  } else {
    smoothParam(strip.delayFb.gain, 0, now)
    smoothParam(strip.delaySend.gain, 0, now)
    smoothParam(strip.delayWet.gain, 0, now)
  }

  const reverb = inserts.find((i) => i.type === 'reverb' && i.enabled)
  if (reverb) {
    const decay = clamp(reverb.params.decay ?? 1.5, 0.2, 6)
    const rounded = Math.round(decay * 10) / 10
    if (Math.abs(strip.irDecay - rounded) > 0.05 || !strip.convolver.buffer) {
      strip.convolver.buffer = makeImpulse(ctx, rounded)
      strip.irDecay = rounded
    }
    const mix = clamp(reverb.params.mix ?? 0.18, 0, 1)
    smoothParam(strip.revSend.gain, mix, now)
    smoothParam(strip.revWet.gain, 1, now)
  } else {
    smoothParam(strip.revSend.gain, 0, now)
    smoothParam(strip.revWet.gain, 0, now)
  }
}

export function makeImpulse(ctx: BaseAudioContext, decay: number): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * decay))
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2.5
    }
  }
  return buffer
}

/**
 * How much of the recent signal a meter keeps.
 * A display frame is about 16 ms. Mute checks read `levels()` at 40 ms and
 * 60 ms and keep the maximum, so the window stays under 30 ms and a short
 * release finishes the fall before those reads.
 */
const METER_WINDOW_SEC = 0.03
/** Time constant after the window drops. Full scale is under 0.01 by 60 ms. */
export const METER_RELEASE_SEC = 0.006

/** Largest power of two that still fits in the meter window. */
export function meterFftSize(sampleRate: number) {
  const cap = Math.floor(Math.max(8000, sampleRate) * METER_WINDOW_SEC)
  let size = 32
  while ((size << 1) <= cap && size < 4096) size <<= 1
  return size
}

/** Size a level meter so one frame cannot skip a short transient. */
export function prepareMeter(analyser: AnalyserNode, sampleRate: number) {
  analyser.fftSize = meterFftSize(sampleRate)
}

/**
 * One exact-length view per scratch buffer.
 * `getFloatTimeDomainData` requires that length, and a fresh subarray each frame would churn the collector.
 */
const domainViews = new WeakMap<Float32Array, Map<number, Float32Array>>()

function domainData(scratch: Float32Array, length: number) {
  if (length >= scratch.length) return scratch
  let sizes = domainViews.get(scratch)
  if (!sizes) {
    sizes = new Map()
    domainViews.set(scratch, sizes)
  }
  let view = sizes.get(length)
  if (!view) {
    view = scratch.subarray(0, length)
    sizes.set(length, view)
  }
  return view
}

function readDomain(analyser: AnalyserNode, scratch: Float32Array) {
  const length = Math.min(scratch.length, analyser.fftSize || scratch.length)
  const data = domainData(scratch, length) as unknown as Float32Array<ArrayBuffer>
  analyser.getFloatTimeDomainData(data)
  return length
}

/** Loudest sample currently in the analyser window. */
export function analyserPeak(analyser: AnalyserNode, scratch: Float32Array) {
  const length = readDomain(analyser, scratch)
  let peak = 0
  for (let i = 0; i < length; i++) {
    const value = Math.abs(scratch[i] || 0)
    if (value > peak) peak = value
  }
  return peak
}

/** Peak hold with an exponential release. A new peak replaces the hold immediately. */
export function releasePeak(held: number, instant: number, dt: number) {
  const decayed = (held > 0 ? held : 0) * Math.exp(-Math.max(0, dt) / METER_RELEASE_SEC)
  return Math.max(instant > 0 ? instant : 0, decayed)
}

export function analyserRms(analyser: AnalyserNode, scratch: Float32Array): number {
  const length = readDomain(analyser, scratch)
  let sum = 0
  for (let i = 0; i < length; i++) sum += scratch[i] * scratch[i]
  return Math.sqrt(sum / Math.max(1, length))
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

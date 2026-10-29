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

  input.connect(eqLow)
  eqLow.connect(eqMid)
  eqMid.connect(eqHigh)
  eqHigh.connect(comp)
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
  pan.connect(fader)
  fader.connect(analyser)
  analyser.connect(mute)

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
    output: mute,
    irDecay: 0,
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

export function analyserRms(analyser: AnalyserNode, scratch: Float32Array): number {
  const data = scratch as unknown as Float32Array<ArrayBuffer>
  analyser.getFloatTimeDomainData(data)
  let sum = 0
  for (let i = 0; i < scratch.length; i++) sum += scratch[i] * scratch[i]
  return Math.sqrt(sum / scratch.length)
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

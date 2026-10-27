import { applyMacros, DEVICE_PARAMS, type DeviceKind, type ParamSpec } from '../../model/rack'

export interface SynthState {
  phase: number[]
  env: number[]
  glide: number
  started: number
  low: number
  band: number
  low2: number
  band2: number
  pole: number[]
  n: number
  prev: number
  extra: number[]
  buf: Float32Array | null
}

export interface PlayVoice {
  note: number
  vel: number
  bend: number
  pressure: number
  glideFrom: number
  released: boolean
  active: boolean
  synth: Record<string, SynthState>
}

export interface FxBus {
  phase: number
  delay: Float32Array
  delayPos: number
  combs: Float32Array[]
  combPos: number[]
  low: number
  band: number
}

export interface ToneCtx {
  sr: number
  time: number
  quality: 'full' | 'eco'
  params: Record<string, number>
  voices: PlayVoice[]
  played: (voice: PlayVoice) => number | null
  table: Float32Array[] | null
  fx: FxBus
  publish: (port: string, value: number) => void
  deviceId: string
}

export function freshState(): SynthState {
  return {
    phase: Array(16).fill(0),
    env: [0, 0, 0],
    glide: 0,
    started: 0,
    low: 0,
    band: 0,
    low2: 0,
    band2: 0,
    pole: [0, 0, 0, 0],
    n: 1,
    prev: 0,
    extra: Array(8).fill(0),
    buf: null,
  }
}

export function tableFromAudio(channel: Float32Array): Float32Array[] {
  const frame = 256
  const count = 4
  const span = Math.max(frame, Math.floor(channel.length / count))
  const frames: Float32Array[] = []
  for (let i = 0; i < count; i++) {
    const out = new Float32Array(frame)
    const start = Math.max(0, Math.min(channel.length - 2, i * span))
    for (let j = 0; j < frame; j++) {
      const pos = start + (j / frame) * Math.min(frame, Math.max(1, channel.length - start - 1))
      const index = Math.floor(pos)
      const frac = pos - index
      const a = channel[index] || 0
      const b = channel[Math.min(channel.length - 1, index + 1)] || 0
      out[j] = a * (1 - frac) + b * frac
    }
    frames.push(out)
  }
  return frames
}

export function renderTone(kind: DeviceKind, ctx: ToneCtx) {
  const params = applyMacros(ctx.params, DEVICE_PARAMS[kind])
  const shaped = { ...ctx, params }
  if (kind === 'fm') return finish(shaped, fm(shaped))
  if (kind === 'wave') return finish(shaped, wavetable(shaped))
  return finish(shaped, analog(shaped))
}

function finish(ctx: ToneCtx, sample: number) {
  return san(fx(ctx, sample))
}

function analog(ctx: ToneCtx) {
  const p = ctx.params
  const sr = ctx.sr
  const lfo1 = Math.sin(2 * Math.PI * (p.lfo1 || 0.4) * (ctx.time / sr))
  const lfo2 = Math.sin(2 * Math.PI * (p.lfo2 || 2) * (ctx.time / sr))
  ctx.publish('lfo1', lfo1)
  ctx.publish('lfo2', lfo2)
  let mix = 0
  let shown = 0
  const uni = Math.max(1, Math.min(ctx.quality === 'eco' ? 1 : 4, Math.round(p.uni || 1)))
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = voiceState(voice, ctx.deviceId)
    state.env[0] = envelope(state.env[0], voice.released, p.attack, p.decay, p.sustain, p.release, sr)
    state.env[1] = envelope(state.env[1], voice.released, p.fattack, p.fdecay, p.fsustain, p.frelease, sr)
    state.env[2] = envelope(state.env[2], voice.released, p.mattack, p.mdecay, p.msustain, p.mrelease, sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const pitch = glideTo(state, voice, played, p.glide || 0, sr)
    let cutoff = (p.cutoff || 1400) + (p.famt || 0) * 4000 * state.env[1]
    let amp = state.env[0]
    const sources = [lfo1, lfo2, state.env[1], voice.vel, voice.pressure || 0, state.env[2]]
    for (const slot of [1, 2, 3, 4]) {
      const amount = p[`mod${slot}amt`] || 0
      if (!amount) continue
      const src = sources[clampInt(p[`mod${slot}src`] || 0, 0, sources.length - 1)] || 0
      const dst = clampInt(p[`mod${slot}dst`] || 0, 0, 3)
      if (dst === 0) cutoff += amount * 3000 * src
      else if (dst === 1) pitch.midi += amount * 2 * src
      else if (dst === 2) amp *= clamp(1 + amount * src, 0, 1.5)
      else state.extra[0] = clamp(0.5 + amount * 0.4 * src, 0.05, 0.95)
    }
    const hz = midiHz(pitch.midi + (voice.bend || 0))
    const pw = state.extra[0] || p.pw || 0.5
    const noise = hashNoise(state.n++)
    let osc1 = 0
    let wrapped = false
    for (let u = 0; u < uni; u++) {
      const cents = uni === 1 ? 0 : (u - (uni - 1) / 2) * (p.uniDet || 10)
      const index = 4 + u
      const step = advance(state, index, hz * 2 ** (cents / 1200), sr)
      if (u === 0) wrapped = step.wrapped
      osc1 += shape(p.wave1 || 0, step.phase, pw, noise)
    }
    osc1 /= uni
    const second = advance(state, 1, hz * 2 ** ((p.detune || 0) / 1200), sr)
    if ((p.sync || 0) >= 0.5 && wrapped) state.phase[1] = state.phase[4] || 0
    const osc2 = shape(p.wave2 ?? 1, (p.sync || 0) >= 0.5 && wrapped ? state.phase[1] : second.phase, pw, noise)
    const third = advance(state, 2, hz * 0.5, sr)
    const osc3 = shape(p.wave3 ?? 3, third.phase, pw, noise)
    let tone = osc1 * (p.mix1 ?? 0.7) + osc2 * (p.mix2 ?? 0) + osc3 * (p.mix3 ?? 0)
    if ((p.ring || 0) >= 0.5) tone = osc1 * osc2
    if ((p.drive || 0) > 0.001) tone = Math.tanh(tone * (1 + p.drive * 6))
    const open = cutoff >= 12000 && (p.res || 0) < 0.05 && Math.abs(p.famt || 0) < 0.01
    const filtered = open ? tone : filter(state, tone, cutoff, p.res || 0, p.fmode || 0, p.slope || 0, p.ftype || 0, sr, ctx.quality)
    mix += filtered * 0.22 * amp * voice.vel
    shown = state.env[0]
  }
  ctx.publish('env', shown)
  return mix
}

function wavetable(ctx: ToneCtx) {
  const p = ctx.params
  const sr = ctx.sr
  const tables = ctx.table ?? builtinTable(clampInt(p.table || 0, 0, BUILTIN.length - 1))
  let mix = 0
  const uni = Math.max(1, Math.min(ctx.quality === 'eco' ? 1 : 4, Math.round(p.uni || 1)))
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = voiceState(voice, ctx.deviceId)
    state.env[0] = envelope(state.env[0], voice.released, p.attack, p.decay, p.sustain, p.release, sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const pitch = glideTo(state, voice, played, p.glide || 0, sr)
    const hz = midiHz(pitch.midi + (voice.bend || 0))
    let osc = 0
    for (let u = 0; u < uni; u++) {
      const cents = uni === 1 ? 0 : (u - (uni - 1) / 2) * (p.uniDet || 8)
      const step = advance(state, u, hz * 2 ** (cents / 1200), sr)
      let phase = step.phase
      const warp = clampInt(p.warp || 0, 0, 3)
      const amt = p.warpAmt || 0
      if (warp === 1) phase = wrap(phase + amt * Math.sin(2 * Math.PI * phase) * 0.2)
      if (warp === 3) {
        const pw = clamp(p.pw || 0.5, 0.05, 0.95)
        phase = phase < pw ? (phase / pw) * 0.5 : 0.5 + ((phase - pw) / (1 - pw)) * 0.5
      }
      let sample = morph(tables, p.position || 0, phase)
      if (warp === 2) sample = fold(sample * (1 + amt * 3))
      osc += sample
    }
    osc /= uni
    const cutoff = p.cutoff || 8000
    const open = cutoff >= 12000 && (p.res || 0) < 0.05
    const tone = open ? osc : filter(state, osc, cutoff, p.res || 0, p.fmode || 0, 0, 0, sr, ctx.quality)
    mix += tone * 0.22 * state.env[0] * voice.vel
  }
  return mix
}

function fm(ctx: ToneCtx) {
  const p = ctx.params
  const sr = ctx.sr
  const algo = clampInt(p.algo || 0, 0, 5)
  const ops = ctx.quality === 'eco' ? 3 : 6
  let mix = 0
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = voiceState(voice, ctx.deviceId)
    state.env[0] = envelope(state.env[0], voice.released, p.attack, p.decay, p.sustain, p.release, sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const pitch = glideTo(state, voice, played, p.glide || 0, sr)
    const hz = midiHz(pitch.midi + (voice.bend || 0))
    const fixed = (p.fixed || 0) >= 0.5
    const ratios = [1, p.ratio || 1, p.op3 || 1, p.op4 || 1, p.op5 || 1, p.op6 || 2]
    const levels = [1, p.index || 0, p.lv3 || 0, p.lv4 || 0, p.lv5 || 0, p.lv6 || 0]
    const outs: number[] = []
    for (let i = Math.min(ops, 6) - 1; i >= 0; i--) {
      const freq = fixed && i > 0 ? Math.max(20, ratios[i] * 100) : hz * Math.max(0.25, ratios[i])
      const step = advance(state, i, freq, sr)
      let mod = 0
      if (algo === 0 && i === 0) mod = (outs[1] || 0) * levels[1]
      else if (algo === 1 && i === 0) mod = (outs[1] || 0) * levels[1] + (outs[2] || 0) * levels[2]
      else if (algo === 2 && i === 1) mod = (outs[2] || 0) * levels[2]
      else if (algo === 2 && i === 0) mod = (outs[1] || 0) * levels[1]
      else if (algo === 3 && i < 3) mod = (outs[i + 1] || 0) * levels[i + 1]
      else if (algo === 4 && (i === 0 || i === 2)) mod = (outs[i + 1] || 0) * levels[i + 1]
      if (i === 0 && (p.feedback || 0) > 0) mod += state.prev * (p.feedback || 0) * 2
      const sample = Math.sin(2 * Math.PI * step.phase + mod)
      outs[i] = sample
      if (i === 0) state.prev = sample
    }
    let tone = outs[0] || 0
    if (algo === 4) tone = tone * 0.7 + (outs[2] || 0) * 0.5
    if (algo === 5) {
      tone = 0
      for (let i = 0; i < Math.min(ops, 4); i++) tone += (outs[i] || 0) * (i === 0 ? 1 : levels[i])
    }
    mix += tone * 0.2 * state.env[0] * voice.vel
  }
  return mix
}

function fx(ctx: ToneCtx, input: number) {
  const p = ctx.params
  let sample = input
  const drive = p.fxDrv || 0
  if (drive > 0.001) {
    const wet = Math.tanh(sample * (1 + drive * 8))
    sample = sample * (1 - drive) + wet * drive
  }
  const chorus = p.fxChor || 0
  if (chorus > 0.001) sample = mixDelay(ctx, sample, chorus, 0.003, true)
  const delay = p.fxDel || 0
  if (delay > 0.001) sample = mixDelay(ctx, sample, delay, 0, false)
  const reverb = p.fxRev || 0
  if (reverb > 0.001) sample = mixReverb(ctx, sample, reverb)
  return sample
}

function mixDelay(ctx: ToneCtx, input: number, mix: number, rate: number, chorus: boolean) {
  const state = ctx.fx
  const sr = ctx.sr
  if (chorus) state.phase += (0.15 + rate * 40) / sr
  const depth = chorus ? 180 + mix * 500 : 0
  const taps = chorus
    ? Math.floor(280 + (Math.sin(2 * Math.PI * state.phase) * 0.5 + 0.5) * depth)
    : Math.max(1, Math.round(sr * 0.18))
  const index = state.delayPos % state.delay.length
  const readAt = (state.delayPos - taps + state.delay.length * 4) % state.delay.length
  const wet = state.delay[readAt] || 0
  state.delay[index] = san(input + (chorus ? 0 : wet * 0.35))
  state.delayPos += 1
  return san(input * (1 - mix) + wet * mix)
}

function mixReverb(ctx: ToneCtx, input: number, mix: number) {
  const state = ctx.fx
  if (!state.combs.length) {
    const count = ctx.quality === 'eco' ? 2 : 4
    state.combs = Array.from({ length: count }, (_, index) => new Float32Array(700 + index * 211))
    state.combPos = state.combs.map(() => 0)
  }
  const count = ctx.quality === 'eco' ? Math.min(2, state.combs.length) : state.combs.length
  let wet = 0
  for (let i = 0; i < count; i++) {
    const comb = state.combs[i]
    const pos = state.combPos[i] % comb.length
    const delayed = comb[pos] || 0
    comb[pos] = san(input * 0.25 + delayed * 0.72)
    state.combPos[i] = pos + 1
    wet += delayed
  }
  wet /= Math.max(1, count)
  return san(input * (1 - mix) + wet * mix)
}

function filter(state: SynthState, input: number, cutoff: number, res: number, mode: number, slope: number, kind: number, sr: number, quality: 'full' | 'eco') {
  const choice = clampInt(mode, 0, 3)
  if (kind >= 0.5 && quality === 'full') return ladder(state, input, cutoff, res, choice, sr)
  const first = svf(state, input, cutoff, res, sr, false)
  const dry = tap(first, choice)
  if (slope < 0.5) return san(dry)
  return san(tap(svf(state, dry, cutoff, res, sr, true), choice))
}

function tap(frame: { low: number; band: number; high: number }, mode: number) {
  if (mode === 1) return frame.high
  if (mode === 2) return frame.band
  if (mode === 3) return san(frame.low + frame.high)
  return frame.low
}

function svf(state: SynthState, input: number, cutoff: number, res: number, sr: number, second: boolean) {
  const f = 2 * Math.sin(Math.min(Math.PI * 0.45, (Math.PI * clamp(cutoff, 20, sr * 0.45)) / sr))
  const q = clamp(1 - clamp(res, 0, 0.95) * 0.92, 0.08, 1)
  const lowKey = second ? 'low2' : 'low'
  const bandKey = second ? 'band2' : 'band'
  const low = san(state[lowKey] + f * state[bandKey])
  const high = san(input - low - q * state[bandKey])
  const band = san(state[bandKey] + f * high)
  state[lowKey] = low
  state[bandKey] = band
  return { low, band, high }
}

function ladder(state: SynthState, input: number, cutoff: number, res: number, mode: number, sr: number) {
  const f = 1 - Math.exp((-2 * Math.PI * clamp(cutoff, 20, sr * 0.45)) / sr)
  const fb = clamp(res, 0, 0.95) * 3.6 * (state.pole[3] || 0)
  let y = san(Math.tanh(input) - fb)
  for (let i = 0; i < 4; i++) {
    state.pole[i] = san((state.pole[i] || 0) + f * (y - (state.pole[i] || 0)))
    y = state.pole[i]
  }
  if (mode === 1) return san(input - y)
  if (mode === 2) return san((state.pole[1] || 0) - y)
  if (mode === 3) return san(input - ((state.pole[1] || 0) - y))
  return y
}

function glideTo(state: SynthState, voice: PlayVoice, played: number, glideMs: number, sr: number) {
  if (!state.started) {
    state.glide = glideMs > 0.5 ? voice.glideFrom || played : played
    state.started = 1
  }
  if (glideMs > 0.5) {
    const step = Math.max(1, (glideMs / 1000) * sr)
    state.glide += (played - state.glide) / step
  } else state.glide = played
  return { midi: state.glide }
}

function advance(state: SynthState, index: number, hz: number, sr: number) {
  const phase = (state.phase[index] || 0) + hz / sr
  const wrapped = phase >= 1
  state.phase[index] = wrapped ? phase - Math.floor(phase) : phase
  return { phase: state.phase[index], wrapped }
}

function shape(kind: number, phase: number, pw: number, noise: number) {
  const p = phase - Math.floor(phase)
  const wave = clampInt(kind, 0, 5)
  if (wave === 1) return p < 0.5 ? 1 : -1
  if (wave === 2) return p < clamp(pw, 0.05, 0.95) ? 1 : -1
  if (wave === 3) return p < 0.5 ? 4 * p - 1 : 3 - 4 * p
  if (wave === 4) return Math.sin(2 * Math.PI * p)
  if (wave === 5) return noise
  return 2 * p - 1
}

function morph(frames: Float32Array[], position: number, phase: number) {
  if (!frames.length) return 0
  const pos = clamp(position, 0, 0.999) * (frames.length - 1)
  const index = Math.floor(pos)
  const frac = pos - index
  const a = readFrame(frames[index], phase)
  const b = readFrame(frames[Math.min(frames.length - 1, index + 1)], phase)
  return a * (1 - frac) + b * frac
}

function readFrame(frame: Float32Array, phase: number) {
  const p = phase - Math.floor(phase)
  const pos = p * frame.length
  const index = Math.floor(pos) % frame.length
  const frac = pos - Math.floor(pos)
  const a = frame[index] || 0
  const b = frame[(index + 1) % frame.length] || 0
  return a * (1 - frac) + b * frac
}

function voiceState(voice: PlayVoice, id: string) {
  return (voice.synth[id] ??= freshState())
}

export function envelope(value: number, released: boolean, attackMs = 8, decayMs = 200, sustain = 0.7, releaseMs = 200, sr = 48000) {
  if (!released) {
    const attack = Math.max(1, (attackMs / 1000) * sr)
    if (value < 0.999) return Math.min(1, value + 1 / attack)
    const decay = Math.max(1, (decayMs / 1000) * sr)
    return value + (sustain - value) * (1 - Math.exp(-1 / decay))
  }
  const release = Math.max(1, (releaseMs / 1000) * sr)
  return value * Math.exp(-1 / release)
}

function fold(sample: number) {
  let x = sample
  for (let i = 0; i < 3; i++) {
    if (x > 1) x = 2 - x
    else if (x < -1) x = -2 - x
    else break
  }
  return san(x)
}

function wrap(phase: number) {
  return phase - Math.floor(phase)
}

export function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
}

function hashNoise(n: number) {
  let x = Math.imul(n | 0, 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = (x ^ (x >>> 16)) >>> 0
  return (x / 4294967295) * 2 - 1
}

function san(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  return Math.max(-1.5, Math.min(1.5, value))
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

const BUILTIN = buildTables()

function builtinTable(index: number) {
  return BUILTIN[index] ?? BUILTIN[0]
}

function buildTables() {
  const frames = 4
  const sine = harmonic(frames, (k) => (k === 1 ? 1 : 0), 1)
  const saw = harmonic(frames, (k) => 1 / k, 28)
  const square = harmonic(frames, (k) => (k % 2 ? 1 / k : 0), 21)
  const formant = harmonic(frames, (k) => (k === 1 || k === 3 || k === 5 ? 1 / k : 0), 8)
  const bell = harmonic(frames, (k) => (k === 1 || k === 4 || k === 7 ? 1 / k : 0), 10)
  return [sine, saw, square, formant, bell]
}

function harmonic(frames: number, weight: (k: number) => number, cap: number) {
  const out: Float32Array[] = []
  for (let frame = 0; frame < frames; frame++) {
    const data = new Float32Array(256)
    const maxH = Math.max(1, Math.round(1 + (frame / Math.max(1, frames - 1)) * (cap - 1)))
    for (let i = 0; i < data.length; i++) {
      let sum = 0
      for (let k = 1; k <= maxH; k++) sum += weight(k) * Math.sin((2 * Math.PI * k * i) / data.length)
      data[i] = sum
    }
    let peak = 0
    for (const value of data) peak = Math.max(peak, Math.abs(value))
    if (peak > 1e-8) for (let i = 0; i < data.length; i++) data[i] /= peak
    out.push(data)
  }
  return out
}

export function macroSpecs(kind: DeviceKind): ParamSpec[] {
  return DEVICE_PARAMS[kind].filter((item) => /^m[1-4]$/.test(item.id))
}

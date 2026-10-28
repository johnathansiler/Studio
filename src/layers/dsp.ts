/** Per-layer filter, envelope, and effects. Quality first: TPT filter, Hermite reads. */

export function flush(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  return value
}

export function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function soft(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  const shaped = Math.tanh(value)
  return Math.abs(shaped) < 1e-15 ? 0 : shaped
}

export function hermite(data: Float32Array, pos: number) {
  if (data.length < 2) return data[0] || 0
  const max = data.length - 1
  const clamped = clamp(pos, 0, max)
  const index = Math.floor(clamped)
  const frac = clamped - index
  const y0 = data[Math.max(0, index - 1)] || 0
  const y1 = data[index] || 0
  const y2 = data[Math.min(max, index + 1)] || 0
  const y3 = data[Math.min(max, index + 2)] || 0
  const c1 = 0.5 * (y2 - y0)
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2)
  return flush(((c3 * frac + c2) * frac + c1) * frac + y1)
}

export interface EnvState {
  value: number
  stage: number
}

export function freshEnv(): EnvState {
  return { value: 0, stage: 0 }
}

export function envStep(env: EnvState, released: boolean, attackMs: number, decayMs: number, sustain: number, releaseMs: number, sampleRate: number) {
  if (released && env.stage < 3) env.stage = 3
  if (env.stage === 0) {
    const attack = Math.max(1, (Math.max(0, attackMs) / 1000) * sampleRate)
    env.value += 1 / attack
    if (env.value >= 1) {
      env.value = 1
      env.stage = 1
    }
  } else if (env.stage === 1) {
    const decay = Math.max(1, (Math.max(1, decayMs) / 1000) * sampleRate)
    const target = clamp(sustain, 0, 1)
    env.value += (target - env.value) * (1 - Math.exp(-1 / decay))
    if (Math.abs(env.value - target) < 0.001) {
      env.value = target
      env.stage = 2
    }
  } else if (env.stage === 2) {
    env.value = clamp(sustain, 0, 1)
  } else {
    const release = Math.max(1, (Math.max(1, releaseMs) / 1000) * sampleRate)
    env.value *= Math.exp(-1 / release)
    if (env.value < 1e-5) env.value = 0
  }
  env.value = flush(env.value)
}

export interface FilterState {
  ic1eq: number
  ic2eq: number
}

export function freshFilter(): FilterState {
  return { ic1eq: 0, ic2eq: 0 }
}

/** Topology-preserving transform state variable filter. Mode 0 low, 1 high, 2 band, 3 notch. */
export function filterStep(state: FilterState, input: number, cutoff: number, res: number, mode: number, sampleRate: number) {
  const freq = clamp(cutoff, 20, sampleRate * 0.45)
  const g = Math.tan((Math.PI * freq) / sampleRate)
  const q = 0.5 + clamp(res, 0, 0.97) * 9
  const k = 1 / q
  const a1 = 1 / (1 + g * (g + k))
  const a2 = g * a1
  const a3 = g * a2
  const v3 = input - state.ic2eq
  const v1 = a1 * state.ic1eq + a2 * v3
  const v2 = state.ic2eq + a2 * state.ic1eq + a3 * v3
  state.ic1eq = flush(2 * v1 - state.ic1eq)
  state.ic2eq = flush(2 * v2 - state.ic2eq)
  const low = v2
  const band = v1
  const high = input - k * v1 - v2
  const choice = Math.max(0, Math.min(3, Math.round(mode)))
  if (choice === 1) return flush(high)
  if (choice === 2) return flush(band)
  if (choice === 3) return flush(low + high)
  return flush(low)
}

export interface ChorusState {
  buf: Float32Array
  pos: number
  phase: number
}

export function freshChorus(sampleRate: number): ChorusState {
  return { buf: new Float32Array(Math.max(64, Math.round(sampleRate * 0.03))), pos: 0, phase: 0 }
}

function readLoop(buf: Float32Array, pos: number) {
  const len = buf.length
  let index = pos % len
  if (index < 0) index += len
  const i0 = Math.floor(index)
  const frac = index - i0
  const a = buf[i0] || 0
  const b = buf[(i0 + 1) % len] || 0
  return a * (1 - frac) + b * frac
}

export function chorusStep(state: ChorusState, input: number, mix: number, sampleRate: number) {
  const amount = clamp(mix, 0, 1)
  state.phase += 0.28 / sampleRate
  if (state.phase >= 1) state.phase -= 1
  const lfo = Math.sin(2 * Math.PI * state.phase)
  const delay = (0.006 + 0.004 * (lfo * 0.5 + 0.5)) * sampleRate
  const wet = readLoop(state.buf, state.pos - delay)
  state.buf[state.pos] = flush(input)
  state.pos += 1
  if (state.pos >= state.buf.length) state.pos = 0
  if (amount < 0.001) return flush(input)
  return flush(input * (1 - amount) + wet * amount)
}

export interface DelayState {
  buf: Float32Array | null
  pos: number
  damp: number
}

export function freshDelay(): DelayState {
  return { buf: null, pos: 0, damp: 0 }
}

export function delayStep(state: DelayState, input: number, mix: number, timeSec: number, feedback: number, sampleRate: number) {
  const amount = clamp(mix, 0, 1)
  if (!state.buf && amount < 0.001) return flush(input)
  if (!state.buf) state.buf = new Float32Array(Math.max(64, Math.round(sampleRate * 1)))
  const buf = state.buf
  const delay = clamp(Math.round(clamp(timeSec, 0.02, 0.95) * sampleRate), 1, buf.length - 2)
  const wet = readLoop(buf, state.pos - delay)
  state.damp = flush(state.damp + (wet - state.damp) * 0.35)
  buf[state.pos] = flush(input + state.damp * clamp(feedback, 0, 0.9))
  state.pos += 1
  if (state.pos >= buf.length) state.pos = 0
  if (amount < 0.001) return flush(input)
  return flush(input * (1 - amount) + wet * amount)
}

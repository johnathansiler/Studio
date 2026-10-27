import { envelope, freshState, midiHz, type PlayVoice, type ToneCtx } from './synth'

const DRAW = [0.5, 1.5, 1, 2, 3, 4, 5, 6, 8]

export function renderFamily(kind: 'organ' | 'grain' | 'phys', ctx: ToneCtx) {
  if (kind === 'organ') return clean(organ(ctx))
  if (kind === 'grain') return clean(grain(ctx))
  return clean(phys(ctx))
}

export function drumHit(pad: number, state: { phase: number; low: number; band: number; n: number }, tune: number, sr: number) {
  const t = state.phase / sr
  const body = midiHz(36 + tune)
  if (pad === 0) {
    state.low += (48 + 160 * Math.exp(-t * 24)) / sr
    const click = t < 0.004 ? hash(state.n++) : 0
    return clean(Math.sin(2 * Math.PI * state.low) * Math.exp(-t * 4.5) + click * 0.4 * Math.exp(-t * 80))
  }
  if (pad === 1) {
    state.low += (body * 2) / sr
    const noise = hash(state.n++) * Math.exp(-t * 14)
    return clean(Math.sin(2 * Math.PI * state.low) * Math.exp(-t * 18) * 0.45 + noise * 0.7)
  }
  if (pad === 2) {
    const noise = hash(state.n++)
    const bright = noise - state.band
    state.band += bright * 0.35
    return clean(bright * Math.exp(-t * (padTone(tune) ? 28 : 40)) * 0.6)
  }
  if (pad === 4) {
    const burst = Math.floor(t * 90) % 3 === 0 ? 1 : 0.25
    return clean(hash(state.n++) * burst * Math.exp(-t * 10) * 0.7)
  }
  state.band += body / sr
  return clean(Math.sin(2 * Math.PI * state.band) * Math.exp(-t * 3.2))
}

export function keysVoice(state: ReturnType<typeof freshState>, note: number, program: number, bend: number, sr: number) {
  const hz = midiHz(note + bend)
  const choice = clampInt(program, 1, 4)
  if (choice === 2) {
    const mod = advance(state, 1, hz * 2, sr)
    const car = advance(state, 0, hz, sr)
    return Math.sin(2 * Math.PI * car + Math.sin(2 * Math.PI * mod) * 1.4) * 0.35
  }
  if (choice === 3) {
    const a = advance(state, 0, hz * 2 ** (-4 / 1200), sr)
    const b = advance(state, 1, hz * 2 ** (4 / 1200), sr)
    return (Math.sin(2 * Math.PI * a) + Math.sin(2 * Math.PI * b)) * 0.22
  }
  if (choice === 4) {
    const car = advance(state, 0, hz, sr)
    const tone = Math.sin(2 * Math.PI * car)
    const noise = hash(state.n++) * 0.04
    return (tone * 0.8 + noise) * 0.3
  }
  let sum = 0
  const age = state.extra[0]++
  for (let partial = 1; partial <= 4; partial++) {
    const step = advance(state, partial, hz * partial, sr)
    const decay = Math.exp((-age / sr) * (1.2 + partial * 1.6))
    sum += Math.sin(2 * Math.PI * step) * decay / partial
  }
  return sum * 0.45
}

function organ(ctx: ToneCtx) {
  const p = ctx.params
  let mix = 0
  const levels = [p.d16, p.d513, p.d8, p.d4, p.d223, p.d2, p.d135, p.d113, p.d1]
  const additive = (p.mode || 0) >= 0.5
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = hold(voice, ctx)
    state.env[0] = envelope(state.env[0], voice.released, p.attack, p.decay, p.sustain, p.release, ctx.sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const hz = midiHz(played + (voice.bend || 0))
    let tone = 0
    if (additive) {
      for (let i = 0; i < 8; i++) {
        const level = p[`a${i + 1}`] || 0
        if (level < 0.001) continue
        const step = advance(state, i, hz * (i + 1), ctx.sr)
        tone += Math.sin(2 * Math.PI * step) * level
      }
    } else {
      for (let i = 0; i < DRAW.length; i++) {
        const level = levels[i] || 0
        if (level < 0.001) continue
        const step = advance(state, i, hz * DRAW[i], ctx.sr)
        tone += Math.sin(2 * Math.PI * step) * level
      }
      if ((p.perc || 0) > 0.01) {
        const step = advance(state, 10, hz * 2, ctx.sr)
        const age = state.extra[1]++
        tone += Math.sin(2 * Math.PI * step) * (p.perc || 0) * Math.exp(-age / ctx.sr / 0.12)
      }
    }
    if ((p.rotary || 0) > 0.01 && ctx.quality === 'full') {
      const slow = 0.6 + (p.rotary || 0) * 4
      const wobble = 1 + Math.sin(2 * Math.PI * slow * (ctx.time / ctx.sr)) * 0.004
      const side = advance(state, 11, hz * wobble, ctx.sr)
      tone = tone * 0.75 + Math.sin(2 * Math.PI * side) * 0.25 * (levels[2] || p.a1 || 0.5)
    }
    mix += tone * 0.12 * state.env[0] * voice.vel
  }
  return mix
}

function grain(ctx: ToneCtx) {
  const p = ctx.params
  const count = ctx.quality === 'eco' ? 2 : 4
  let mix = 0
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = hold(voice, ctx)
    state.env[0] = envelope(state.env[0], voice.released, p.attack, p.decay, p.sustain, p.release, ctx.sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const hz = midiHz(played + (p.pitch || 0) + (voice.bend || 0))
    const size = Math.max(8, ((p.size || 80) / 1000) * ctx.sr)
    if (!state.started) {
      for (let g = 0; g < count; g++) state.extra[g] = (g * size) / count
      state.started = 1
    }
    let sum = 0
    for (let g = 0; g < count; g++) {
      state.extra[g] += 1
      if (state.extra[g] >= size) state.extra[g] = 0
      const window = Math.sin(Math.PI * (state.extra[g] / size))
      const step = advance(state, g, hz, ctx.sr)
      let sample = Math.sin(2 * Math.PI * step)
      const table = ctx.table
      if (table?.[0]?.length) {
        const spray = (hash(state.n++) * 0.5 + 0.5) * (p.spray || 0)
        const pos = (((p.position || 0) + spray) % 1) * table[0].length
        const index = Math.floor(pos)
        sample = table[0][index] || 0
        state.phase[g] = step
      }
      sum += sample * window
    }
    mix += (sum / count) * 0.4 * state.env[0] * voice.vel
  }
  return mix
}

function phys(ctx: ToneCtx) {
  const p = ctx.params
  const model = clampInt(p.model || 0, 0, 2)
  let mix = 0
  for (const voice of ctx.voices) {
    if (!voice.active) continue
    const state = hold(voice, ctx)
    state.env[0] = envelope(state.env[0], voice.released, p.attack ?? 1, p.decay, p.sustain, p.release, ctx.sr)
    if (voice.released && state.env[0] < 0.0008) {
      voice.active = false
      continue
    }
    const played = ctx.played(voice)
    if (played == null) continue
    const hz = midiHz(played + (voice.bend || 0))
    let sample = 0
    if (model === 1) {
      const age = state.extra[0]++
      const bright = p.bright || 0
      const ratios = [1, 4, 9.2]
      for (let i = 0; i < (bright > 0.05 && ctx.quality === 'full' ? 3 : 1); i++) {
        const step = advance(state, i, hz * ratios[i], ctx.sr)
        sample += Math.sin(2 * Math.PI * step) * Math.exp((-age / ctx.sr) * (3 + i * 8)) / (1 + i)
      }
    } else if (model === 2) {
      const step = advance(state, 0, hz, ctx.sr)
      const breath = hash(state.n++) * (0.08 + (p.bow || 0) * 0.4)
      sample = Math.sin(2 * Math.PI * step) * 0.9 + breath
    } else sample = karplus(state, hz, ctx.sr, p.decay || 0.5, p.bright || 0.3)
    mix += sample * 0.35 * state.env[0] * voice.vel
  }
  return mix
}

function karplus(state: ReturnType<typeof freshState>, hz: number, sr: number, decay: number, bright: number) {
  const size = 8192
  if (!state.buf || state.buf.length !== size) state.buf = new Float32Array(size)
  const line = state.buf
  const period = Math.max(2, sr / hz - 0.5)
  const pos = state.extra[0] || 0
  const readAt = pos - period
  const y = fracRead(line, readAt)
  const filtered = y * (0.5 + bright * 0.5) + (state.prev || 0) * (0.5 - bright * 0.5)
  const burst = state.extra[1] || 0
  const excite = burst < 4 ? hash(state.n++) * 0.8 : 0
  const loss = 0.96 + decay * 0.035
  line[pos % size] = clean(filtered * loss + excite)
  state.prev = y
  state.extra[0] = (pos + 1) % size
  state.extra[1] = burst + 1
  return y
}

function fracRead(line: Float32Array, at: number) {
  const size = line.length
  let pos = at % size
  if (pos < 0) pos += size
  const index = Math.floor(pos)
  const frac = pos - index
  const a = line[index] || 0
  const b = line[(index + 1) % size] || 0
  return a * (1 - frac) + b * frac
}

function hold(voice: PlayVoice, ctx: ToneCtx) {
  return (voice.synth[ctx.deviceId] ??= freshState())
}

function advance(state: ReturnType<typeof freshState>, index: number, hz: number, sr: number) {
  const phase = (state.phase[index] || 0) + hz / sr
  state.phase[index] = phase >= 1 ? phase - Math.floor(phase) : phase
  return state.phase[index]
}

function padTone(tune: number) {
  return tune >= 0
}

function hash(n: number) {
  let x = Math.imul(n | 0, 0x45d9f3b)
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b)
  x = (x ^ (x >>> 16)) >>> 0
  return (x / 4294967295) * 2 - 1
}

function clean(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  return Math.max(-1.5, Math.min(1.5, value))
}

function clampInt(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.round(value)))
}

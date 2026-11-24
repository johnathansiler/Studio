/**
 * Mono 808 bass. One oscillator, continuous phase, and a pitch glide that
 * lands on the target note. The rack and the offline render share this voice.
 */

export interface Bass808Event {
  sample: number
  pitch: number
  vel: number
  slide?: boolean
}

export interface Bass808Buffers {
  samples?: Float32Array | null
  sampleRate?: number
}

export interface Bass808State {
  live: boolean
  released: boolean
  held: number[]
  vel: number
  phase: number
  subPhase: number
  env: number
  baseMidi: number
  glideFrom: number
  glideTo: number
  glidePos: number
  glideLen: number
  dropAmt: number
  dropAge: number
  clickAge: number
  clickPhase: number
  samplePos: number
  lp: number
  hpX: number
  hpY: number
}

export function createBassState(): Bass808State {
  return {
    live: false,
    released: false,
    held: [],
    vel: 0,
    phase: 0,
    subPhase: 0,
    env: 0,
    baseMidi: 36,
    glideFrom: 36,
    glideTo: 36,
    glidePos: 0,
    glideLen: 0,
    dropAmt: 0,
    dropAge: 0,
    clickAge: 1e9,
    clickPhase: 0,
    samplePos: 0,
    lp: 0,
    hpX: 0,
    hpY: 0,
  }
}

export function glideLength(glideMs: number, sampleRate: number) {
  if (!(glideMs > 0) || !(sampleRate > 0)) return 0
  return Math.max(0, Math.round((glideMs / 1000) * sampleRate))
}

export function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
}

/** One sounding voice. A new note replaces it. */
export function bassActive(state: Bass808State) {
  return state.live ? 1 : 0
}

function san(value: number) {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-15) return 0
  return Math.max(-1.4, Math.min(1.4, value))
}

function num(params: Record<string, number>, key: string, fallback: number) {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Start or retarget the single voice.
 * Always glides from the current pitch. Legato glides only while a note is
 * still held, or when the note itself is marked slide.
 */
export function bassNote(state: Bass808State, pitch: number, vel: number, slide: boolean, params: Record<string, number>, sampleRate: number) {
  const midi = Math.max(0, Math.min(127, Math.round(pitch)))
  if (vel <= 0.0001) {
    const active = Math.round(state.glideTo)
    state.held = state.held.filter((note) => note !== midi)
    if (!state.held.length) {
      if (state.live) state.released = true
      return
    }
    // Releasing the note we slid away from must not restart the glide.
    if (midi !== active && state.held.includes(active)) return
    begin(state, state.held[state.held.length - 1], state.vel, true, params, sampleRate)
    return
  }
  const overlap = state.held.length > 0 && state.live && !state.released
  if (!state.held.includes(midi)) state.held.push(midi)
  const always = num(params, 'gmode', 1) < 0.5
  const glide = state.live && (slide || always || overlap)
  begin(state, midi, vel, glide, params, sampleRate)
}

function begin(state: Bass808State, midi: number, vel: number, glide: boolean, params: Record<string, number>, sampleRate: number) {
  const length = glide ? glideLength(num(params, 'glide', 0), sampleRate) : 0
  state.live = true
  state.released = false
  state.vel = Math.max(0, Math.min(1, vel))
  state.glideFrom = state.live && length > 0 ? state.baseMidi : midi
  state.glideTo = midi
  state.glidePos = 0
  state.glideLen = length
  if (!glide || length <= 0) {
    state.glideFrom = midi
    state.baseMidi = midi
    state.dropAmt = Math.max(0, num(params, 'drop', 0))
    state.dropAge = 0
    state.clickAge = 0
    state.clickPhase = 0
    state.samplePos = 0
  }
}

function readSample(buffer: Float32Array | null | undefined, pos: number) {
  if (!buffer || buffer.length < 2) return 0
  if (pos < 0 || pos >= buffer.length - 1) return 0
  const i0 = Math.floor(pos)
  const frac = pos - i0
  const a = buffer[i0] || 0
  const b = buffer[i0 + 1] || 0
  return a + (b - a) * frac
}

/** One output sample. Phase is never reset, so a stolen note does not click. */
export function bassStep(
  state: Bass808State,
  params: Record<string, number>,
  sampleRate: number,
  buffer: Float32Array | null = null,
  bufferRate = sampleRate,
): number {
  if (!state.live) return 0
  const sr = Math.max(1, sampleRate)
  if (state.glideLen > 0 && state.glidePos < state.glideLen) {
    const t = state.glidePos / state.glideLen
    state.baseMidi = state.glideFrom + (state.glideTo - state.glideFrom) * t
    state.glidePos += 1
  } else {
    state.baseMidi = state.glideTo
    state.glidePos = state.glideLen
  }
  const dropLen = Math.max(1, 0.04 * sr)
  const drop = state.dropAmt * Math.exp(-state.dropAge / (dropLen * 0.45))
  state.dropAge += 1
  const sounded = state.baseMidi + drop
  const hz = Math.max(8, midiHz(sounded))
  const sine = Math.sin(state.phase)
  state.phase += (2 * Math.PI * hz) / sr
  if (state.phase > Math.PI * 2) state.phase -= Math.PI * 2
  const sub = Math.sin(state.subPhase) * num(params, 'sub', 0)
  state.subPhase += (2 * Math.PI * hz * 0.5) / sr
  if (state.subPhase > Math.PI * 2) state.subPhase -= Math.PI * 2

  const source = num(params, 'source', 0) >= 0.5 && buffer && buffer.length > 8 ? 1 : 0
  const root = num(params, 'root', 36)
  const speed = 2 ** ((sounded - root) / 12) * ((bufferRate > 0 ? bufferRate : sr) / sr)
  const sampled = source ? readSample(buffer, state.samplePos) : 0
  if (source) state.samplePos += speed

  const clickLen = Math.max(1, 0.008 * sr)
  const clickEnv = state.clickAge < clickLen ? Math.sin((Math.PI * state.clickAge) / clickLen) : 0
  const click = Math.sin(state.clickPhase) * clickEnv * num(params, 'click', 0) * 0.4
  state.clickPhase += (2 * Math.PI * 1600) / sr
  state.clickAge += 1

  const body = sine * (1 - source) * 0.72 + sampled * source * 0.8
  let mixed = body + sub * 0.55 + click
  const tone = Math.max(40, Math.min(sr * 0.45, num(params, 'tone', 1800)))
  const g = 1 - Math.exp((-2 * Math.PI * tone) / sr)
  state.lp += (mixed - state.lp) * g
  mixed = state.lp
  const drive = Math.max(0, Math.min(1, num(params, 'drive', 0)))
  if (drive > 0.0001) {
    const k = 1 + drive * 14
    mixed = Math.tanh(mixed * k) / Math.tanh(k)
  }
  const sustain = Math.max(0, Math.min(1, num(params, 'sustain', 0.4)))
  const decay = Math.max(1, (num(params, 'decay', 500) / 1000) * sr)
  const release = Math.max(1, 0.09 * sr)
  const attack = Math.max(1, 0.0015 * sr)
  if (!state.released) {
    if (state.env < 0.999) state.env += (1 - state.env) * (1 - Math.exp(-1 / attack))
    else state.env += (sustain - state.env) * (1 - Math.exp(-1 / decay))
  } else {
    state.env *= Math.exp(-1 / release)
    if (state.env < 1e-5) {
      state.env = 0
      state.live = false
      state.released = false
      state.held = []
    }
  }
  const level = Math.max(0, Math.min(1, num(params, 'level', 0.8)))
  const gain = state.env * level * (0.35 + 0.65 * state.vel)
  const next = mixed * gain
  const keep = Math.exp((-2 * Math.PI * 18) / sr)
  const y = next - state.hpX + keep * state.hpY
  state.hpX = next
  state.hpY = y
  return san(y * 0.62)
}

export interface Bass808Render {
  left: Float32Array
  midi: Float32Array
}

/** Offline render. The traced `midi` channel is the glide pitch, before the drop. */
export function renderBass808(
  params: Record<string, number>,
  events: Bass808Event[],
  sampleRate: number,
  length: number,
  buffers: Bass808Buffers = {},
): Bass808Render {
  const state = createBassState()
  // Note-offs at a sample run before note-ons there, matching a finger that leaves one key and then plays the next.
  const ordered = events.slice().sort((a, b) => a.sample - b.sample || a.vel - b.vel)
  const left = new Float32Array(length)
  const midi = new Float32Array(length)
  const buffer = buffers.samples ?? null
  const bufferRate = buffers.sampleRate || sampleRate
  let cursor = 0
  for (let i = 0; i < length; i++) {
    while (cursor < ordered.length && ordered[cursor].sample <= i) {
      const event = ordered[cursor]
      bassNote(state, event.pitch, event.vel, !!event.slide, params, sampleRate)
      cursor += 1
    }
    left[i] = bassStep(state, params, sampleRate, buffer, bufferRate)
    midi[i] = state.baseMidi
  }
  return { left, midi }
}

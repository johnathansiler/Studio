/**
 * Labeled loops for the key lab. Notes are placed in a known key.
 * This is not library audio and it is not uploaded.
 */

const SR = 44100

export interface Rendered {
  id: string
  root: number
  mode: 'major' | 'minor'
  content: 'loop' | 'one-shot' | 'drum' | 'noise'
  texture: 'melodic' | 'bass-heavy' | 'mixed' | 'drum' | 'noise'
  family: string
  seconds: number
  samples: Float32Array
}

function addTone(buffer: Float32Array, start: number, seconds: number, freq: number, amp: number, decay: number, partials: number[], attack = 0.008) {
  const end = Math.min(buffer.length, start + Math.floor(seconds * SR))
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR
    const env = Math.min(1, t / attack) * Math.exp(-t / decay)
    let sample = 0
    for (let p = 0; p < partials.length; p++) sample += partials[p] * Math.sin(2 * Math.PI * freq * (p + 1) * t)
    buffer[i] += amp * env * sample
  }
}

function addSaw(buffer: Float32Array, start: number, seconds: number, freq: number, amp: number, detuneCents: number) {
  const end = Math.min(buffer.length, start + Math.floor(seconds * SR))
  const f = freq * 2 ** (detuneCents / 1200)
  let phase = 0
  const step = (2 * Math.PI * f) / SR
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR
    const env = Math.min(1, t / 0.03) * Math.exp(-t / 1.4)
    phase += step
    const x = ((phase / Math.PI) % 2) - 1
    buffer[i] += amp * env * x * 0.35
  }
}

function addKick(buffer: Float32Array, start: number) {
  const end = Math.min(buffer.length, start + Math.floor(0.22 * SR))
  let phase = 0
  for (let i = start; i < end; i++) {
    const t = (i - start) / SR
    const freq = 48 + 110 * Math.exp(-t * 28)
    phase += (2 * Math.PI * freq) / SR
    buffer[i] += 0.85 * Math.exp(-t * 14) * Math.sin(phase)
  }
}

function addHat(buffer: Float32Array, start: number) {
  const end = Math.min(buffer.length, start + Math.floor(0.04 * SR))
  let seed = (start * 97 + 13) >>> 0
  let prev = 0
  for (let i = start; i < end; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 4294967296 * 2 - 1
    const hat = white - prev
    prev = white
    const t = (i - start) / SR
    buffer[i] += 0.18 * Math.exp(-t / 0.012) * hat
  }
}

function normalize(buffer: Float32Array) {
  let peak = 0
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i]))
  if (peak < 1e-5) return buffer
  const gain = 0.8 / peak
  for (let i = 0; i < buffer.length; i++) buffer[i] *= gain
  return buffer
}

function hz(root: number, semi: number, octave: number) {
  return 440 * 2 ** ((octave * 12 + root + semi - 69) / 12)
}

function progression(mode: 'major' | 'minor', family: 'cadence' | 'trap' | 'bass') {
  if (family === 'trap') {
    return mode === 'major'
      ? [[0, 4, 7], [5, 9, 0], [7, 11, 2], [0, 4, 7]]
      : [[0, 3, 7], [5, 8, 0], [7, 10, 2], [0, 3, 7]]
  }
  if (family === 'bass') {
    return mode === 'major'
      ? [[0, 4, 7], [0, 4, 7], [7, 11, 2], [0, 4, 7]]
      : [[0, 3, 7], [0, 3, 7], [7, 11, 2], [0, 3, 7]]
  }
  return mode === 'major'
    ? [[0, 4, 7], [7, 11, 2], [5, 9, 0], [0, 4, 7]]
    : [[0, 3, 7], [7, 11, 2], [5, 8, 0], [0, 3, 7]]
}

function renderLoop(options: { root: number; mode: 'major' | 'minor'; bars: number; bpm: number; family: 'cadence' | 'trap' | 'bass'; drums: boolean; melody: boolean }) {
  const beat = 60 / options.bpm
  const frames = Math.round(options.bars * 4 * beat * SR)
  const buffer = new Float32Array(frames)
  const chords = progression(options.mode, options.family)
  const raised = options.family === 'cadence' || options.family === 'bass'
  for (let bar = 0; bar < options.bars; bar++) {
    const chord = chords[bar % 4].slice()
    if (raised && options.mode === 'minor' && chord[0] === 7) chord[1] = 11
    for (let step = 0; step < 4; step++) {
      const at = Math.round((bar * 4 + step) * beat * SR)
      if (options.drums) {
        if (step % 2 === 0) addKick(buffer, at)
        if (step % 2 === 1) addHat(buffer, at)
        addHat(buffer, at + Math.round(beat * 0.5 * SR))
      }
      const bassSemi = options.family === 'bass' ? chord[0] : (step % 2 === 0 ? chord[0] : chord[2])
      const bassAmp = options.family === 'bass' ? 0.9 : options.family === 'trap' ? 0.62 : 0.38
      addTone(buffer, at, beat * 0.92, hz(options.root, bassSemi, 2), bassAmp, 0.4, [1, 0.3, 0.08], 0.004)
      if (options.family === 'bass') {
        addTone(buffer, at, beat * 0.9, hz(options.root, bassSemi, 1), 0.55, 0.5, [1], 0.01)
      }
      if (options.melody && step % 2 === 0) {
        for (const semi of chord) {
          addTone(buffer, at, beat * 1.8, hz(options.root, semi, 4), 0.22, 0.55, [1, 0.4, 0.18, 0.08], 0.006)
          if (options.family !== 'bass') addSaw(buffer, at, beat * 1.6, hz(options.root, semi, 4), 0.08, semi % 2 === 0 ? 6 : -6)
        }
      }
      if (options.melody) {
        const lead = [chord[0], chord[1], chord[2], chord[0] + 12][step]
        addTone(buffer, at, beat * 0.75, hz(options.root, lead, 5), 0.16, 0.3, [1, 0.35, 0.12], 0.01)
      }
    }
  }
  return normalize(buffer)
}

function renderStab(root: number, mode: 'major' | 'minor') {
  const buffer = new Float32Array(Math.round(0.7 * SR))
  const chord = mode === 'major' ? [0, 4, 7] : [0, 3, 7]
  addTone(buffer, 0, 0.65, hz(root, 0, 2), 0.7, 0.28, [1, 0.4, 0.15], 0.004)
  for (const semi of chord) addTone(buffer, 0, 0.6, hz(root, semi, 4), 0.35, 0.22, [1, 0.45, 0.2, 0.1], 0.003)
  return normalize(buffer)
}

function renderDrums(index: number) {
  const bpm = 100 + index * 7
  const bars = 2
  const beat = 60 / bpm
  const buffer = new Float32Array(Math.round(bars * 4 * beat * SR))
  for (let bar = 0; bar < bars; bar++) {
    for (let step = 0; step < 4; step++) {
      const at = Math.round((bar * 4 + step) * beat * SR)
      if (step % 2 === 0) addKick(buffer, at)
      addHat(buffer, at)
      addHat(buffer, at + Math.round(beat * 0.5 * SR))
    }
  }
  return normalize(buffer)
}

function renderNoise(index: number) {
  const buffer = new Float32Array(Math.round(3 * SR))
  let seed = 1000 + index * 17
  let prev = 0
  for (let i = 0; i < buffer.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const white = seed / 4294967296 * 2 - 1
    prev = index % 2 === 0 ? white : prev * 0.98 + white * 0.02
    buffer[i] = prev
  }
  return normalize(buffer)
}

export function renderSuite(): Rendered[] {
  const out: Rendered[] = []
  const push = (item: Omit<Rendered, 'seconds'> & { samples: Float32Array }) => {
    out.push({ ...item, seconds: item.samples.length / SR })
  }
  for (const mode of ['major', 'minor'] as const) {
    for (let root = 0; root < 12; root++) {
      const cadence = renderLoop({ root, mode, bars: 4, bpm: 120, family: 'cadence', drums: false, melody: true })
      push({ id: `cadence-${mode}-${root}`, root, mode, content: 'loop', texture: 'melodic', family: 'cadence', samples: cadence })
      const short = renderLoop({ root, mode, bars: 2, bpm: 140, family: 'cadence', drums: true, melody: true })
      push({ id: `short-${mode}-${root}`, root, mode, content: 'loop', texture: 'mixed', family: 'short-mix', samples: short })
      const trap = renderLoop({ root, mode, bars: 4, bpm: 124, family: 'trap', drums: true, melody: true })
      push({ id: `trap-${mode}-${root}`, root, mode, content: 'loop', texture: 'mixed', family: 'relative-trap', samples: trap })
      const bass = renderLoop({ root, mode, bars: 2, bpm: 128, family: 'bass', drums: true, melody: false })
      push({ id: `bass-${mode}-${root}`, root, mode, content: 'loop', texture: 'bass-heavy', family: 'bass-heavy', samples: bass })
      const stab = renderStab(root, mode)
      push({ id: `stab-${mode}-${root}`, root, mode, content: 'one-shot', texture: mode === 'major' ? 'melodic' : 'melodic', family: 'one-shot', samples: stab })
    }
  }
  for (let i = 0; i < 8; i++) {
    const samples = renderDrums(i)
    push({ id: `drums-${i}`, root: 0, mode: 'major', content: 'drum', texture: 'drum', family: 'drum', samples })
  }
  for (let i = 0; i < 4; i++) {
    const samples = renderNoise(i)
    push({ id: `noise-${i}`, root: 0, mode: 'major', content: 'noise', texture: 'noise', family: 'noise', samples })
  }
  return out
}

export const SYNTH_RATE = SR

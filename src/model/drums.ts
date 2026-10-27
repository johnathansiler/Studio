/** Resident drum voices. Built once so the first hit does not decode or allocate. */

export type DrumKind = 'kick' | 'snare' | 'hat' | 'openhat' | 'tom' | 'clap' | 'cymbal' | 'perc'

export interface DrumPad {
  pitch: number
  name: string
  kind: DrumKind
}

export const DRUM_PADS: DrumPad[] = [
  { pitch: 36, name: 'Kick', kind: 'kick' },
  { pitch: 38, name: 'Snare', kind: 'snare' },
  { pitch: 37, name: 'Rim', kind: 'perc' },
  { pitch: 39, name: 'Clap', kind: 'clap' },
  { pitch: 42, name: 'Hat', kind: 'hat' },
  { pitch: 46, name: 'Open', kind: 'openhat' },
  { pitch: 45, name: 'Tom', kind: 'tom' },
  { pitch: 48, name: 'Tom hi', kind: 'tom' },
  { pitch: 41, name: 'Tom lo', kind: 'tom' },
  { pitch: 49, name: 'Crash', kind: 'cymbal' },
  { pitch: 51, name: 'Ride', kind: 'cymbal' },
  { pitch: 54, name: 'Tamb', kind: 'perc' },
  { pitch: 56, name: 'Cow', kind: 'perc' },
  { pitch: 62, name: 'Conga', kind: 'tom' },
  { pitch: 64, name: 'Conga hi', kind: 'tom' },
  { pitch: 75, name: 'Clave', kind: 'perc' },
]

export interface ResidentDrum {
  pitch: number
  samples: Float32Array
}

export interface Voice {
  active: boolean
  pitch: number
  velocity: number
  env: number
  phase: number
  drumIndex: number
  drumPos: number
  /** Samples between repeats. 0 while the voice does not repeat. */
  repeatEvery: number
  repeatCountdown: number
}

export function createVoices(count = 16): Voice[] {
  return Array.from({ length: count }, () => ({
    active: false,
    pitch: 60,
    velocity: 0,
    env: 0,
    phase: 0,
    drumIndex: -1,
    drumPos: 0,
    repeatEvery: 0,
    repeatCountdown: 0,
  }))
}

/** Reuses a voice slot. Does not allocate a buffer. */
export function triggerVoice(voices: Voice[], pitch: number, velocity: number, drumIndex: number, repeatEvery = 0): Voice {
  let voice = voices[0]
  for (let i = 0; i < voices.length; i++) {
    if (!voices[i].active) {
      voice = voices[i]
      break
    }
  }
  voice.active = true
  voice.pitch = pitch
  voice.velocity = velocity
  voice.env = 1
  voice.phase = 0
  voice.drumIndex = drumIndex
  voice.drumPos = 0
  voice.repeatEvery = repeatEvery
  voice.repeatCountdown = repeatEvery
  return voice
}

export function releaseVoice(voices: Voice[], pitch: number) {
  for (const voice of voices) {
    if (voice.pitch === pitch && voice.active) {
      voice.repeatEvery = 0
      voice.env = Math.min(voice.env, 0.2)
    }
  }
}

/** How many repeats a voice would fire across a block. No allocation beyond the returned count. */
export function repeatsInBlock(voice: Voice, frames: number): number {
  if (voice.repeatEvery <= 0 || frames <= 0) return 0
  let count = 0
  let left = voice.repeatCountdown
  let frame = 0
  while (frame < frames) {
    if (left <= frames - frame) {
      count += 1
      frame += left
      left = voice.repeatEvery
    } else break
  }
  return count
}

function noise(length: number, seed: number) {
  const data = new Float32Array(length)
  let state = seed || 1
  for (let i = 0; i < length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    data[i] = (state / 4294967296) * 2 - 1
  }
  return data
}

export function renderDrum(kind: DrumKind, sampleRate: number, pitch = 60): Float32Array {
  const seconds = kind === 'cymbal' || kind === 'openhat' ? 0.7 : kind === 'kick' || kind === 'tom' ? 0.35 : 0.22
  const length = Math.max(8, Math.round(sampleRate * seconds))
  const data = new Float32Array(length)
  const tone = 40 * 2 ** ((pitch - 36) / 24)
  if (kind === 'kick') {
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate
      const freq = 150 * Math.exp(-t * 18) + 48
      data[i] = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 8)
    }
    return data
  }
  if (kind === 'tom') {
    for (let i = 0; i < length; i++) {
      const t = i / sampleRate
      data[i] = Math.sin(2 * Math.PI * tone * 2 * t) * Math.exp(-t * 7)
    }
    return data
  }
  const burst = noise(length, kind === 'hat' ? 3 : kind === 'snare' ? 9 : 5)
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate
    const env = kind === 'hat' ? Math.exp(-t * 45) : kind === 'openhat' || kind === 'cymbal' ? Math.exp(-t * 6) : Math.exp(-t * 16)
    const body = kind === 'snare' || kind === 'clap' ? Math.sin(2 * Math.PI * 180 * t) * Math.exp(-t * 20) * 0.6 : 0
    data[i] = burst[i] * env * 0.8 + body
  }
  return data
}

export function residentDrums(sampleRate: number): ResidentDrum[] {
  return DRUM_PADS.map((pad) => ({ pitch: pad.pitch, samples: renderDrum(pad.kind, sampleRate, pad.pitch) }))
}

export function drumIndex(pitch: number, drums: { pitch: number }[]): number {
  return drums.findIndex((drum) => drum.pitch === pitch)
}

/** Sixteenth-note step inside a 16-step bar. */
export function stepIndex(startBeat: number, steps = 16): number {
  const sixteenths = Math.round(startBeat * 4)
  return ((sixteenths % steps) + steps) % steps
}

export function stepBeat(index: number): number {
  return index / 4
}

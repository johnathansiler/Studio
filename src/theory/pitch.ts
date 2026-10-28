import type { Tone } from './types'

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

export function mod(value: number, span: number) {
  return ((value % span) + span) % span
}

export function mod12(value: number) {
  return mod(Math.round(value), 12)
}

export function mod1200(value: number) {
  return mod(value, 1200)
}

/** Shortest distance between two pitches measured in cents, ignoring octaves. */
export function centDistance(a: number, b: number) {
  const delta = Math.abs(mod1200(a) - mod1200(b))
  return Math.min(delta, 1200 - delta)
}

export function absoluteCents(tone: Tone) {
  return tone.midi * 100 + tone.cents
}

/** Fold an absolute cent value onto a MIDI note. Half-sharp (+50) stays on the lower note. */
export function toneFromCents(abs: number): Tone {
  let midi = Math.floor(abs / 100)
  let cents = Math.round(abs - midi * 100)
  if (cents === -50) {
    midi -= 1
    cents = 50
  }
  while (cents > 50) {
    midi += 1
    cents -= 100
  }
  while (cents < -50) {
    midi -= 1
    cents += 100
  }
  return { midi, cents }
}

export function clampMidi(midi: number) {
  return Math.max(0, Math.min(127, Math.round(midi)))
}

export function toneName(tone: Tone) {
  const name = NOTE_NAMES[mod12(tone.midi)]
  if (!tone.cents) return name
  if (tone.cents === 50) return `${NOTE_NAMES[mod12(tone.midi + 1)]}½♭`
  const sign = tone.cents > 0 ? '+' : ''
  return `${name}${sign}${tone.cents}`
}

export function pitchClassName(pc: number) {
  return NOTE_NAMES[mod12(pc)]
}

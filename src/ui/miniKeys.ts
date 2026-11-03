import { keyboardStart } from '../model/keyboardPlay'

const NATURALS = [
  { step: 0, name: 'C' },
  { step: 2, name: 'D' },
  { step: 4, name: 'E' },
  { step: 5, name: 'F' },
  { step: 7, name: 'G' },
  { step: 9, name: 'A' },
  { step: 11, name: 'B' },
] as const

/** Sharps sit in the crack after these natural columns. E-F has no sharp. */
const SHARPS = [
  { step: 1, name: 'C♯', column: 0 },
  { step: 3, name: 'D♯', column: 1 },
  { step: 6, name: 'F♯', column: 3 },
  { step: 8, name: 'G♯', column: 4 },
  { step: 10, name: 'A♯', column: 5 },
] as const

export interface MiniPad {
  pitch: number
  step: number
  name: string
  kind: 'natural' | 'sharp'
  /** 0–6, the natural this pad belongs to or sits after. */
  column: number
}

/** One octave, C through B: seven tall naturals and five round sharps. */
export function miniPads(octave: number): { naturals: MiniPad[]; sharps: MiniPad[] } {
  const start = keyboardStart(octave)
  return {
    naturals: NATURALS.map((note, column) => ({
      pitch: start + note.step,
      step: note.step,
      name: note.name,
      kind: 'natural' as const,
      column,
    })),
    sharps: SHARPS.map((note) => ({
      pitch: start + note.step,
      step: note.step,
      name: note.name,
      kind: 'sharp' as const,
      column: note.column,
    })),
  }
}

export function padLabel(pad: MiniPad, octaveLabel: string) {
  if (pad.kind === 'sharp') return pad.name.replace('♯', ' sharp')
  if (pad.step === 0) return octaveLabel
  return pad.name
}

/** Grid column on a 14-column board so sharps sit between their naturals. */
export function padGridColumn(pad: MiniPad) {
  const start = pad.kind === 'natural' ? pad.column * 2 + 1 : pad.column * 2 + 2
  return `${start} / span 2`
}

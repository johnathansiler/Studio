/** On-screen keyboard window. A semitone step moves the lowest note by one key. */

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const STORAGE = 'cueharbor-key-shift'

export function noteName(midi: number): string {
  const n = Math.max(0, Math.min(127, Math.round(Number.isFinite(midi) ? midi : 0)))
  return `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`
}

export function isBlackKey(midi: number): boolean {
  return [1, 3, 6, 8, 10].includes(((Math.round(midi) % 12) + 12) % 12)
}

/** Lowest note of a window `span` semitones wide, kept inside MIDI 0–127. */
export function clampKeyStart(start: number, span: number): number {
  const width = Math.max(1, Math.round(Number.isFinite(span) ? span : 1))
  const max = Math.max(0, 127 - (width - 1))
  if (!Number.isFinite(start)) return Math.min(48, max)
  return Math.max(0, Math.min(max, Math.round(start)))
}

export function stepKeyStart(start: number, delta: number, span: number): number {
  const step = Number.isFinite(delta) ? Math.round(delta) : 0
  return clampKeyStart(start + step, span)
}

type Memory = Pick<Storage, 'getItem' | 'setItem'> | null

function bag(storage: Memory): Record<string, number> {
  try {
    const raw = storage?.getItem(STORAGE)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, number> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

function storageOf(storage?: Memory): Memory {
  if (storage !== undefined) return storage
  return typeof localStorage === 'undefined' ? null : localStorage
}

/** Saved lowest note for one instrument. Missing values use `home`. */
export function readKeyStart(instrument: string, home: number, span: number, storage?: Memory): number {
  const saved = bag(storageOf(storage))[instrument]
  if (saved == null) return clampKeyStart(home, span)
  return clampKeyStart(saved, span)
}

export function writeKeyStart(instrument: string, start: number, span: number, storage?: Memory) {
  const box = storageOf(storage)
  try {
    const next = bag(box)
    next[instrument] = clampKeyStart(start, span)
    box?.setItem(STORAGE, JSON.stringify(next))
  } catch {
    /* private mode keeps the choice for this visit */
  }
}

/** How many semitones a horizontal drag should move, snapped to whole keys. */
export function swipeSemitones(dx: number, keyWidth: number): number {
  const width = keyWidth > 8 ? keyWidth : 32
  if (Math.abs(dx) < width * 0.55) return 0
  const steps = Math.round(-dx / width)
  return steps === 0 ? (dx < 0 ? 1 : -1) : steps
}

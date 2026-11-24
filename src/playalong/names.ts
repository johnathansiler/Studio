/** Note names and movable-do solfège. Octave numbers follow MIDI: C4 is 60. */

const SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

/** Major movable do, chromatic. Index is semitones above the tonic. */
const MAJOR_DO = ['Do', 'Di', 'Re', 'Ri', 'Mi', 'Fa', 'Fi', 'Sol', 'Si', 'La', 'Li', 'Ti']
/** Minor movable do. The tonic is still Do; the third is Me. */
const MINOR_DO = ['Do', 'Ra', 'Re', 'Me', 'Mi', 'Fa', 'Fi', 'Sol', 'Le', 'La', 'Te', 'Ti']

const MINOR_SCALES = new Set([
  'aeolian',
  'dorian',
  'phrygian',
  'locrian',
  'harmonicMinor',
  'melodicMinor',
  'minorPentatonic',
  'blues',
  'phrygianDominant',
  'hungarianMinor',
  'hirajoshi',
  'insen',
  'minor',
])

export interface KeySpell {
  root: number
  scale: string
}

export function pitchClassOf(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}

export function octaveOf(pitch: number) {
  return Math.floor(Math.round(pitch) / 12) - 1
}

export function isMinorScale(scale: string) {
  return MINOR_SCALES.has(scale)
}

/** Flat spellings for keys whose major signature uses flats. */
export function preferFlats(key: KeySpell | null | undefined) {
  if (!key) return false
  const root = ((key.root % 12) + 12) % 12
  const majorRoot = isMinorScale(key.scale) ? (root + 3) % 12 : root
  return majorRoot === 5 || majorRoot === 10 || majorRoot === 3 || majorRoot === 8 || majorRoot === 1 || majorRoot === 6
}

export function spellPc(pc: number, flats: boolean) {
  const names = flats ? FLAT : SHARP
  return names[((pc % 12) + 12) % 12] ?? 'C'
}

const ROOT_TOKEN = /^(C#|D#|F#|G#|A#|[A-G])/

/** Rewrite a sharp chord symbol with flats when the song key uses them. */
export function spellSymbol(symbol: string, flats: boolean) {
  if (!flats || !symbol) return symbol
  const parts = symbol.split('/')
  return parts.map((part) => {
    const match = ROOT_TOKEN.exec(part)
    if (!match) return part
    const pc = SHARP.indexOf(match[1])
    if (pc < 0) return part
    return spellPc(pc, true) + part.slice(match[1].length)
  }).join('/')
}

/** "C4", or "Do4" when solfège is on. Do is the song tonic. */
export function noteLabel(pitch: number, mode: 'letters' | 'solfege', key?: KeySpell | null) {
  const midi = Math.round(pitch)
  const octave = octaveOf(midi)
  if (mode === 'solfege') {
    const tonic = key ? ((key.root % 12) + 12) % 12 : 0
    const step = (pitchClassOf(midi) - tonic + 12) % 12
    const table = key && isMinorScale(key.scale) ? MINOR_DO : MAJOR_DO
    return `${table[step]}${octave}`
  }
  return `${spellPc(pitchClassOf(midi), preferFlats(key))}${octave}`
}

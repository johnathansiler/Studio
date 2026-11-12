/**
 * A file is a loose note when its name is a pitch, with an optional octave
 * and an optional instrument word. `A`, `C#2`, `F#2`, `Db3`, `Bass C#`, `A bass`.
 */

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

export interface LooseName {
  /** Set when the name includes an octave. */
  midi: number | null
  /** Set when the name is a pitch class without an octave. */
  pitchClass: number | null
  /** Instrument words that are not the note, such as "bass". */
  role: string
}

export function looseMidi(pitchClass: number, octave: number) {
  const midi = (octave + 1) * 12 + ((pitchClass % 12) + 12) % 12
  if (midi < 0 || midi > 127) return null
  return midi
}

/** `A`, `C#`, `Db3`, `F#2`. The whole token, nothing else. */
export function parseNoteToken(token: string): { midi: number | null; pitchClass: number | null } | null {
  const match = token.trim().match(/^([a-g])([#b])?(-1|\d+)?$/i)
  if (!match) return null
  let semi = PITCH[match[1].toLowerCase()]
  if (semi == null) return null
  const accidental = (match[2] || '').toLowerCase()
  if (accidental === '#') semi += 1
  if (accidental === 'b') semi -= 1
  semi = ((semi % 12) + 12) % 12
  if (!match[3]) return { midi: null, pitchClass: semi }
  const midi = looseMidi(semi, Number(match[3]))
  if (midi == null) return null
  return { midi, pitchClass: null }
}

function roleWords(value: string) {
  const words = value.trim().split(/[\s_-]+/).filter(Boolean)
  if (!words.length || words.length > 3) return ''
  if (words.some((word) => /\d/.test(word))) return ''
  return words.join(' ').toLowerCase()
}

/**
 * Note names the library should play as one keyboard instrument.
 * A long filename that merely ends in a letter is not a note.
 */
export function parseLooseName(stem: string): LooseName | null {
  const text = stem.trim().replace(/[_]+/g, ' ').replace(/\s+/g, ' ')
  if (!text) return null
  const bare = parseNoteToken(text)
  if (bare) return { ...bare, role: '' }
  const lead = text.match(/^([A-Ga-g](?:#|b)?)(-?\d+)? (.+)$/)
  if (lead) {
    const note = parseNoteToken(lead[2] ? `${lead[1]}${lead[2]}` : lead[1])
    const role = roleWords(lead[3])
    if (note && role) return { ...note, role }
  }
  const tail = text.match(/^(.+) ([A-Ga-g](?:#|b)?)(-?\d+)?$/)
  if (tail) {
    const note = parseNoteToken(tail[3] ? `${tail[2]}${tail[3]}` : tail[2])
    const role = roleWords(tail[1])
    if (note && role && !parseNoteToken(tail[1])) return { ...note, role }
  }
  return null
}

export function looseTitle(value: string) {
  const words = value.trim().split(/[\s_-]+/).filter(Boolean)
  if (!words.length) return 'Instrument'
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

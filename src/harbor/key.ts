const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** "C", "C major", "Am", and "F# minor" become a pitch class. */
export function keyPitchClass(value: string | undefined): number | null {
  const text = (value ?? '').trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ')
  const match = text.match(/^([a-g])\s*([#b♯♭]?)\s*(major|minor|maj|min|m)?$/)
  if (!match) return null
  let accidental = match[2] ?? ''
  if (accidental === '♯') accidental = '#'
  if (accidental === '♭') accidental = 'b'
  const name = `${match[1].toUpperCase()}${accidental}`
  const index = NAMES.indexOf(name)
  return index < 0 ? null : index
}

/**
 * Semitones that move a loop's tonic onto the project tonic.
 * The smaller direction wins, so a fifth up is not asked to fall seven semitones.
 */
export function keySemitones(loopKey: string | undefined, projectRoot: number) {
  const loop = keyPitchClass(loopKey)
  if (loop == null || !Number.isFinite(projectRoot)) return null
  let delta = (Math.round(projectRoot) - loop + 12) % 12
  if (delta > 6) delta -= 12
  return delta
}

export function sameMusicalKey(query: string, entryKey: string | undefined) {
  const wanted = query.trim().toLowerCase()
  if (!wanted) return true
  const raw = (entryKey ?? '').trim().toLowerCase()
  if (!raw) return false
  if (raw === wanted) return true
  const left = keyPitchClass(wanted)
  const right = keyPitchClass(raw)
  if (left == null || right == null || left !== right) return false
  const leftMode = modeOf(wanted)
  const rightMode = modeOf(raw)
  if (!leftMode || !rightMode) return true
  return leftMode === rightMode
}

function modeOf(value: string) {
  const text = value.trim().toLowerCase()
  if (/\b(minor|min)$/.test(text) || /^[a-g]\s*[#b♯♭]?\s*m$/.test(text)) return 'minor'
  if (/\b(major|maj)$/.test(text)) return 'major'
  return ''
}

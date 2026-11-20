import { scaleById } from '../model/scale'
import type { LibraryEntry } from './types'

/**
 * A musical key the browser can filter on.
 * Resolved on this device from catalog metadata, a filename, or a stored Detect reading.
 * Nothing here is uploaded and the remote catalog is not rewritten.
 */
export interface MusicalKey {
  root: number
  mode: 'major' | 'minor'
  /** "F# minor" */
  label: string
  /** "F#m" or "C" */
  short: string
  source: 'catalog' | 'filename' | 'detect' | 'project'
}

export const KEY_TONICS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
/** A mode word, an optional chord extension, or one octave digit such as Amin3. */
const MODE = /^(major|minor|maj|min|m)(?:7|9|11|13|-1|[0-9])?$/i
const MODE_WORD = /^(major|minor|maj|min)$/i
const TOKEN = /[\s_\-./]+/

const baseKey = new WeakMap<object, MusicalKey | null>()

export function keyLabel(root: number, mode: 'major' | 'minor') {
  return `${KEY_TONICS[(root + 12) % 12]} ${mode}`
}

export function shortKey(root: number, mode: 'major' | 'minor') {
  const name = KEY_TONICS[(root + 12) % 12]
  return mode === 'minor' ? `${name}m` : name
}

function make(root: number, mode: 'major' | 'minor', source: MusicalKey['source']): MusicalKey {
  const pc = (root + 12) % 12
  return { root: pc, mode, label: keyLabel(pc, mode), short: shortKey(pc, mode), source }
}

/**
 * Spell "F sharp" and "D flat" before the letters are pushed together.
 * Brackets and parentheses become spaces, so "(F minor)" and "[D# Min]" stay readable.
 */
function spellKey(value: string) {
  return value
    .replace(/[()[\]{}]/g, ' ')
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/\b([A-Ga-g])[\s_\-]+sharp\b/gi, '$1#')
    .replace(/\b([A-Ga-g])[\s_\-]+flat\b/gi, '$1b')
}

/**
 * "C", "C major", "Cm", "Cmin", "F#m", "A minor", "Bbmaj", "Eb", "F sharp minor".
 * A bare tonic is major. A lowercase m is minor ("Am", "F#m") and an uppercase M is major ("AM", "F#M").
 * "C4" and other octave notes are not keys. Db and C# are the same pitch.
 */
export function parseMusicalKey(value: string | null | undefined, requireMode = false): MusicalKey | null {
  const compact = spellKey(value ?? '')
    .trim()
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, '')
  if (!compact) return null
  const match = compact.match(/^([A-Ga-g])(.*)$/)
  if (!match) return null
  const letter = match[1].toLowerCase()
  let rest = match[2]
  let accidental = ''
  if (rest.startsWith('#')) {
    accidental = '#'
    rest = rest.slice(1)
  } else if ((rest.startsWith('b') || rest.startsWith('B')) && !MODE.test(rest)) {
    const after = rest.slice(1)
    if (after === '' || MODE.test(after)) {
      accidental = 'b'
      rest = after
    }
  }
  if (rest && !MODE.test(rest)) return null
  if (!rest && requireMode) return null
  const minor = /^min/i.test(rest) || (rest.startsWith('m') && !/^maj/i.test(rest))
  let semi = LETTER[letter]
  if (accidental === '#') semi += 1
  if (accidental === 'b') semi -= 1
  return make(semi, minor ? 'minor' : 'major', 'catalog')
}

/** One label, filename, folder, tag, or pack name. A bare "C" or "C4" is not enough. */
export function keyFromText(text: string): MusicalKey | null {
  const tokens = spellKey(text).split(TOKEN).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const one = parseMusicalKey(tokens[i], true)
    if (one) return one
    const next = tokens[i + 1]
    if (next && MODE_WORD.test(next)) {
      const pair = parseMusicalKey(`${tokens[i]} ${next}`, true)
      if (pair) return pair
    }
  }
  return null
}

/**
 * Loop names such as "riff_F#m_100", "Cmin", "Bbmaj", "A_minor", "f-sharp-minor", and "(F minor)".
 * A key folder counts when the file itself has none. A bare "C" or "C4" is not enough.
 */
export function keyFromFilename(path: string): MusicalKey | null {
  const parts = path.split('/').filter(Boolean)
  const base = parts.pop() || path
  const stem = base.replace(/\.[a-z0-9]+$/i, '')
  const fromFile = keyFromText(stem)
  if (fromFile) return { ...fromFile, source: 'filename' }
  for (let i = parts.length - 1; i >= 0; i--) {
    const fromFolder = keyFromText(parts[i])
    if (fromFolder) return { ...fromFolder, source: 'filename' }
  }
  return null
}

function keyFromTags(tags: readonly string[] | undefined): MusicalKey | null {
  if (!tags) return null
  for (const tag of tags) {
    const found = keyFromText(tag)
    if (found) return { ...found, source: 'filename' }
  }
  return null
}

/** A chord symbol with a mode, such as Bbmaj. A bare "C" or a note "C4" is not a key. */
function keyFromChord(value: string | undefined): MusicalKey | null {
  if (!value) return null
  const parsed = parseMusicalKey(value, true)
  return parsed ? { ...parsed, source: 'catalog' } : null
}

export function keyFromCatalog(value: string | null | undefined): MusicalKey | null {
  const parsed = parseMusicalKey(value, false)
  return parsed ? { ...parsed, source: 'catalog' } : null
}

/**
 * Catalog metadata wins. A stored Detect reading beats a filename guess.
 * Filename keys are only for loops, so a one-shot named "Kick C" stays unkeyed.
 */
export function resolveEntryKey(entry: Pick<LibraryEntry, 'key' | 'name' | 'type' | 'musicalKey' | 'pack' | 'tags'> & { chord?: string }, detect?: MusicalKey | null): MusicalKey | null {
  if (!baseKey.has(entry)) {
    const catalog = keyFromCatalog(entry.musicalKey) ?? keyFromChord(entry.chord)
    const named = catalog || entry.type !== 'loop' ? null : guessedKey(entry)
    baseKey.set(entry, catalog ?? named)
  }
  const base = baseKey.get(entry) ?? null
  if (base?.source === 'catalog') return base
  if (detect) return { ...detect, source: 'detect' }
  return base
}

function namedKey(text: string | undefined): MusicalKey | null {
  if (!text) return null
  const found = keyFromText(text)
  return found ? { ...found, source: 'filename' } : null
}

/**
 * The file name wins. A display name that still has a sharp beats a slug that
 * dropped it ("fmin" from "F#min"). Then a key-shaped tag, then the pack name.
 */
function guessedKey(entry: Pick<LibraryEntry, 'key' | 'name' | 'pack' | 'tags'>): MusicalKey | null {
  const fromPath = keyFromFilename(entry.key)
  const fromName = namedKey(entry.name)
  if (fromName?.short.includes('#') && (!fromPath || !fromPath.short.includes('#'))) return fromName
  if (fromPath) return fromPath
  if (fromName) return fromName
  const fromTags = keyFromTags(entry.tags)
  if (fromTags) return fromTags
  if (entry.pack) return namedKey(entry.pack)
  return null
}

/** Relative major/minor, plus the parallel key. C major also keeps A minor and C minor. */
export function compatibleKeys(key: Pick<MusicalKey, 'root' | 'mode'>): MusicalKey[] {
  const relativeRoot = key.mode === 'major' ? (key.root + 9) % 12 : (key.root + 3) % 12
  const relativeMode = key.mode === 'major' ? 'minor' : 'major'
  const parallelMode = key.mode === 'major' ? 'minor' : 'major'
  const rows = [
    make(key.root, key.mode, 'catalog'),
    make(relativeRoot, relativeMode, 'catalog'),
    make(key.root, parallelMode, 'catalog'),
  ]
  const seen = new Set<string>()
  return rows.filter((item) => {
    if (seen.has(item.label)) return false
    seen.add(item.label)
    return true
  })
}

export function keyFits(have: Pick<MusicalKey, 'root' | 'mode'> | null, wanted: Pick<MusicalKey, 'root' | 'mode'>, compatible: boolean) {
  if (!have) return false
  if (have.root === wanted.root && have.mode === wanted.mode) return true
  if (!compatible) return false
  return compatibleKeys(wanted).some((item) => item.root === have.root && item.mode === have.mode)
}

/** Project key from the song scale. Detect's "Set song key" writes ionian or aeolian. */
export function projectKeyFromScale(scale: { root?: number; scale?: string } | null | undefined): MusicalKey {
  const spec = scaleById(scale?.scale)
  const intervals = spec.intervals as readonly number[]
  const minor = intervals.includes(3) && !intervals.includes(4)
  const root = (((scale?.root ?? 0) % 12) + 12) % 12
  return make(root, minor ? 'minor' : 'major', 'project')
}

export interface HearingLike {
  clearKey?: boolean
  key?: string
}

/** Detect readings stored on clips that came from a library file. */
export function libraryDetectKeys(project: {
  tracks: { clips: { bufferId: string; hearing?: HearingLike }[] }[]
  libraryFiles?: { bufferId: string; key: string }[]
}): Map<string, MusicalKey> {
  const byBuffer = new Map<string, MusicalKey>()
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.hearing?.clearKey || !clip.hearing.key) continue
      const parsed = parseMusicalKey(clip.hearing.key)
      if (!parsed) continue
      byBuffer.set(clip.bufferId, { ...parsed, source: 'detect' })
    }
  }
  const out = new Map<string, MusicalKey>()
  for (const file of project.libraryFiles ?? []) {
    const hit = byBuffer.get(file.bufferId)
    if (hit) out.set(file.key, hit)
  }
  return out
}

export interface LoopKeyCoverage {
  loops: number
  keyed: number
  catalog: number
  filename: number
  detect: number
  /** 0–100, one decimal. */
  percent: number
}

/** How many loops can be filtered by key. Client-side only. */
export function loopKeyCoverage(entries: Pick<LibraryEntry, 'key' | 'name' | 'type' | 'musicalKey' | 'pack' | 'tags'>[], detect?: ReadonlyMap<string, MusicalKey>): LoopKeyCoverage {
  let loops = 0
  let keyed = 0
  let catalog = 0
  let filename = 0
  let fromDetect = 0
  for (const entry of entries) {
    if (entry.type !== 'loop') continue
    loops += 1
    const key = resolveEntryKey(entry, detect?.get(entry.key) ?? null)
    if (!key) continue
    keyed += 1
    if (key.source === 'catalog') catalog += 1
    else if (key.source === 'filename') filename += 1
    else if (key.source === 'detect') fromDetect += 1
  }
  const percent = loops ? Math.round((keyed / loops) * 1000) / 10 : 0
  return { loops, keyed, catalog, filename, detect: fromDetect, percent }
}

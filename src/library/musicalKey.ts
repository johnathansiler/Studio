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
const MODE = /^(major|minor|maj|min|m)(?:7|9|11|13)?$/

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
 * "C", "C major", "Cm", "Cmin", "F#m", "A minor", "Bb", "Eb".
 * A bare tonic is major. A single trailing m is minor, so "F#m" is F# minor.
 * "C4" and other octave notes are not keys.
 */
export function parseMusicalKey(value: string | null | undefined, requireMode = false): MusicalKey | null {
  const compact = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/♯/g, '#')
    .replace(/♭/g, 'b')
    .replace(/[_./-]+/g, ' ')
    .replace(/\s+/g, '')
  if (!compact) return null
  const match = compact.match(/^([a-g])(.*)$/)
  if (!match) return null
  const letter = match[1]
  let rest = match[2]
  let accidental = ''
  if (rest.startsWith('#')) {
    accidental = '#'
    rest = rest.slice(1)
  } else if (rest.startsWith('b') && !MODE.test(rest)) {
    const after = rest.slice(1)
    if (after === '' || MODE.test(after)) {
      accidental = 'b'
      rest = after
    }
  }
  if (rest && !MODE.test(rest)) return null
  if (!rest && requireMode) return null
  const minor = rest === 'm' || rest.startsWith('min') || /^m\d/.test(rest)
  let semi = LETTER[letter]
  if (accidental === '#') semi += 1
  if (accidental === 'b') semi -= 1
  return make(semi, minor ? 'minor' : 'major', 'catalog')
}

/** Loop names such as "riff_F#m_100", "Cmin", and "A_minor". A bare "C" or "C4" is not enough. */
export function keyFromFilename(path: string): MusicalKey | null {
  const base = path.split('/').pop() || path
  const stem = base.replace(/\.[a-z0-9]+$/i, '')
  const tokens = stem.split(/[\s_\-./]+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const one = parseMusicalKey(tokens[i], true)
    if (one) return { ...one, source: 'filename' }
    const next = tokens[i + 1]
    if (next && /^(major|minor|maj|min)$/i.test(next)) {
      const pair = parseMusicalKey(`${tokens[i]} ${next}`, true)
      if (pair) return { ...pair, source: 'filename' }
    }
  }
  return null
}

export function keyFromCatalog(value: string | null | undefined): MusicalKey | null {
  const parsed = parseMusicalKey(value, false)
  return parsed ? { ...parsed, source: 'catalog' } : null
}

/**
 * Catalog metadata wins. A stored Detect reading beats a filename guess.
 * Filename keys are only for loops, so a one-shot named "Kick C" stays unkeyed.
 */
export function resolveEntryKey(entry: Pick<LibraryEntry, 'key' | 'name' | 'type' | 'musicalKey'>, detect?: MusicalKey | null): MusicalKey | null {
  if (!baseKey.has(entry)) {
    const catalog = keyFromCatalog(entry.musicalKey)
    const named = catalog || entry.type !== 'loop'
      ? null
      : (keyFromFilename(entry.key) ?? (entry.name ? keyFromFilename(entry.name) : null))
    baseKey.set(entry, catalog ?? named)
  }
  const base = baseKey.get(entry) ?? null
  if (base?.source === 'catalog') return base
  if (detect) return { ...detect, source: 'detect' }
  return base
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

/** Project key from the song scale. Detect's "Set project key" writes ionian or aeolian. */
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
export function loopKeyCoverage(entries: Pick<LibraryEntry, 'key' | 'name' | 'type' | 'musicalKey'>[], detect?: ReadonlyMap<string, MusicalKey>): LoopKeyCoverage {
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

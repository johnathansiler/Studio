import { bpmFromName } from '../audio/loopSeam'
import { timeStretch, type StretchMode } from '../audio/stretch/engine'
import type { LibraryEntry } from './types'

/**
 * Drum and loop shelves derived on this device from names and metadata.
 * The catalog keys are not rewritten and nothing is uploaded.
 */

export type DrumId = 'kick' | 'snare' | 'clap' | 'hat' | 'cymbal' | 'tom' | 'perc' | '808' | 'rim' | 'shaker' | 'fx'
export type DrumSub = '' | 'closed' | 'open' | 'crash' | 'ride'
export type LoopId = 'drums' | 'bass' | 'keys' | 'guitar' | 'synth' | 'pad' | 'lead' | 'strings' | 'brass' | 'vocal' | 'fx'
export type FastSort = 'name' | 'bpm' | 'key'
export type FastMode = 'drum' | 'loop'

export interface DrumClass {
  id: DrumId
  sub: DrumSub
}

export interface FastChip {
  id: string
  label: string
  short: string
  count: number
}

export interface FastRow {
  kind: 'head' | 'sound'
  id: string
  label: string
  short: string
  count: number
  entry: LibraryEntry | null
  height: number
}

export interface FastModel {
  rows: FastRow[]
  offsets: number[]
  total: number
  chips: FastChip[]
  subs: FastChip[]
  genres: FastChip[]
  jump: { id: string; short: string; label: string }[]
  sounds: number
}

export const FAST_HEAD = 44
export const FAST_ROW = 70

const DRUMS: { id: DrumId; label: string; short: string }[] = [
  { id: 'kick', label: 'Kick', short: 'Kk' },
  { id: 'snare', label: 'Snare', short: 'Sn' },
  { id: 'clap', label: 'Clap', short: 'Cp' },
  { id: 'hat', label: 'Hi-hat', short: 'Hh' },
  { id: 'cymbal', label: 'Cymbal', short: 'Cy' },
  { id: 'tom', label: 'Tom', short: 'Tm' },
  { id: 'perc', label: 'Perc', short: 'Pc' },
  { id: '808', label: '808', short: '808' },
  { id: 'rim', label: 'Rim', short: 'Rm' },
  { id: 'shaker', label: 'Shaker', short: 'Sh' },
  { id: 'fx', label: 'FX', short: 'Fx' },
]

const LOOPS: { id: LoopId; label: string; short: string }[] = [
  { id: 'drums', label: 'Drums', short: 'Dr' },
  { id: 'bass', label: 'Bass', short: 'Ba' },
  { id: 'keys', label: 'Keys', short: 'Ky' },
  { id: 'guitar', label: 'Guitar', short: 'Gt' },
  { id: 'synth', label: 'Synth', short: 'Sy' },
  { id: 'pad', label: 'Pad', short: 'Pd' },
  { id: 'lead', label: 'Lead', short: 'Ld' },
  { id: 'strings', label: 'Strings', short: 'St' },
  { id: 'brass', label: 'Brass', short: 'Br' },
  { id: 'vocal', label: 'Vocal', short: 'Vo' },
  { id: 'fx', label: 'FX', short: 'Fx' },
]

const DRUM_CATEGORY: Record<string, DrumClass> = {
  kick: { id: 'kick', sub: '' },
  snare: { id: 'snare', sub: '' },
  clap: { id: 'clap', sub: '' },
  claps: { id: 'clap', sub: '' },
  hat: { id: 'hat', sub: '' },
  'hi-hat': { id: 'hat', sub: '' },
  hihat: { id: 'hat', sub: '' },
  'hat-closed': { id: 'hat', sub: 'closed' },
  'closed-hat': { id: 'hat', sub: 'closed' },
  'closed hat': { id: 'hat', sub: 'closed' },
  'hat-open': { id: 'hat', sub: 'open' },
  'open-hat': { id: 'hat', sub: 'open' },
  'open hat': { id: 'hat', sub: 'open' },
  cymbal: { id: 'cymbal', sub: '' },
  crash: { id: 'cymbal', sub: 'crash' },
  ride: { id: 'cymbal', sub: 'ride' },
  tom: { id: 'tom', sub: '' },
  toms: { id: 'tom', sub: '' },
  perc: { id: 'perc', sub: '' },
  percussion: { id: 'perc', sub: '' },
  '808': { id: '808', sub: '' },
  '808 bass': { id: '808', sub: '' },
  rim: { id: 'rim', sub: '' },
  rimshot: { id: 'rim', sub: '' },
  shaker: { id: 'shaker', sub: '' },
  tambourine: { id: 'shaker', sub: '' },
  cowbell: { id: 'perc', sub: '' },
  fx: { id: 'fx', sub: '' },
  sfx: { id: 'fx', sub: '' },
}

/** A percussion bucket. A hat or snare named inside it still belongs on its own shelf. */
const GENERIC_DRUM = new Set(['perc', 'fx'])

const LOOP_CATEGORY: Record<string, LoopId> = {
  drum: 'drums',
  drums: 'drums',
  'drum loop': 'drums',
  'drum-loop': 'drums',
  beat: 'drums',
  beats: 'drums',
  percussion: 'drums',
  perc: 'drums',
  bass: 'bass',
  keys: 'keys',
  piano: 'keys',
  keyboard: 'keys',
  guitar: 'guitar',
  ukulele: 'guitar',
  synth: 'synth',
  synthesizer: 'synth',
  pad: 'pad',
  pads: 'pad',
  lead: 'lead',
  melody: 'lead',
  strings: 'strings',
  brass: 'brass',
  vocal: 'vocal',
  vocals: 'vocal',
  vox: 'vocal',
  choir: 'vocal',
  fx: 'fx',
  sfx: 'fx',
}

/** Search words a producer types instead of the catalog's spelling. */
const DRUM_WORDS: Record<string, string[]> = {
  hh: ['hat', 'hihat', 'hi hat', 'hi-hat'],
  hihat: ['hat', 'hihat', 'hi hat', 'hi-hat', 'hh'],
  hat: ['hat', 'hihat', 'hi hat', 'hi-hat', 'hh'],
  'hi-hat': ['hat', 'hihat', 'hi hat', 'hh'],
  hats: ['hat', 'hihat', 'hi hat'],
  snr: ['snare'],
  snare: ['snare', 'snr'],
  sd: ['snare'],
  bd: ['kick', 'bass drum'],
  kick: ['kick', 'bd', 'bass drum'],
  '808': ['808'],
}

const LOOP_WORDS: Record<string, string[]> = {
  piano: ['piano', 'keys', 'rhodes'],
  keys: ['keys', 'piano', 'rhodes', 'keyboard'],
  rhodes: ['rhodes', 'keys', 'piano'],
  vox: ['vox', 'vocal', 'choir'],
  vocal: ['vocal', 'vox', 'choir'],
  vocals: ['vocal', 'vox', 'choir'],
  drm: ['drum', 'drums'],
  drum: ['drum', 'drums'],
  drums: ['drum', 'drums'],
  lead: ['lead', 'melody'],
  melody: ['melody', 'lead'],
}

const GENRE_WORDS = ['trap', 'house', 'techno', 'dnb', 'drill', 'pop', 'rock', 'jazz', 'reggae', 'ambient', 'lo-fi', 'lofi', 'hip hop', 'hip-hop', 'rnb', 'r&b', 'afro']

export function browseBlob(entry: Pick<LibraryEntry, 'name' | 'key' | 'category' | 'instrument' | 'tags' | 'genre' | 'pack'>): string {
  return `${entry.name} ${entry.key} ${entry.category} ${entry.instrument} ${entry.tags.join(' ')} ${entry.genre.join(' ')} ${entry.pack}`
    .toLowerCase()
    .replace(/[_./]+/g, ' ')
    .replace(/-/g, ' ')
}

function word(blob: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(blob)
}

function classifyDrumText(blob: string): DrumClass | null {
  if (/closed\s*hat|hat\s*closed|closedhat|closed\s*hh|\bchh\b/.test(blob)) return { id: 'hat', sub: 'closed' }
  if (/open\s*hat|hat\s*open|openhat|open\s*hh|\bohh\b/.test(blob)) return { id: 'hat', sub: 'open' }
  if (word(blob, 'hh') || word(blob, 'hat') || word(blob, 'hats') || word(blob, 'hihat') || /hi\s*hat/.test(blob)) return { id: 'hat', sub: '' }
  if (word(blob, 'crash')) return { id: 'cymbal', sub: 'crash' }
  if (word(blob, 'ride')) return { id: 'cymbal', sub: 'ride' }
  if (word(blob, 'cymbal') || word(blob, 'china') || word(blob, 'splash')) return { id: 'cymbal', sub: '' }
  if (word(blob, 'tom') || word(blob, 'toms')) return { id: 'tom', sub: '' }
  if (word(blob, 'clap') || word(blob, 'claps') || word(blob, 'handclap')) return { id: 'clap', sub: '' }
  if (word(blob, 'rim') || word(blob, 'rimshot') || /side\s*stick|cross\s*stick/.test(blob)) return { id: 'rim', sub: '' }
  if (word(blob, 'shaker') || word(blob, 'tambourine') || word(blob, 'cabasa') || word(blob, 'maraca')) return { id: 'shaker', sub: '' }
  if (word(blob, 'cowbell') || word(blob, 'conga') || word(blob, 'bongo') || word(blob, 'clave') || word(blob, 'agogo') || word(blob, 'woodblock')) return { id: 'perc', sub: '' }
  if (word(blob, 'snare') || word(blob, 'snr') || word(blob, 'sd')) return { id: 'snare', sub: '' }
  if (word(blob, '808') || /eight\s*oh\s*eight/.test(blob)) return { id: '808', sub: '' }
  if (word(blob, 'kick') || word(blob, 'bd') || /bass\s*drum/.test(blob)) return { id: 'kick', sub: '' }
  if (word(blob, 'perc') || word(blob, 'percussion') || word(blob, 'snap')) return { id: 'perc', sub: '' }
  if (word(blob, 'fx') || word(blob, 'sfx') || word(blob, 'riser') || word(blob, 'impact') || word(blob, 'downlifter') || word(blob, 'uplifter')) return { id: 'fx', sub: '' }
  return null
}

/** A drum shelf for this one-shot, or null when it is not a drum. */
export function classifyDrum(entry: Pick<LibraryEntry, 'name' | 'key' | 'category' | 'instrument' | 'tags' | 'genre' | 'pack'>): DrumClass | null {
  const named = classifyDrumText(browseBlob({ ...entry, pack: '' }))
  const mapped = DRUM_CATEGORY[entry.category.trim().toLowerCase()]
  if (mapped && named && mapped.id !== named.id && GENERIC_DRUM.has(mapped.id) && named.id !== 'perc' && named.id !== 'fx') return named
  if (mapped?.id === 'snare' && named?.id === 'rim' && /\brim(?:shot)?\b/.test(entry.name.toLowerCase())) return named
  if (mapped) {
    if (mapped.id === 'hat' && named?.id === 'hat' && named.sub) return named
    if (mapped.id === 'cymbal' && named?.id === 'cymbal' && named.sub) return named
    if (mapped.id === 'kick' && named?.id === '808' && word(`${entry.name} ${entry.key}`.toLowerCase().replace(/[_./-]+/g, ' '), '808')) return { id: '808', sub: '' }
    return mapped
  }
  if (named) return named
  return DRUM_CATEGORY[entry.instrument.trim().toLowerCase()] ?? null
}

function classifyLoopText(blob: string): LoopId | null {
  if (/vocal\s*chop|vox\s*chop|acapella|ad\s*lib/.test(blob) || word(blob, 'vocal') || word(blob, 'vocals') || word(blob, 'vox') || word(blob, 'choir')) return 'vocal'
  if (word(blob, 'guitar') || word(blob, 'ukulele')) return 'guitar'
  if (word(blob, 'piano') || word(blob, 'rhodes') || word(blob, 'organ') || word(blob, 'keys') || word(blob, 'keyboard')) return 'keys'
  if (word(blob, 'violin') || word(blob, 'cello') || word(blob, 'strings') || word(blob, 'orchestra')) return 'strings'
  if (word(blob, 'brass') || word(blob, 'trumpet') || word(blob, 'horn') || word(blob, 'sax')) return 'brass'
  if (word(blob, 'bass') || word(blob, 'sub')) return 'bass'
  if (/drum\s*loop|\bdrums?\b|\bpercussion\b|\bbeats?\b/.test(blob)) return 'drums'
  if (word(blob, 'lead') || word(blob, 'melody') || word(blob, 'pluck')) return 'lead'
  if (word(blob, 'pad') || word(blob, 'pads')) return 'pad'
  if (word(blob, 'synth') || word(blob, 'synthesizer')) return 'synth'
  if (word(blob, 'fx') || word(blob, 'sfx') || word(blob, 'riser') || word(blob, 'impact') || word(blob, 'texture')) return 'fx'
  if (/\b(?:shaker|clave|cowbell|tambourine|conga|bongo|groove)s?\d*\b/.test(blob) || /\brough\s*mix\b/.test(blob)) return 'drums'
  if (/\b(?:ambience|ambiance|texture|drone)s?\d*\b/.test(blob)) return 'fx'
  return null
}

/** A loop shelf from the file's role. Null when the name does not say. */
export function classifyLoop(entry: Pick<LibraryEntry, 'name' | 'key' | 'category' | 'instrument' | 'tags' | 'genre' | 'pack'>): LoopId | null {
  const cat = entry.category.trim().toLowerCase()
  const mapped = LOOP_CATEGORY[cat]
  if (mapped) return mapped
  const named = classifyLoopText(browseBlob({ ...entry, pack: '' }))
  if (named) return named
  return LOOP_CATEGORY[entry.instrument.trim().toLowerCase()] ?? null
}

function includesTerm(blob: string, term: string) {
  if (term.length >= 3 || term === '808') return blob.includes(term)
  return word(blob, term)
}

export function textMatchesBrowse(blob: string, text: string, table: Record<string, string[]>) {
  const tokens = text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  return tokens.every((token) => {
    const alts = table[token] ?? [token]
    return alts.some((alt) => includesTerm(blob, alt))
  })
}

/** Keep the index hits, and add rows the index misses when the word is a drum or loop synonym. */
export function mergeBrowseHits(primary: LibraryEntry[], pool: LibraryEntry[], text: string, mode: FastMode): LibraryEntry[] {
  const trimmed = text.trim()
  if (!trimmed) return primary
  const table = mode === 'drum' ? DRUM_WORDS : LOOP_WORDS
  const seen = new Set(primary.map((entry) => entry.key))
  const out = primary.slice()
  for (const entry of pool) {
    if (seen.has(entry.key)) continue
    if (!textMatchesBrowse(browseBlob(entry), trimmed, table)) continue
    seen.add(entry.key)
    out.push(entry)
  }
  return out
}

export function entryGenres(entry: Pick<LibraryEntry, 'name' | 'key' | 'tags' | 'genre' | 'pack'>): string[] {
  const listed = entry.genre.map((genre) => genre.trim().toLowerCase()).filter(Boolean)
  if (listed.length) return [...new Set(listed)]
  const blob = `${entry.name} ${entry.key} ${entry.tags.join(' ')} ${entry.pack}`.toLowerCase().replace(/[_./-]+/g, ' ')
  const found: string[] = []
  for (const genre of GENRE_WORDS) {
    if (genre.includes(' ') ? blob.includes(genre) : word(blob, genre)) found.push(genre === 'lofi' ? 'lo-fi' : genre === 'hip-hop' ? 'hip hop' : genre)
  }
  return [...new Set(found)]
}

export function loopTempo(entry: Pick<LibraryEntry, 'name' | 'key' | 'bpm'>): number | null {
  if (entry.bpm != null && entry.bpm > 0) return entry.bpm
  return bpmFromName(`${entry.name} ${entry.key}`)
}

export function nearSongWindow(tempo: number, span = 10) {
  const center = Math.round(tempo)
  return { bpmMin: Math.max(1, center - span), bpmMax: center + span }
}

export function isNearSongTempo(bpmMin: number | null, bpmMax: number | null, tempo: number, span = 10) {
  const window = nearSongWindow(tempo, span)
  return bpmMin === window.bpmMin && bpmMax === window.bpmMax
}

/** Play a loop at the song tempo. Pitch stays put. An unknown tempo stays at the file tempo. */
export function conformPreviewTempo(
  channels: Float32Array[],
  sampleRate: number,
  sourceBpm: number | null,
  songBpm: number,
  mode: StretchMode,
): Float32Array[] {
  const lead = channels[0]
  if (!lead?.length || !(sampleRate > 0) || !sourceBpm || sourceBpm <= 0 || !(songBpm > 0)) return channels
  const ratio = sourceBpm / songBpm
  if (Math.abs(ratio - 1) < 0.015) return channels
  if (lead.length > sampleRate * 20) return channels
  const outLen = Math.max(32, Math.round(lead.length * ratio))
  try {
    return channels.map((channel) => timeStretch(channel.length === lead.length ? channel : channel.subarray(0, Math.min(channel.length, lead.length)), outLen, mode, sampleRate, 'preview'))
  } catch {
    return channels
  }
}

export function previewStretchMode(entry: Pick<LibraryEntry, 'name' | 'key' | 'category' | 'instrument' | 'tags' | 'genre' | 'pack'>): StretchMode {
  const loop = classifyLoop(entry)
  if (loop === 'drums') return 'beats'
  const drum = classifyDrum(entry)
  if (drum && drum.id !== '808') return 'beats'
  return 'pro'
}

function chipLabel(id: string) {
  if (id === 'rnb' || id === 'r&b') return 'R&B'
  if (id === 'lo-fi' || id === 'lofi') return 'Lo-fi'
  if (id === 'dnb') return 'DnB'
  if (id === 'hip hop' || id === 'hip-hop') return 'Hip hop'
  return id.replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function layout(rows: FastRow[]) {
  const offsets = new Array<number>(rows.length)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y
    y += rows[i].height
  }
  return { offsets, total: y }
}

function byName(a: LibraryEntry, b: LibraryEntry) {
  return a.name.localeCompare(b.name) || a.key.localeCompare(b.key)
}

function sortEntries(entries: LibraryEntry[], sort: FastSort, keyLabel: (entry: LibraryEntry) => string) {
  const next = entries.slice()
  next.sort((a, b) => {
    if (sort === 'bpm') {
      const ab = loopTempo(a) ?? 1e9
      const bb = loopTempo(b) ?? 1e9
      if (ab !== bb) return ab - bb
    } else if (sort === 'key') {
      const ak = keyLabel(a) || 'zzz'
      const bk = keyLabel(b) || 'zzz'
      if (ak !== bk) return ak.localeCompare(bk)
    }
    return byName(a, b)
  })
  return next
}

function head(id: string, label: string, short: string, count: number, height = FAST_HEAD): FastRow {
  return { kind: 'head', id, label, short, count, entry: null, height }
}

function soundRow(entry: LibraryEntry): FastRow {
  return { kind: 'sound', id: `sound:${entry.key}`, label: entry.name, short: '', count: 0, entry, height: FAST_ROW }
}

export function buildFastRows(options: {
  entries: LibraryEntry[]
  mode: FastMode
  category: string
  sub: DrumSub | ''
  genre: string
  sort: FastSort
  collapsed: ReadonlySet<string>
  favoriteKeys: readonly string[]
  recentKeys: readonly string[]
  keyLabel?: (entry: LibraryEntry) => string
}): FastModel {
  const keyLabel = options.keyLabel ?? (() => '')
  const classes = new Map<string, DrumClass | { id: LoopId; sub: '' } | null>()
  for (const entry of options.entries) {
    classes.set(entry.key, options.mode === 'drum' ? classifyDrum(entry) : classifyLoop(entry) ? { id: classifyLoop(entry)!, sub: '' as const } : null)
  }
  const genreOf = options.mode === 'loop' ? options.entries.map((entry) => ({ key: entry.key, genres: entryGenres(entry) })) : []
  const genreCounts = new Map<string, number>()
  for (const row of genreOf) {
    for (const genre of row.genres) genreCounts.set(genre, (genreCounts.get(genre) ?? 0) + 1)
  }
  const genres: FastChip[] = [...genreCounts.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([id, count]) => ({ id, label: chipLabel(id), short: id.slice(0, 2).toUpperCase(), count }))

  let pool = options.entries
  if (options.mode === 'loop' && options.genre) {
    const allow = new Set(genreOf.filter((row) => row.genres.includes(options.genre)).map((row) => row.key))
    pool = pool.filter((entry) => allow.has(entry.key))
  }

  const order = options.mode === 'drum' ? DRUMS : LOOPS
  const counts = new Map<string, number>()
  const subs = new Map<string, number>()
  for (const entry of pool) {
    const found = classes.get(entry.key)
    const id = found?.id ?? 'other'
    counts.set(id, (counts.get(id) ?? 0) + 1)
    if (found && 'sub' in found && found.sub) subs.set(`${found.id}:${found.sub}`, (subs.get(`${found.id}:${found.sub}`) ?? 0) + 1)
  }
  const chips: FastChip[] = []
  if (pool.length) chips.push({ id: '', label: 'All', short: 'All', count: pool.length })
  for (const item of order) {
    const count = counts.get(item.id) ?? 0
    if (count > 0) chips.push({ id: item.id, label: item.label, short: item.short, count })
  }
  if ((counts.get('other') ?? 0) > 0) chips.push({ id: 'other', label: 'Other', short: '+', count: counts.get('other') ?? 0 })

  const subChips: FastChip[] = []
  const parent = options.category
  if (parent === 'hat' || parent === 'cymbal') {
    const pairs: [string, string][] = parent === 'hat' ? [['closed', 'Closed'], ['open', 'Open']] : [['crash', 'Crash'], ['ride', 'Ride']]
    const present = pairs.filter(([id]) => (subs.get(`${parent}:${id}`) ?? 0) > 0)
    if (present.length > 1 || (present.length === 1 && (counts.get(parent) ?? 0) > (subs.get(`${parent}:${present[0][0]}`) ?? 0))) {
      subChips.push({ id: '', label: 'All', short: 'All', count: counts.get(parent) ?? 0 })
      for (const [id, label] of present) subChips.push({ id, label, short: label.slice(0, 2), count: subs.get(`${parent}:${id}`) ?? 0 })
    }
  }

  const wanted = options.category
  const narrowed = pool.filter((entry) => {
    const found = classes.get(entry.key)
    const id = found?.id ?? 'other'
    if (wanted && id !== wanted) return false
    if (options.sub && found && 'sub' in found && found.sub !== options.sub) return false
    if (options.sub && (!found || !('sub' in found) || !found.sub)) return false
    return true
  })
  const sort = options.mode === 'loop' ? options.sort : 'name'
  const favoriteSet = new Set(options.favoriteKeys)
  const recentSet = new Set(options.recentKeys.filter((key) => !favoriteSet.has(key)))
  const favorites = sortEntries(narrowed.filter((entry) => favoriteSet.has(entry.key)), sort, keyLabel)
  const recents = sortEntries(narrowed.filter((entry) => recentSet.has(entry.key)), sort, keyLabel)
  const restKeys = new Set([...favoriteSet, ...recentSet])
  const rest = sortEntries(narrowed.filter((entry) => !restKeys.has(entry.key)), sort, keyLabel)

  const rows: FastRow[] = []
  const pushGroup = (id: string, label: string, short: string, entries: LibraryEntry[], letters: boolean, bare = false) => {
    if (!entries.length) return
    if (!bare) {
      rows.push(head(id, label, short, entries.length))
      if (options.collapsed.has(id)) return
    }
    if (!letters) {
      for (const entry of entries) rows.push(soundRow(entry))
      return
    }
    let letter = ''
    for (const entry of entries) {
      const next = (entry.name.trim()[0] || '#').toUpperCase()
      const bucket = /[A-Z]/.test(next) ? next : '#'
      if (bucket !== letter) {
        letter = bucket
        const count = entries.filter((item) => ((item.name.trim()[0] || '#').toUpperCase() === bucket) || (bucket === '#' && !/[A-Z]/.test((item.name.trim()[0] || '#').toUpperCase()))).length
        const letterId = `${id}:letter:${bucket}`
        rows.push(head(letterId, bucket, bucket, count, 28))
        if (options.collapsed.has(letterId)) continue
      }
      if (options.collapsed.has(`${id}:letter:${letter}`)) continue
      rows.push(soundRow(entry))
    }
  }

  pushGroup('favorites', 'Favorites', '★', favorites, false)
  pushGroup('recents', 'Recents', '↺', recents, false)

  const letters = Boolean(wanted) && rest.length >= 8
  if (!wanted) {
    for (const item of order) {
      const entries = rest.filter((entry) => (classes.get(entry.key)?.id ?? 'other') === item.id)
      pushGroup(item.id, item.label, item.short, entries, false)
    }
    pushGroup('other', 'Other', '+', rest.filter((entry) => !classes.get(entry.key)), false)
  } else {
    const meta = order.find((item) => item.id === wanted)
    const label = meta?.label ?? 'Other'
    const short = meta?.short ?? '+'
    pushGroup(wanted, label, short, rest, letters, true)
  }

  const { offsets, total } = layout(rows)
  const jump = rows.filter((row) => row.kind === 'head' && !row.id.includes(':letter:')).map((row) => ({ id: row.id, short: row.short, label: row.label }))
  const letterJump = rows.filter((row) => row.kind === 'head' && row.id.includes(':letter:')).map((row) => ({ id: row.id, short: row.short, label: row.label }))
  return {
    rows,
    offsets,
    total,
    chips,
    subs: subChips,
    genres,
    jump: letterJump.length > 1 ? letterJump : jump,
    sounds: narrowed.length,
  }
}

/** First and last indexes whose boxes intersect the viewport, with a little extra above and below. */
export function fastVisibleRange(offsets: readonly number[], heights: readonly number[], scrollTop: number, viewHeight: number) {
  const count = offsets.length
  if (!count) return { start: 0, end: 0 }
  const view = viewHeight > 0 ? viewHeight : 640
  const top = Math.max(0, scrollTop - 280)
  const bottom = scrollTop + view + 280
  let start = 0
  let lo = 0
  let hi = count - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] < top) {
      start = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  let end = start
  while (end < count && offsets[end] < bottom) end += 1
  if (end < count && offsets[end] + (heights[end] ?? 0) > top) end += 1
  return { start, end: Math.min(count, Math.max(end, start + 1)) }
}

export function fastOffsetForId(rows: readonly FastRow[], offsets: readonly number[], id: string) {
  const index = rows.findIndex((row) => row.id === id || (row.entry && `sound:${row.entry.key}` === id))
  if (index < 0) return -1
  return offsets[index] ?? 0
}

export function fastSounds(rows: readonly FastRow[]): LibraryEntry[] {
  const out: LibraryEntry[] = []
  for (const row of rows) if (row.entry) out.push(row.entry)
  return out
}

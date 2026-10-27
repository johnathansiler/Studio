/** Local sound catalog, search, and cache plan. No network calls live here. */

import { allowedLibraryHost, downloadParts, HOST_PART_LIMIT, partCount } from './libraryHost'
import { starterLoom } from './loom'

export type SoundType = 'instrument' | 'loop' | 'one-shot' | 'kit' | 'preset' | 'ir'
export type SoundSort = 'relevance' | 'name' | 'newest' | 'used'
export type TagGroup = 'type' | 'category' | 'genre' | 'character' | 'key' | 'pack'

export interface SoundEntry {
  id: string
  name: string
  type: SoundType
  category: string
  genres: string[]
  character: string[]
  key: string | null
  bpm: number | null
  pack: string
  instrument: string
  bytes: number
  /** synth and generated stay on device. Remote rows arrive only from a licensed manifest. */
  origin: 'synth' | 'generated' | 'import' | 'remote'
  addedAt: number
  bufferId?: string
  /** Direct free-host parts. Empty until a licensed manifest names them. */
  urls?: string[]
}

export interface SoundPersonal {
  favorite: string[]
  recent: string[]
  uses: Record<string, number>
  userTags: Record<string, string[]>
  collections: { id: string; name: string; ids: string[] }[]
  imports: SoundEntry[]
  cached: string[]
}

export interface SoundQuery {
  text: string
  groups: Partial<Record<TagGroup, string[]>>
  bpmMin: number | null
  bpmMax: number | null
  musicalKey: string | null
  matchProject: boolean
  projectBpm: number
  projectKey: string | null
  sort: SoundSort
  favoritesOnly: boolean
  collectionId: string | null
}

export interface ManifestRow {
  id: string
  name: string
  license: string
  url: string
  bytes: number
  /** Direct part URLs when the file is larger than the host limit. */
  parts?: string[]
}

const GROUPS: TagGroup[] = ['type', 'category', 'genre', 'character', 'key', 'pack']

const SYNONYMS: { word: string; alts: string[] }[] = [
  { word: 'keys', alts: ['piano', 'ep', 'organ', 'rhodes', 'keyboard'] },
  { word: 'kick', alts: ['bass drum', 'kick drum'] },
  { word: 'hat', alts: ['hihat', 'hi-hat'] },
  { word: 'snare', alts: ['snr'] },
  { word: 'vox', alts: ['vocal', 'choir', 'voice'] },
  { word: 'pad', alts: ['atmosphere', 'texture'] },
  { word: 'bass', alts: ['sub', '808'] },
  { word: 'guitar', alts: ['gtr', 'pluck'] },
]

const PITCH = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function emptySounds(): SoundPersonal {
  return { favorite: [], recent: [], uses: {}, userTags: {}, collections: [], imports: [], cached: [] }
}

export function emptyQuery(projectBpm = 120, projectKey: string | null = 'C'): SoundQuery {
  return {
    text: '',
    groups: {},
    bpmMin: null,
    bpmMax: null,
    musicalKey: null,
    matchProject: false,
    projectBpm,
    projectKey,
    sort: 'relevance',
    favoritesOnly: false,
    collectionId: null,
  }
}

export interface SoundIndex {
  entries: SoundEntry[]
  ids: Map<string, number>
  tokens: Map<string, number[]>
  buckets: Map<string, string[]>
}

export function buildIndex(entries: SoundEntry[]): SoundIndex {
  const tokens = new Map<string, number[]>()
  const ids = new Map<string, number>()
  const add = (token: string, index: number) => {
    if (!token) return
    const list = tokens.get(token)
    if (list) {
      if (list[list.length - 1] !== index) list.push(index)
      return
    }
    tokens.set(token, [index])
  }
  entries.forEach((entry, index) => {
    ids.set(entry.id, index)
    const own = entryTokens(entry)
    for (const token of own) add(token, index)
    for (const row of SYNONYMS) {
      if (row.alts.some((alt) => hasPhrase(own, alt))) add(row.word, index)
      if (own.includes(row.word)) for (const alt of row.alts) for (const part of tokenize(alt)) add(part, index)
    }
  })
  const buckets = new Map<string, string[]>()
  for (const token of tokens.keys()) {
    if (token.length < 4 || token.length > 18) continue
    const key = `${token.length}:${token[0]}`
    const list = buckets.get(key) ?? []
    list.push(token)
    buckets.set(key, list)
  }
  return { entries, ids, tokens, buckets }
}

export function searchSounds(index: SoundIndex, query: SoundQuery, personal: SoundPersonal) {
  const text = normalize(query.text)
  const words = tokenize(text)
  const scored = new Map<number, number>()
  if (!words.length) {
    index.entries.forEach((_, index) => scored.set(index, 1))
  } else {
    const wanted = new Set<string>(words)
    for (const word of words) {
      for (const row of SYNONYMS) {
        if (row.word === word) for (const alt of row.alts) for (const part of tokenize(alt)) wanted.add(part)
        if (tokenize(row.alts.join(' ')).includes(word) || row.alts.some((alt) => alt === word)) wanted.add(row.word)
      }
    }
    for (const token of wanted) {
      const hits = index.tokens.get(token)
      if (!hits) continue
      const synonym = !words.includes(token)
      for (const id of hits) scored.set(id, (scored.get(id) ?? 0) + (synonym ? 3 : 5))
    }
    for (const word of words) {
      if (word.length < 4) continue
      for (const token of typoCandidates(index, word)) {
        if (token === word) continue
        for (const id of index.tokens.get(token) ?? []) scored.set(id, (scored.get(id) ?? 0) + 1)
      }
    }
    for (const [soundId, tags] of Object.entries(personal.userTags)) {
      const at = index.ids.get(soundId)
      if (at == null) continue
      const tagTokens = tags.flatMap((tag) => tokenize(tag))
      if (words.some((word) => tagTokens.includes(word))) scored.set(at, (scored.get(at) ?? 0) + 5)
    }
    for (const [id, score] of scored) {
      const name = normalize(index.entries[id].name)
      if (name === text) scored.set(id, score + 20)
      else if (words.every((word) => name.includes(word))) scored.set(id, score + 6)
    }
  }
  const rows = [...scored.entries()]
    .filter(([id]) => matchFilters(index.entries[id], query, personal))
    .map(([id, score]) => ({ entry: index.entries[id], score }))
  rows.sort((a, b) => compareSounds(a, b, query, personal))
  return rows.map((row) => row.entry)
}

/** Selected tags in one group must all match. A hit in any active group is enough. */
export function matchFilters(entry: SoundEntry, query: SoundQuery, personal: SoundPersonal) {
  const active = GROUPS.filter((group) => (query.groups[group]?.length ?? 0) > 0)
  if (active.length) {
    const hit = active.some((group) => query.groups[group]!.every((value) => hasGroupValue(entry, personal, group, value)))
    if (!hit) return false
  }
  const bpmMin = query.matchProject ? query.projectBpm - 5 : query.bpmMin
  const bpmMax = query.matchProject ? query.projectBpm + 5 : query.bpmMax
  const key = query.matchProject ? query.projectKey : query.musicalKey
  if (bpmMin != null || bpmMax != null || key) {
    if (entry.type !== 'loop') return false
    if (bpmMin != null && (entry.bpm == null || entry.bpm < bpmMin)) return false
    if (bpmMax != null && (entry.bpm == null || entry.bpm > bpmMax)) return false
    if (key && pitchClass(entry.key) !== pitchClass(key)) return false
  }
  if (query.favoritesOnly && !personal.favorite.includes(entry.id)) return false
  if (query.collectionId) {
    const collection = personal.collections.find((item) => item.id === query.collectionId)
    if (!collection?.ids.includes(entry.id)) return false
  }
  return true
}

export function tagCounts(index: SoundIndex, query: SoundQuery, personal: SoundPersonal) {
  const rows = searchSounds(index, { ...query, groups: {} }, personal)
  const counts = new Map<string, number>()
  for (const entry of rows) {
    for (const group of GROUPS) {
      for (const value of groupValues(entry, personal, group)) {
        const key = `${group}:${value}`
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return counts
}

export function encodePersonal(personal: SoundPersonal) {
  return JSON.stringify(personal)
}

export function decodePersonal(raw: string | null): SoundPersonal {
  if (!raw) return emptySounds()
  try {
    const parsed = JSON.parse(raw) as Partial<SoundPersonal>
    return {
      favorite: parsed.favorite ?? [],
      recent: parsed.recent ?? [],
      uses: parsed.uses ?? {},
      userTags: parsed.userTags ?? {},
      collections: parsed.collections ?? [],
      imports: parsed.imports ?? [],
      cached: parsed.cached ?? [],
    }
  } catch {
    return emptySounds()
  }
}

export function withUserTag(personal: SoundPersonal, id: string, tag: string): SoundPersonal {
  const clean = normalize(tag).replace(/\s+/g, ' ').trim()
  if (!clean) return personal
  const tags = personal.userTags[id] ?? []
  if (tags.includes(clean)) return personal
  return { ...personal, userTags: { ...personal.userTags, [id]: [...tags, clean] } }
}

export function withoutUserTag(personal: SoundPersonal, id: string, tag: string): SoundPersonal {
  const tags = (personal.userTags[id] ?? []).filter((item) => item !== tag)
  return { ...personal, userTags: { ...personal.userTags, [id]: tags } }
}

export function toggleFavorite(personal: SoundPersonal, id: string): SoundPersonal {
  const on = personal.favorite.includes(id)
  return { ...personal, favorite: on ? personal.favorite.filter((item) => item !== id) : [...personal.favorite, id] }
}

export function noteUse(personal: SoundPersonal, id: string): SoundPersonal {
  return {
    ...personal,
    uses: { ...personal.uses, [id]: (personal.uses[id] ?? 0) + 1 },
    recent: [id, ...personal.recent.filter((item) => item !== id)].slice(0, 40),
  }
}

export function addToCollection(personal: SoundPersonal, collectionId: string, soundId: string): SoundPersonal {
  return {
    ...personal,
    collections: personal.collections.map((collection) => collection.id === collectionId && !collection.ids.includes(soundId)
      ? { ...collection, ids: [...collection.ids, soundId] }
      : collection),
  }
}

export function previewRate(entryBpm: number | null, entryKey: string | null, projectBpm: number, projectKey: string | null) {
  const tempo = entryBpm && entryBpm > 0 ? projectBpm / entryBpm : 1
  const from = pitchClass(entryKey)
  const to = pitchClass(projectKey)
  const semis = from == null || to == null ? 0 : ((to - from + 12) % 12)
  const lifted = semis > 6 ? semis - 12 : semis
  return tempo * 2 ** (lifted / 12)
}

export function renderPreview(entry: SoundEntry, sampleRate: number) {
  const seconds = entry.type === 'loop' ? 2 : entry.type === 'ir' ? 0.6 : 0.35
  const frames = Math.max(32, Math.floor(sampleRate * seconds))
  const out = new Float32Array(frames)
  const freq = 440 * 2 ** (((pitchClass(entry.key) ?? 0) - 9) / 12)
  const bpm = entry.bpm ?? 120
  const period = Math.max(1, Math.round(sampleRate * 60 / bpm))
  for (let i = 0; i < frames; i++) {
    const env = entry.type === 'one-shot' || entry.type === 'ir' ? Math.exp(-i / (sampleRate * 0.12)) : 0.6 + 0.4 * (i % period < period * 0.08 ? 1 : 0.2)
    const tone = Math.sin(2 * Math.PI * freq * (i / sampleRate))
    out[i] = tone * env * 0.25
  }
  return out
}

export function fitBuffer(samples: Float32Array, rate: number) {
  if (Math.abs(rate - 1) < 0.001) return samples
  const frames = Math.max(32, Math.floor(samples.length / Math.max(0.25, rate)))
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const pos = i * rate
    const at = Math.floor(pos)
    const frac = pos - at
    const left = samples[at] ?? 0
    const right = samples[Math.min(samples.length - 1, at + 1)] ?? 0
    out[i] = left + (right - left) * frac
  }
  return out
}

export function fitPreview(entry: SoundEntry, sampleRate: number, projectBpm: number, projectKey: string | null) {
  const raw = renderPreview(entry, sampleRate)
  const rate = entry.type === 'loop' ? previewRate(entry.bpm, entry.key, projectBpm, projectKey) : 1
  return fitBuffer(raw, rate)
}

export function rememberImport(name: string, bufferId: string, bytes: number, heard: ReturnType<typeof analyzeSound>): SoundEntry {
  return entry({
    id: bufferId,
    name: name.replace(/\.[^.]+$/, ''),
    type: heard.type,
    category: heard.category,
    key: heard.key,
    bpm: heard.type === 'loop' ? heard.bpm : null,
    pack: 'Imports',
    instrument: heard.category,
    origin: 'import',
    bytes,
    bufferId,
    addedAt: Date.now(),
  })
}

/** BPM from the energy envelope, key from the strongest pitch class, and loop vs one-shot from length. */
export function analyzeSound(samples: Float32Array, sampleRate: number) {
  const bpm = detectBpm(samples, sampleRate)
  const key = detectKey(samples, sampleRate)
  const seconds = samples.length / sampleRate
  const type: 'loop' | 'one-shot' = seconds >= 1.2 && bpm != null ? 'loop' : 'one-shot'
  const centroid = spectralCentroid(samples, sampleRate)
  const category = centroid < 400 ? 'bass' : centroid > 2500 ? 'drums' : 'keys'
  return { bpm, key, type, category }
}

const CLEAR_LICENSE = /^(cc0|cc-by|cc-by-sa|public domain|public-domain|mit|bsd|bsd-2-clause|bsd-3-clause)$/i
const NON_COMMERCIAL = /non-?commercial|\bnc\b/i

/** Keep a manifest row only when the license is clear and every part is a direct free-host file. */
export function takeManifest(rows: ManifestRow[]) {
  const ok: ManifestRow[] = []
  const rejected: string[] = []
  for (const row of rows) {
    const license = row.license.trim()
    const urls = row.parts?.length ? row.parts : [row.url]
    const tooBig = row.bytes > HOST_PART_LIMIT && urls.length < partCount(row.bytes)
    if (!license || NON_COMMERCIAL.test(license) || !CLEAR_LICENSE.test(license) || tooBig || urls.some((url) => !allowedLibraryHost(url))) {
      rejected.push(row.id)
      continue
    }
    ok.push(row)
  }
  return { ok, rejected }
}

export interface MemoryCache {
  files: Map<string, Uint8Array>
  put(id: string, data: Uint8Array): void
  has(id: string): boolean
  delete(id: string): void
  bytes(): number
}

export function memoryCache(): MemoryCache {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    put(id, data) { files.set(id, data) },
    has(id) { return files.has(id) },
    delete(id) { files.delete(id) },
    bytes() {
      let total = 0
      for (const data of files.values()) total += data.byteLength
      return total
    },
  }
}

export async function cacheRemote(row: ManifestRow, fetchImpl: typeof fetch, cache: MemoryCache) {
  const accepted = takeManifest([row])
  if (!accepted.ok.length) throw new Error('refused')
  const data = await downloadParts(row.parts?.length ? row.parts : [row.url], fetchImpl)
  cache.put(row.id, data)
  return data.byteLength
}

export function catalog(): SoundEntry[] {
  const rows: SoundEntry[] = []
  const loom = starterLoom()
  for (const instrument of loom.instruments) {
    rows.push(entry({
      id: instrument.id,
      name: instrument.name,
      type: 'instrument',
      category: 'strings',
      genres: ['cinematic'],
      character: ['warm'],
      pack: 'Loom',
      instrument: instrument.name,
      origin: 'synth',
    }))
  }
  for (const patch of loom.patches) {
    rows.push(entry({
      id: patch.id,
      name: patch.name,
      type: 'preset',
      category: 'synth',
      genres: ['cinematic'],
      character: ['evolving', 'warm'],
      pack: 'Loom',
      instrument: 'pad',
      origin: 'synth',
    }))
  }
  rows.push(
    entry({ id: 'concert-piano', name: 'Concert Piano', type: 'instrument', category: 'keys', genres: ['cinematic'], character: ['warm', 'bright'], key: 'C', pack: 'Loom', instrument: 'piano', origin: 'synth' }),
    entry({ id: 'suitcase-ep', name: 'Suitcase EP', type: 'instrument', category: 'keys', genres: ['r&b'], character: ['warm'], key: 'A', pack: 'Loom', instrument: 'ep', origin: 'synth' }),
    entry({ id: 'chapel-organ', name: 'Chapel Organ', type: 'instrument', category: 'keys', genres: ['gospel'], character: ['airy'], key: 'F', pack: 'Loom', instrument: 'organ', origin: 'synth' }),
    entry({ id: 'bass-drum', name: 'Bass Drum', type: 'one-shot', category: 'drums', genres: ['trap'], character: ['punchy', 'dark'], pack: 'Loom', instrument: 'bass drum', origin: 'generated', bytes: 48_000 }),
    entry({ id: 'room-ir', name: 'Room Impulse', type: 'ir', category: 'space', genres: ['cinematic'], character: ['airy'], pack: 'Loom', instrument: 'impulse', origin: 'generated', bytes: 96_000 }),
    entry({ id: 'pocket-kit', name: 'Pocket Kit', type: 'kit', category: 'drums', genres: ['lo-fi'], character: ['gritty'], pack: 'Loom', instrument: 'kit', origin: 'synth' }),
    entry({ id: 'dust-loop', name: 'Dust Loop', type: 'loop', category: 'drums', genres: ['lo-fi'], character: ['dusty', 'warm'], key: 'F#', bpm: 86, pack: 'Loom', instrument: 'drums', origin: 'generated', bytes: 384_000 }),
    entry({ id: 'pocket-loop', name: 'Pocket Loop', type: 'loop', category: 'drums', genres: ['r&b'], character: ['warm'], key: 'Am', bpm: 96, pack: 'Loom', instrument: 'drums', origin: 'generated', bytes: 420_000 }),
    entry({ id: 'noon-loop', name: 'Noon Loop', type: 'loop', category: 'drums', genres: ['pop'], character: ['bright'], key: 'C', bpm: 120, pack: 'Loom', instrument: 'drums', origin: 'generated', bytes: 460_000 }),
    entry({ id: 'night-loop', name: 'Night Loop', type: 'loop', category: 'drums', genres: ['trap'], character: ['dark', 'punchy'], key: 'Dm', bpm: 140, pack: 'Loom', instrument: 'drums', origin: 'generated', bytes: 512_000 }),
  )
  const colors = ['Glass', 'Night', 'Silver', 'Amber', 'Soft', 'Hollow', 'Bright', 'Velvet', 'Crystal', 'Slow']
  const kinds: { noun: string; category: string; character: string[]; genres: string[]; instrument: string }[] = [
    { noun: 'Pad', category: 'synth', character: ['warm', 'evolving'], genres: ['cinematic'], instrument: 'pad' },
    { noun: 'Atmosphere', category: 'synth', character: ['airy', 'evolving'], genres: ['cinematic'], instrument: 'atmosphere' },
    { noun: 'Lead', category: 'synth', character: ['bright'], genres: ['pop'], instrument: 'lead' },
    { noun: 'Bass', category: 'bass', character: ['dark', 'gritty'], genres: ['trap'], instrument: 'bass' },
    { noun: 'Texture', category: 'synth', character: ['evolving'], genres: ['lo-fi'], instrument: 'texture' },
    { noun: 'Hit', category: 'cinematic', character: ['punchy', 'dark'], genres: ['cinematic'], instrument: 'hit' },
    { noun: 'Keys', category: 'keys', character: ['warm'], genres: ['r&b'], instrument: 'piano' },
    { noun: 'Pluck', category: 'guitar', character: ['bright'], genres: ['pop'], instrument: 'guitar' },
    { noun: 'Choir', category: 'vox', character: ['airy'], genres: ['cinematic'], instrument: 'choir' },
    { noun: 'Mallet', category: 'mallets', character: ['bright'], genres: ['lo-fi'], instrument: 'mallet' },
  ]
  colors.forEach((color, colorAt) => {
    kinds.forEach((kind, kindAt) => {
      rows.push(entry({
        id: `loom-${color}-${kind.noun}`.toLowerCase(),
        name: `${color} ${kind.noun}`,
        type: 'preset',
        category: kind.category,
        genres: kind.genres,
        character: kind.character,
        pack: 'Loom',
        instrument: kind.instrument,
        origin: 'synth',
        addedAt: 1_700_000_000_000 + colorAt * 100 + kindAt,
      }))
    })
  })
  return rows
}

export function entry(partial: Partial<SoundEntry> & Pick<SoundEntry, 'id' | 'name' | 'type' | 'category' | 'pack' | 'instrument' | 'origin'>): SoundEntry {
  return {
    genres: [],
    character: [],
    key: null,
    bpm: null,
    addedAt: 1_700_000_000_000,
    ...partial,
    bytes: partial.bytes ?? 0,
  }
}

function entryTokens(entry: SoundEntry) {
  return tokenize([
    entry.name,
    entry.type,
    entry.category,
    entry.pack,
    entry.instrument,
    entry.key ?? '',
    ...entry.genres,
    ...entry.character,
  ].join(' '))
}

function hasGroupValue(entry: SoundEntry, personal: SoundPersonal, group: TagGroup, value: string) {
  return groupValues(entry, personal, group).includes(normalize(value))
}

export function groupValues(entry: SoundEntry, personal: SoundPersonal, group: TagGroup) {
  if (group === 'type') return [entry.type]
  if (group === 'category') return [normalize(entry.category)]
  if (group === 'genre') return entry.genres.map(normalize)
  if (group === 'character') return [...entry.character, ...(personal.userTags[entry.id] ?? [])].map(normalize)
  if (group === 'key') return entry.key ? [normalize(entry.key)] : []
  return [normalize(entry.pack)]
}

function compareSounds(a: { entry: SoundEntry; score: number }, b: { entry: SoundEntry; score: number }, query: SoundQuery, personal: SoundPersonal) {
  if (query.sort === 'name') return a.entry.name.localeCompare(b.entry.name) || b.score - a.score
  if (query.sort === 'newest') return b.entry.addedAt - a.entry.addedAt || b.score - a.score
  if (query.sort === 'used') return (personal.uses[b.entry.id] ?? 0) - (personal.uses[a.entry.id] ?? 0) || b.score - a.score
  return b.score - a.score || a.entry.name.localeCompare(b.entry.name)
}

function typoCandidates(index: SoundIndex, word: string) {
  const found: string[] = []
  for (const length of [word.length - 1, word.length, word.length + 1]) {
    if (length < 4) continue
    const list = index.buckets.get(`${length}:${word[0]}`) ?? []
    for (const token of list) if (editWithin1(word, token)) found.push(token)
  }
  return found
}

function editWithin1(a: string, b: string) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) {
    let edits = 0
    let transpose = false
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue
      edits += 1
      if (edits > 2) return false
      if (i + 1 < a.length && a[i] === b[i + 1] && a[i + 1] === b[i]) transpose = true
    }
    return edits === 1 || (edits === 2 && transpose)
  }
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  let i = 0
  let j = 0
  let skipped = false
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) {
      i += 1
      j += 1
      continue
    }
    if (skipped) return false
    skipped = true
    j += 1
  }
  return true
}

function hasPhrase(tokens: string[], phrase: string) {
  const parts = tokenize(phrase)
  if (!parts.length) return false
  if (parts.length === 1) return tokens.includes(parts[0])
  return tokens.join(' ').includes(parts.join(' '))
}

function detectBpm(samples: Float32Array, sampleRate: number) {
  const hop = Math.max(1, Math.round(sampleRate / 100))
  const env: number[] = []
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0
    for (let n = 0; n < hop; n++) sum += Math.abs(samples[i + n])
    env.push(sum / hop)
  }
  if (env.length < 50) return null
  let mean = 0
  for (const value of env) mean += value
  mean /= env.length
  const minLag = Math.round(100 * 60 / 180)
  const maxLag = Math.min(env.length - 1, Math.round(100 * 60 / 60))
  let bestLag = 0
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0
    for (let i = 0; i + lag < env.length; i++) score += (env[i] - mean) * (env[i + lag] - mean)
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (!bestLag || best <= 0) return null
  return Math.round(60 / (bestLag / 100))
}

function detectKey(samples: Float32Array, sampleRate: number) {
  const n = Math.min(samples.length, 8192)
  if (n < 256) return null
  const view = samples.subarray(0, n)
  let best = 0
  let bestAt = 0
  for (let pc = 0; pc < 12; pc++) {
    let power = 0
    for (let octave = 3; octave <= 6; octave++) {
      const midi = octave * 12 + pc
      const freq = 440 * 2 ** ((midi - 69) / 12)
      power += goertzel(view, sampleRate, freq)
    }
    if (power > best) {
      best = power
      bestAt = pc
    }
  }
  return best > 0 ? PITCH[bestAt] : null
}

function goertzel(samples: Float32Array, sampleRate: number, freq: number) {
  const n = samples.length
  const k = Math.round((n * freq) / sampleRate)
  const w = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = samples[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function spectralCentroid(samples: Float32Array, sampleRate: number) {
  const n = Math.min(samples.length, 2048)
  let mag = 0
  let weighted = 0
  for (let bin = 1; bin < 48; bin++) {
    const freq = (bin * sampleRate) / n
    const power = goertzel(samples.subarray(0, n), sampleRate, freq)
    mag += power
    weighted += freq * power
  }
  return mag > 0 ? weighted / mag : 1000
}

function pitchClass(key: string | null) {
  if (!key) return null
  const name = key.replace(/m$/, '').replace('♭', 'b').replace('♯', '#')
  const map: Record<string, number> = { C: 0, 'C#': 1, DB: 1, D: 2, 'D#': 3, EB: 3, E: 4, F: 5, 'F#': 6, GB: 6, G: 7, 'G#': 8, AB: 8, A: 9, 'A#': 10, BB: 10, B: 11 }
  const cleaned = name.length > 1 && name[1] === 'b' ? `${name[0].toUpperCase()}B` : name[0].toUpperCase() + name.slice(1)
  return map[cleaned] ?? null
}

function tokenize(value: string) {
  return normalize(value).split(/[^a-z0-9#&]+/).filter((token) => token.length > 1 || token === 'a')
}

function normalize(value: string) {
  return value.toLowerCase().replace(/[_/]+/g, ' ').replace(/\s+/g, ' ').trim()
}

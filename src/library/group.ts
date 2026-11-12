/**
 * Turn private-library multisample notes into one instrument per patch.
 * Note, velocity, round-robin, and duration tokens come off the filename.
 * Articulation words stay, so Normal and Staccato are different instruments.
 * Dynamics stay on the instrument as velocity layers.
 */
import { parseLooseName } from './looseName.ts'

export interface InstrumentLayer {
  key: string
  midi: number
  velLo: number
  velHi: number
  rr: number
  release: boolean
  size: number
}

export interface LibraryInstrument {
  id: string
  name: string
  pack: string
  category: string
  folder: string
  /** Lowest sampled root, not the filled keyboard. */
  lo: number
  /** Highest sampled root. */
  hi: number
  notes: number
  samples: number
  velocities: number
  roundRobins: number
  previewKey: string
  previewMidi: number
  layers: InstrumentLayer[]
}

export interface InstrumentQuery {
  text: string
  category: string
  pack: string
  offset: number
  limit: number
}

export interface InstrumentPage {
  total: number
  offset: number
  limit: number
  instruments: LibraryInstrumentSummary[]
}

export type LibraryInstrumentSummary = Omit<LibraryInstrument, 'layers'>

interface CatalogRow {
  key: string
  size: number
  pack: string
  type: string
  category: string
  note: string
  root: string
}

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

/** Higher rank is louder. Numeric layers use their own number, above these names. */
const DYNAMICS: Record<string, number> = {
  ppp: 10,
  pp: 20,
  pianissimo: 20,
  p: 30,
  piano: 30,
  mp: 40,
  'mezzo-piano': 40,
  mf: 50,
  'mezzo-forte': 50,
  f: 60,
  forte: 60,
  ff: 70,
  fortissimo: 70,
  fff: 80,
}

const DURATION_WORD: Record<string, number> = {
  'very-long': 100,
  long: 80,
  phrase: 55,
  short: 30,
}

const DURATION_NUMBER: Record<string, number> = {
  '15': 70,
  '05': 40,
  '5': 40,
  '1': 20,
  '025': 10,
}

const RELEASE_WORD = new Set(['release', 'releases', 'rel'])
const NOISE_WORD = new Set(['pb', 'loop', 'looped', 'loops', 'stereo', 'mono', 'free', 'ed', 'wav', 'flac', 'aif', 'aiff', 'sp'])
const GENERIC_DIR = /^(samples?|notes?|wavs?|flacs?|aiffs?|instruments?|multis?|individual|mappings?|programs?|data|audio|libs?)$/i
const BUCKET_DIR = new Set(['instruments', 'orchestral', 'melodic one-shots', 'drums', 'sfx', 'loops', 'one-shots', 'samples'])

const ART_LABEL: Record<string, string> = {
  normal: 'Normal',
  staccato: 'Staccato',
  staccatissimo: 'Staccatissimo',
  stac: 'Staccato',
  pizzicato: 'Pizzicato',
  pizz: 'Pizzicato',
  tremolo: 'Tremolo',
  legato: 'Legato',
  nonlegato: 'Non Legato',
  sustain: 'Sustain',
  sus: 'Sustain',
  mute: 'Mute',
  ord: 'Ordinary',
  rel: 'Release',
  release: 'Release',
  hammer: 'Hammer',
  twang: 'Twang',
  spiccato: 'Spiccato',
  pizzicatoVib: 'Pizzicato Vib',
}

type Token =
  | { kind: 'note'; midi: number }
  | { kind: 'vel'; id: string; rank: number }
  | { kind: 'rr'; n: number }
  | { kind: 'duration'; rank: number }
  | { kind: 'release' }
  | { kind: 'noise' }
  | { kind: 'word'; raw: string }
  | { kind: 'num'; n: number; raw: string }

interface RawSample {
  key: string
  size: number
  category: string
  midi: number | null
  /** Pitch class when the file name has no octave. The folder supplies the octave later. */
  pitchClass: number | null
  velocityId: string
  velocityRank: number
  rr: number | null
  release: boolean
  durationRank: number
  nameTokens: string[]
  looseNumbers: number[]
  /** A one-shot whose name is a note. A single file stays a row; two or more become one instrument. */
  looseFile: boolean
}

export function noteMidi(token: string): number | null {
  const match = token.trim().match(/^([a-g])([#b]|s)?(-1|\d+)$/i)
  if (!match) return null
  let semi = PITCH[match[1].toLowerCase()]
  if (semi == null) return null
  const accidental = (match[2] || '').toLowerCase()
  if (accidental === '#' || accidental === 's') semi += 1
  if (accidental === 'b') semi -= 1
  const midi = (Number(match[3]) + 1) * 12 + semi
  if (midi < 0 || midi > 127) return null
  return midi
}

export function midiName(midi: number) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const clamped = Math.max(0, Math.min(127, Math.round(midi)))
  const octave = Math.floor(clamped / 12) - 1
  return `${names[clamped % 12]}${octave}`
}

function pitchClass(midi: number) {
  return ((Math.round(midi) % 12) + 12) % 12
}

/** Filename stem → tokens. Separators are `_`, spaces, and hyphens that introduce a note. */
export function tokenizeStem(stem: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < stem.length) {
    const rest = stem.slice(i)
    if (/^[_\s.]+/.test(rest)) {
      i += 1
      continue
    }
    const glued = rest.match(/^[A-Ga-g](?:#|b|s)?(?:-1|\d+)v\d{1,2}/i)
    if (glued) {
      const parts = glued[0].match(/^([A-Ga-g](?:#|b|s)?(?:-1|\d+))v(\d{1,2})/i)!
      const midi = noteMidi(parts[1])
      if (midi != null) tokens.push({ kind: 'note', midi })
      const layer = Number(parts[2])
      tokens.push({ kind: 'vel', id: `v${layer}`, rank: 100 + layer })
      i += glued[0].length
      continue
    }
    const rr = rest.match(/^rr(\d{1,2})/i)
    if (rr) {
      tokens.push({ kind: 'rr', n: Number(rr[1]) })
      i += rr[0].length
      continue
    }
    const vl = rest.match(/^vl(\d{1,2})/i)
    if (vl) {
      const layer = Number(vl[1])
      tokens.push({ kind: 'vel', id: `v${layer}`, rank: 100 + layer })
      i += vl[0].length
      continue
    }
    const vel = rest.match(/^v(\d{1,2})(?!\d)/i)
    if (vel && (i === 0 || /[_\s-]/.test(stem[i - 1] || ''))) {
      const layer = Number(vel[1])
      tokens.push({ kind: 'vel', id: `v${layer}`, rank: 100 + layer })
      i += vel[0].length
      continue
    }
    const level = rest.match(/^level(\d{1,2})/i)
    if (level) {
      const layer = Number(level[1])
      tokens.push({ kind: 'vel', id: `v${layer}`, rank: 100 + layer })
      i += level[0].length
      continue
    }
    const note = rest.match(/^[A-Ga-g](?:#|b|s)?(?:-1|\d+)/i)
    if (note) {
      const midi = noteMidi(note[0])
      if (midi != null) {
        tokens.push({ kind: 'note', midi })
        i += note[0].length
        continue
      }
    }
    const num = rest.match(/^\d+/)
    if (num) {
      tokens.push({ kind: 'num', n: Number(num[0]), raw: num[0] })
      i += num[0].length
      continue
    }
    // harmLD#3 → harmL + D#3. The note letter is the last capital. VRC6 stays a word.
    const embedded = rest.match(/^(.*[a-z])([A-G]+)([#b])?(-1|\d+)(?!\d)/)
    if (embedded) {
      const noteLetter = embedded[2].slice(-1)
      const midi = noteMidi(`${noteLetter}${embedded[3] || ''}${embedded[4]}`)
      const prefix = embedded[1] + embedded[2].slice(0, -1)
      if (midi != null && prefix) {
        pushPrefix(tokens, prefix)
        tokens.push({ kind: 'note', midi })
        i += embedded[0].length
        continue
      }
    }
    // 039-D# and 5_F. A sharp in a name with no number stays a word, and a bare f stays forte.
    const pitch = rest.match(/^([A-Ga-g](?:#|b)?)(?![A-Za-z0-9])/)
    if (pitch) {
      const raw = pitch[1]
      const prev = tokens[tokens.length - 1]
      const afterNumber = prev?.kind === 'num'
      const afterOctave = afterNumber && prev.n >= 0 && prev.n <= 8 && prev.raw.length <= 2
      if ((raw.length > 1 && afterNumber) || afterOctave) {
        tokens.push({ kind: 'word', raw })
        i += raw.length
        continue
      }
    }
    const word = rest.match(/^[A-Za-z]+(?:-(?![A-Ga-g](?:#|b|s)?(?:-1|\d))[A-Za-z]+)*/)
    if (word) {
      const after = stem.slice(i + word[0].length)
      const peeled = word[0].match(/^(.*[a-z].*)([A-G])$/)
      const octave = after.match(/^([#b])?(-1|\d+)(?!\d)/)
      const peeledMidi = peeled && octave ? noteMidi(`${peeled[2]}${octave[1] || ''}${octave[2]}`) : null
      if (peeled && peeled[1] && peeledMidi != null && octave) {
        pushPrefix(tokens, peeled[1])
        tokens.push({ kind: 'note', midi: peeledMidi })
        i += word[0].length + octave[0].length
        continue
      }
      tokens.push(classifyWord(word[0]))
      i += word[0].length
      continue
    }
    i += 1
  }
  return foldOctaveNotes(tokens)
}

function pushPrefix(tokens: Token[], prefix: string) {
  const parts = prefix.split(/(?<=[a-z])(?=[A-Z])/).filter(Boolean)
  for (const part of parts) tokens.push(classifyWord(part))
}

function classifyWord(raw: string): Token {
  const lower = raw.toLowerCase()
  if (DYNAMICS[lower] != null) return { kind: 'vel', id: lower, rank: DYNAMICS[lower] }
  if (DURATION_WORD[lower] != null) return { kind: 'duration', rank: DURATION_WORD[lower] }
  if (RELEASE_WORD.has(lower)) return { kind: 'release' }
  if (NOISE_WORD.has(lower)) return { kind: 'noise' }
  return { kind: 'word', raw }
}

/** `2` + `Bb` is the note Bb2. A MIDI number plus its pitch-class letter is one note. */
function foldOctaveNotes(tokens: Token[]): Token[] {
  const out: Token[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    const next = tokens[i + 1]
    if (token.kind === 'num' && token.n >= 0 && token.n <= 8 && next?.kind === 'word' && /^[A-Ga-g][#b]?$/.test(next.raw)) {
      const midi = noteMidi(`${next.raw}${token.n}`)
      if (midi != null) {
        out.push({ kind: 'note', midi })
        i += 1
        continue
      }
    }
    out.push(token)
  }
  return out
}

/** `A`, `A#`, `Bb`, or the same with an octave digit. Nothing else in the name. */
function pitchFromStem(stem: string): { midi: number | null; pitchClass: number | null } | null {
  const match = stem.match(/^([A-Ga-g])([#b]|s)?(-1|\d+)?$/i)
  if (!match) return null
  let semi = PITCH[match[1].toLowerCase()]
  if (semi == null) return null
  const accidental = (match[2] || '').toLowerCase()
  if (accidental === '#' || accidental === 's') semi += 1
  if (accidental === 'b') semi -= 1
  semi = ((semi % 12) + 12) % 12
  if (!match[3]) return { midi: null, pitchClass: semi }
  const midi = (Number(match[3]) + 1) * 12 + semi
  if (midi < 0 || midi > 127) return null
  return { midi, pitchClass: null }
}

function emptyRaw(row: CatalogRow, midi: number | null, pitchClass: number | null): RawSample {
  return {
    key: row.key,
    size: row.size,
    category: row.category && row.category !== 'null' ? row.category : '',
    midi,
    pitchClass,
    velocityId: '',
    velocityRank: 0,
    rr: null,
    release: false,
    durationRank: 50,
    nameTokens: [],
    looseNumbers: [],
    looseFile: false,
  }
}

/**
 * `Octave01`, `Octave2`, `Octave01(Long)`.
 * The number is the folder's place in a consecutive run, not the scientific octave.
 * A parenthetical is the articulation, so Long and Short stay separate instruments.
 */
function octaveFolder(folder: string): { parent: string; index: number; art: string } | null {
  const parts = folder.split('/')
  const last = parts[parts.length - 1] || ''
  const match = last.match(/^octave[\s_-]*0*(\d+)(?:\s*\(([^)]+)\)|\s*[-_]([A-Za-z0-9]+))?$/i)
  if (!match) return null
  const index = Number(match[1])
  if (!Number.isFinite(index)) return null
  return { parent: parts.slice(0, -1).join('/'), index, art: (match[2] || match[3] || '').trim() }
}

/** First octave folder. Bass sits low, leads sit higher, so the same note name is not C4 in every pack. */
function baseOctave(category: string, folder: string) {
  const hay = `${category} ${folder}`.toLowerCase()
  if (/bass|sub|808|contrabass/.test(hay)) return 1
  if (/lead|pluck|acid|beeper/.test(hay)) return 3
  if (/piano|keys|organ|rhodes|guitar|harp|chime|mallet|bell|vibes|kalimba/.test(hay)) return 2
  return 3
}

function fileStem(key: string) {
  const file = key.split('/').pop() || key
  return file.replace(/\.[a-z0-9]+$/i, '')
}

function parseRaw(row: CatalogRow): RawSample | null {
  const stem = fileStem(row.key)
  const named = pitchFromStem(stem)
  if (named) return emptyRaw(row, named.midi, named.pitchClass)
  const loose = parseLooseName(stem)
  if (loose) {
    const raw = emptyRaw(row, loose.midi, loose.pitchClass)
    raw.looseFile = (row.type || '').toLowerCase() !== 'multisample note'
    const folderName = row.key.split('/').slice(0, -1).pop()?.toLowerCase() || ''
    const role = loose.role
    if (role && role !== folderName && !folderName.includes(role) && !role.includes(folderName)) raw.nameTokens = role.split(' ')
    return raw
  }
  const tokens = tokenizeStem(stem)
  let midi: number | null = null
  let fromNote = false
  let velocityId = ''
  let velocityRank = 0
  let rr: number | null = null
  let release = false
  let durationRank = 50
  const words: string[] = []
  const numbers: Extract<Token, { kind: 'num' }>[] = []
  const longDynamics: string[] = []
  for (const token of tokens) {
    if (token.kind === 'note') {
      if (midi == null) {
        midi = token.midi
        fromNote = true
      }
      continue
    }
    if (token.kind === 'vel') {
      if (token.id.length > 3) {
        words.push(token.id)
        longDynamics.push(token.id)
      } else if (!velocityId || token.rank > velocityRank) {
        velocityId = token.id
        velocityRank = token.rank
      }
      continue
    }
    if (token.kind === 'rr') {
      rr = token.n
      continue
    }
    if (token.kind === 'duration') {
      durationRank = Math.max(durationRank === 50 ? 0 : durationRank, token.rank)
      continue
    }
    if (token.kind === 'release') {
      release = true
      continue
    }
    if (token.kind === 'noise') continue
    if (token.kind === 'word') {
      if (token.raw.toLowerCase() === 'r' && tokens.some((item) => item.kind === 'note' || item.kind === 'num')) {
        release = true
        continue
      }
      words.push(token.raw)
      continue
    }
    numbers.push(token)
  }
  if (!velocityId && longDynamics.length) {
    const loudest = longDynamics.slice().sort((a, b) => (DYNAMICS[b] ?? 0) - (DYNAMICS[a] ?? 0))[0]
    velocityId = loudest
    velocityRank = DYNAMICS[loudest] ?? 0
    const at = words.lastIndexOf(loudest)
    if (at >= 0) words.splice(at, 1)
  }
  const fromCatalog = noteMidi(row.note)
  if (midi == null && fromCatalog != null) midi = fromCatalog
  const looseNumbers: number[] = []
  const hasDynamic = Boolean(velocityId)
  const hasWord = words.length > 0
  for (const token of numbers) {
    if (midi != null && token.n === midi) continue
    if (midi != null && token.raw.length >= 3 && token.n >= 0 && token.n <= 127 && token.n === midi) continue
    if (midi == null && token.raw.length >= 2 && token.n >= 0 && token.n <= 127 && (token.raw.length >= 3 || token.n >= 21)) {
      midi = token.n
      continue
    }
    const duration = DURATION_NUMBER[token.raw]
    if (duration != null && midi != null && hasDynamic && hasWord) {
      durationRank = Math.max(durationRank === 50 ? 0 : durationRank, duration)
      continue
    }
    if (token.n >= 0 && token.n <= 24) looseNumbers.push(token.n)
  }
  // 039-D# keeps the sharp letter only so it can be removed. A_045__A2 keeps the
  // leading A, because the filename already has a real note token.
  if (midi != null && !fromNote) {
    const pc = pitchClass(midi)
    for (let i = words.length - 1; i >= 0; i--) {
      const word = words[i]
      if (!/^[A-Ga-g][#b]?$/.test(word)) continue
      const named = noteMidi(`${word}4`)
      if (named != null && pitchClass(named) === pc) words.splice(i, 1)
    }
  }
  return {
    key: row.key,
    size: row.size,
    category: row.category && row.category !== 'null' ? row.category : '',
    midi,
    pitchClass: null,
    velocityId,
    velocityRank,
    rr,
    release,
    durationRank,
    nameTokens: words.map((word) => word.toLowerCase()),
    looseNumbers,
    looseFile: false,
  }
}

function groupKey(pack: string, folder: string, tokens: string[]) {
  return `${pack}\n${folder}\n${tokens.join('-')}`
}

function hashId(value: string) {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `lib_${(hash >>> 0).toString(36)}`
}

function humanize(value: string) {
  const spaced = value
    .replace(/[_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return ''
  return spaced
    .split(' ')
    .map((word) => {
      const known = ART_LABEL[word.toLowerCase()]
      if (known && word.length > 1) return known
      if (/^[a-z]/.test(word)) return word.charAt(0).toUpperCase() + word.slice(1)
      return word
    })
    .join(' ')
    .replace(/\bIi\b/g, 'II')
    .replace(/\bIii\b/g, 'III')
}

function cleanPack(pack: string) {
  return humanize(pack.replace(/\b\d+\s*bit\b/ig, '').replace(/\s+/g, ' ').trim()) || pack
}

function meaningfulFolders(pack: string, folder: string) {
  const parts = folder.split('/').filter(Boolean)
  const packNorm = pack.trim().toLowerCase()
  return parts.filter((part) => {
    const lower = part.trim().toLowerCase()
    if (!lower || lower === packNorm) return false
    if (BUCKET_DIR.has(lower) || GENERIC_DIR.test(part)) return false
    if (/\d+(\.\d+)?\s*khz/i.test(part) || /^\d+\s*bit/i.test(part)) return false
    return true
  })
}

const VAGUE_NAME = /^(acoustic|electric|close|decca|notes|sustain|release|ordinary|soft|hard|ord|stac|rel)$/i

function displayName(pack: string, folder: string, tokens: string[], sampleCount = 0) {
  const segs = meaningfulFolders(pack, folder)
  const folderName = segs.length ? humanize(segs[segs.length - 1]) : ''
  const parentName = segs.length > 1 ? humanize(segs[segs.length - 2]) : ''
  const words = tokens.map((token) => humanize(token)).filter(Boolean)
  const joined = words.join(' ')
  const folderNorm = folderName.toLowerCase()
  const joinedNorm = joined.toLowerCase()
  let base = ''
  let art = ''
  let code = ''
  const shortCode = tokens.length === 1 && tokens[0].length <= 4 && !ART_LABEL[tokens[0]]
  const parentRaw = segs.length > 1 ? segs[segs.length - 2] : ''
  const kit = parentRaw.match(/^(\d+)\((\d+)\)$/)
  if (kit && tokens.length <= 1) {
    const rawFolder = segs[segs.length - 1] || folderName
    const art = tokens.length === 1 ? humanize(tokens[0]) : ''
    const titled = art ? `${rawFolder} ${art}` : rawFolder
    return { name: `${titled} (${kit[1]} ${kit[2]})`, code: '' }
  }
  if (!joined) {
    base = folderName || cleanPack(pack)
  } else if (!folderName && shortCode) {
    code = tokens[0]
    base = cleanPack(pack)
  } else if (folderNorm && (joinedNorm === folderNorm || joinedNorm.startsWith(`${folderNorm} `))) {
    base = folderName
    art = joined.slice(folderName.length).trim()
  } else {
    base = joined
    const shortDir = segs.length ? segs[segs.length - 1] : ''
    const dirIsArt = shortDir.length > 0 && shortDir.length <= 12 && (ART_LABEL[shortDir.toLowerCase()] != null || /^(ord|stac|rel|sus|pizz|mute)$/i.test(shortDir))
    if (dirIsArt && parentName && !base.toLowerCase().includes(parentName.toLowerCase())) base = `${parentName} ${base}`
    else if (folderName && !joinedNorm.includes(folderNorm) && !folderNorm.includes(joinedNorm) && folderName.length > 2) base = `${folderName} - ${joined}`
  }
  base = base.replace(/\s+/g, ' ').trim()
  if (sampleCount >= 8 && tokens.length === 1 && tokens[0].length === 1 && folderName.length > 2) base = folderName
  if (base.length > 0 && base.length <= 4 && parentName && !base.toLowerCase().includes(parentName.toLowerCase())) base = `${parentName} ${base}`
  if (VAGUE_NAME.test(base)) base = `${cleanPack(pack)} ${base}`.trim()
  const name = art ? `${base} - ${art}` : (base || cleanPack(pack))
  return { name, code }
}

function classifyLoose(samples: RawSample[]) {
  const counts = new Map<number, number>()
  for (const sample of samples) {
    for (const n of sample.looseNumbers) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  if (!counts.size) return
  const constant = new Set<number>()
  for (const [n, count] of counts) if (count === samples.length) constant.add(n)
  for (const sample of samples) sample.looseNumbers = sample.looseNumbers.filter((n) => !constant.has(n))
  const varying = samples.some((sample) => sample.looseNumbers.length > 0)
  if (!varying) return
  const perNote = new Map<number, Set<number>>()
  for (const sample of samples) {
    if (sample.midi == null || sample.looseNumbers.length !== 1) continue
    const set = perNote.get(sample.midi) ?? new Set<number>()
    set.add(sample.looseNumbers[0])
    perNote.set(sample.midi, set)
  }
  let maxDistinct = 0
  for (const set of perNote.values()) maxDistinct = Math.max(maxDistinct, set.size)
  const hasVel = samples.some((sample) => sample.velocityId)
  const hasRr = samples.some((sample) => sample.rr != null)
  const asVelocity = !hasVel && (hasRr || maxDistinct > 6)
  const asRr = !asVelocity && !hasRr
  if (!asVelocity && !asRr) return
  for (const sample of samples) {
    const n = sample.looseNumbers.length === 1 ? sample.looseNumbers[0] : null
    if (n == null) continue
    if (asVelocity) {
      sample.velocityId = `v${n}`
      sample.velocityRank = 100 + n
    } else if (asRr) sample.rr = Math.max(1, n)
  }
}

function velocityBands(samples: RawSample[]) {
  const ranks = new Map<string, number>()
  for (const sample of samples) {
    if (!sample.velocityId) continue
    ranks.set(sample.velocityId, sample.velocityRank)
  }
  const bands = new Map<string, { lo: number; hi: number }>()
  const ids = [...ranks.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
  if (!ids.length) {
    bands.set('', { lo: 1, hi: 127 })
    return bands
  }
  const count = ids.length
  ids.forEach(([id], index) => {
    const lo = index === 0 ? 1 : Math.floor((index * 127) / count) + 1
    const hi = index === count - 1 ? 127 : Math.floor(((index + 1) * 127) / count)
    bands.set(id, { lo, hi: Math.max(lo, hi) })
  })
  return bands
}

function mode(values: string[]) {
  const counts = new Map<string, number>()
  for (const value of values) {
    if (!value) continue
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  let best = ''
  let score = 0
  for (const [value, count] of counts) {
    if (count > score) {
      best = value
      score = count
    }
  }
  return best
}

function closestToC4(samples: RawSample[]) {
  const playable = samples.filter((sample) => sample.midi != null && !sample.release)
  const pool = playable.length ? playable : samples.filter((sample) => sample.midi != null)
  if (!pool.length) return null
  return pool.slice().sort((a, b) => {
    const da = Math.abs((a.midi ?? 60) - 60)
    const db = Math.abs((b.midi ?? 60) - 60)
    if (da !== db) return da - db
    if ((a.rr ?? 1) !== (b.rr ?? 1)) return (a.rr ?? 1) - (b.rr ?? 1)
    return b.durationRank - a.durationRank || b.size - a.size
  })[0]
}

function buildOne(pack: string, folder: string, tokens: string[], samples: RawSample[], ids: Set<string>): { instrument: LibraryInstrument; code: string } | null {
  classifyLoose(samples)
  const pitched = samples.filter((sample) => sample.midi != null)
  let source = pitched.length ? pitched : samples
  if (!source.length) return null
  if (!pitched.length && source.length > 1) {
    const ordered = source.slice().sort((a, b) => a.key.localeCompare(b.key))
    const pick = ordered[Math.floor((ordered.length - 1) / 2)]
    source = [{ ...pick, midi: 60 }]
  }
  const bands = velocityBands(source)
  const collapsed = new Map<string, RawSample>()
  for (const sample of source) {
    const midi = sample.midi ?? 60
    const rr = sample.rr ?? 1
    const id = `${midi}|${sample.velocityId}|${rr}|${sample.release ? 'r' : 'a'}`
    const prev = collapsed.get(id)
    if (!prev || sample.durationRank > prev.durationRank || (sample.durationRank === prev.durationRank && sample.size > prev.size)) {
      collapsed.set(id, { ...sample, midi })
    }
  }
  const chosen = [...collapsed.values()]
  if (chosen.every((sample) => sample.release)) {
    for (const sample of chosen) sample.release = false
  }
  const layers: InstrumentLayer[] = chosen.map((sample) => {
    const band = bands.get(sample.velocityId) ?? { lo: 1, hi: 127 }
    return {
      key: sample.key,
      midi: sample.midi ?? 60,
      velLo: band.lo,
      velHi: band.hi,
      rr: sample.rr ?? 1,
      release: sample.release && pitched.some((item) => !item.release),
      size: sample.size,
    }
  })
  layers.sort((a, b) => a.midi - b.midi || a.velLo - b.velLo || a.rr - b.rr || a.key.localeCompare(b.key))
  const attacks = layers.filter((layer) => !layer.release)
  const shown = attacks.length ? attacks : layers
  const midis = [...new Set(shown.map((layer) => layer.midi))].sort((a, b) => a - b)
  const preview = closestToC4(chosen.filter((sample) => !sample.release).length ? chosen.filter((sample) => !sample.release) : chosen)
  if (!preview) return null
  const key = groupKey(pack, folder, tokens)
  let id = hashId(key)
  while (ids.has(id)) id += 'x'
  ids.add(id)
  const named = displayName(pack, folder, tokens, source.length)
  const velocities = new Set(shown.map((layer) => `${layer.velLo}-${layer.velHi}`))
  let roundRobins = 1
  const bySlot = new Map<string, number>()
  for (const layer of shown) {
    const slot = `${layer.midi}|${layer.velLo}`
    bySlot.set(slot, (bySlot.get(slot) ?? 0) + 1)
  }
  for (const count of bySlot.values()) roundRobins = Math.max(roundRobins, count)
  const instrument: LibraryInstrument = {
    id,
    name: named.name,
    pack,
    category: mode(source.map((sample) => sample.category)),
    folder,
    lo: midis[0] ?? preview.midi ?? 60,
    hi: midis[midis.length - 1] ?? preview.midi ?? 60,
    notes: midis.length || 1,
    samples: layers.length,
    velocities: velocities.size,
    roundRobins,
    previewKey: preview.key,
    previewMidi: preview.midi ?? 60,
    layers,
  }
  return { instrument, code: named.code }
}

function disambiguate(items: { instrument: LibraryInstrument; code: string }[]) {
  const byName = new Map<string, { instrument: LibraryInstrument; code: string }[]>()
  for (const item of items) {
    const list = byName.get(item.instrument.name.toLowerCase()) ?? []
    list.push(item)
    byName.set(item.instrument.name.toLowerCase(), list)
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue
    for (const item of list) {
      const segs = meaningfulFolders(item.instrument.pack, item.instrument.folder)
      const extra = segs.length > 1 ? humanize(segs[segs.length - 2]) : segs.length ? humanize(segs[0]) : ''
      const code = item.code ? humanize(item.code) : ''
      const packName = cleanPack(item.instrument.pack)
      const suffix = code && !item.instrument.name.toLowerCase().includes(code.toLowerCase())
        ? code
        : extra && !item.instrument.name.toLowerCase().includes(extra.toLowerCase())
          ? extra
          : packName
      if (suffix && !item.instrument.name.toLowerCase().includes(suffix.toLowerCase())) {
        item.instrument.name = `${item.instrument.name} - ${suffix}`
      }
    }
  }
}

/**
 * `A (1).wav` … `E (44).wav` is one chromatic instrument.
 * The letter is a round-robin. The number is the bar, low to high, starting at C4.
 * A matching series has to fill the folder, so a single `C (4)` stays a normal name.
 */
function applyIndexSeries(items: { raw: RawSample; stem: string }[]) {
  if (items.length < 8) return
  const parsed = items.map((item) => item.stem.match(/^([A-G]) \((\d+)\)$/i))
  if (parsed.some((match) => !match)) return
  const letters = [...new Set(parsed.map((match) => match![1].toUpperCase()))].sort()
  const numbers = parsed.map((match) => Number(match![2]))
  const unique = [...new Set(numbers)]
  if (letters.length < 2 || unique.length < 8) return
  const min = Math.min(...numbers)
  const max = Math.max(...numbers)
  if (max - min > 87) return
  items.forEach((item, index) => {
    const match = parsed[index]!
    const step = Number(match[2]) - min
    item.raw.midi = 60 + step
    item.raw.rr = letters.indexOf(match[1].toUpperCase()) + 1
    item.raw.velocityId = ''
    item.raw.velocityRank = 0
    item.raw.looseNumbers = []
    item.raw.nameTokens = item.raw.nameTokens.filter((token) => token.toLowerCase() !== match[1].toLowerCase())
  })
}

function isGroupable(entry: CatalogRow) {
  const type = (entry.type || '').toLowerCase()
  if (type === 'multisample note') return true
  if (type === 'loop' || type === 'sfx') return false
  const stem = fileStem(entry.key)
  if (pitchFromStem(stem) || parseLooseName(stem)) {
    if (!type) return true
    return type === 'one-shot' || type === 'sample' || type === 'instrument'
  }
  return false
}

/** Bare note names take their octave from the folder, never from a shared C4 default. */
function assignBareOctaves(items: { pack: string; folder: string; raw: RawSample; octaveIndex: number | null }[]) {
  const groups = new Map<string, typeof items>()
  for (const item of items) {
    if (item.raw.pitchClass == null || item.raw.midi != null) continue
    const key = `${item.pack}\n${item.folder}`
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }
  for (const list of groups.values()) {
    const base = baseOctave(mode(list.map((item) => item.raw.category)), list[0]?.folder ?? '')
    for (const item of list) {
      const step = item.octaveIndex == null ? 0 : Math.max(0, item.octaveIndex - 1)
      const midi = (base + step + 1) * 12 + (item.raw.pitchClass ?? 0)
      if (midi >= 0 && midi <= 127) item.raw.midi = midi
    }
  }
}

export function groupLibraryInstruments(entries: CatalogRow[]): LibraryInstrument[] {
  const pending: { pack: string; folder: string; raw: RawSample; stem: string; octaveIndex: number | null }[] = []
  for (const entry of entries) {
    if (!isGroupable(entry)) continue
    if (!entry.key || entry.key.includes('..')) continue
    const raw = parseRaw(entry)
    if (!raw) continue
    const type = (entry.type || '').toLowerCase()
    if (type && type !== 'multisample note') raw.looseFile = true
    const folder = entry.key.split('/').slice(0, -1).join('/')
    const file = entry.key.split('/').pop() || entry.key
    const oct = octaveFolder(folder)
    if (oct?.art) {
      const token = oct.art.toLowerCase()
      if (!raw.nameTokens.includes(token)) raw.nameTokens = [...raw.nameTokens, token]
    }
    pending.push({
      pack: entry.pack || '',
      folder: oct ? oct.parent : folder,
      raw,
      stem: file.replace(/\.[a-z0-9]+$/i, ''),
      octaveIndex: oct ? oct.index : null,
    })
  }
  const byFolder = new Map<string, { raw: RawSample; stem: string }[]>()
  for (const item of pending) {
    const list = byFolder.get(`${item.pack}\n${item.folder}`) ?? []
    list.push(item)
    byFolder.set(`${item.pack}\n${item.folder}`, list)
  }
  for (const list of byFolder.values()) applyIndexSeries(list)
  assignBareOctaves(pending)
  const groups = new Map<string, { pack: string; folder: string; tokens: string[]; samples: RawSample[] }>()
  for (const item of pending) {
    const key = groupKey(item.pack, item.folder, item.raw.nameTokens)
    const group = groups.get(key) ?? { pack: item.pack, folder: item.folder, tokens: item.raw.nameTokens, samples: [] }
    group.samples.push(item.raw)
    groups.set(key, group)
  }
  const ids = new Set<string>()
  const built: { instrument: LibraryInstrument; code: string }[] = []
  for (const group of groups.values()) {
    const chromatic = group.samples.some((sample) => !sample.looseFile)
    const pitches = new Set(group.samples.map((sample) => sample.midi).filter((midi): midi is number => midi != null))
    if (!chromatic && pitches.size < 2) continue
    const one = buildOne(group.pack, group.folder, group.tokens, group.samples, ids)
    if (one) built.push(one)
  }
  disambiguate(built)
  const instruments = built.map((item) => item.instrument)
  instruments.sort((a, b) => a.name.localeCompare(b.name) || a.pack.localeCompare(b.pack) || a.id.localeCompare(b.id))
  return instruments
}

export function summarizeInstrument(instrument: LibraryInstrument): LibraryInstrumentSummary {
  const { layers: _layers, ...summary } = instrument
  return summary
}

export function instrumentMatches(instrument: LibraryInstrumentSummary, query: Pick<InstrumentQuery, 'text' | 'category' | 'pack'>) {
  if (query.category && instrument.category.toLowerCase() !== query.category.toLowerCase()) return false
  if (query.pack && instrument.pack.toLowerCase() !== query.pack.toLowerCase()) return false
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  const hay = `${instrument.name} ${instrument.pack} ${instrument.category} ${instrument.folder}`.toLowerCase()
  return tokens.every((token) => hay.includes(token))
}

export function searchInstruments(instruments: LibraryInstrument[], query: InstrumentQuery): InstrumentPage {
  const limit = Math.max(1, Math.min(200, Math.round(query.limit) || 40))
  const offset = Math.max(0, Math.round(query.offset) || 0)
  const matched = instruments.filter((item) => instrumentMatches(item, query))
  return {
    total: matched.length,
    offset,
    limit,
    instruments: matched.slice(offset, offset + limit).map(summarizeInstrument),
  }
}

/** Samples for the requested notes, or the exact keys. Never more than `cap`. */
export function layersForNotes(instrument: LibraryInstrument, request: { notes?: number[]; keys?: string[]; velocity?: number }, cap = 24): InstrumentLayer[] {
  const capN = Math.max(1, Math.min(24, cap))
  if (request.keys?.length) {
    const wanted = new Set(request.keys)
    return instrument.layers.filter((layer) => wanted.has(layer.key)).slice(0, capN)
  }
  const notes = (request.notes ?? []).filter((note) => Number.isFinite(note)).map((note) => Math.max(0, Math.min(127, Math.round(note))))
  if (!notes.length) return []
  const wanted = new Set(notes)
  const layers = instrument.layers.filter((layer) => wanted.has(layer.midi) && !layer.release)
  if (layers.length <= capN) return layers
  const velocity = request.velocity != null && request.velocity > 0
    ? (request.velocity <= 1 ? Math.round(request.velocity * 127) : Math.round(request.velocity))
    : 80
  const band = layers.find((layer) => velocity >= layer.velLo && velocity <= layer.velHi)
    ?? layers.slice().sort((a, b) => Math.abs((a.velLo + a.velHi) / 2 - velocity) - Math.abs((b.velLo + b.velHi) / 2 - velocity))[0]
  const same = layers.filter((layer) => layer.velLo === band.velLo && layer.velHi === band.velHi)
  same.sort((a, b) => a.midi - b.midi || a.rr - b.rr)
  if (same.length >= capN) return same.slice(0, capN)
  const rest = layers.filter((layer) => layer.velLo !== band.velLo || layer.velHi !== band.velHi)
  rest.sort((a, b) => Math.abs((a.velLo + a.velHi) / 2 - velocity) - Math.abs((b.velLo + b.velHi) / 2 - velocity) || a.rr - b.rr)
  return [...same, ...rest].slice(0, capN)
}

/**
 * Keys to sign with the note that was just played.
 * Same velocity and round-robin, nearest roots first, never more than 24.
 * The played key is first so a full batch still includes it.
 */
export function playbackKeys(layers: InstrumentLayer[], key: string, cap = 24): string[] {
  const capN = Math.max(1, Math.min(24, cap))
  const layer = layers.find((item) => item.key === key && !item.release) ?? layers.find((item) => item.key === key)
  if (!layer) return [key].slice(0, capN)
  const same = layers.filter((item) => !item.release && item.velLo === layer.velLo && item.velHi === layer.velHi && item.rr === layer.rr)
  const pool = same.length ? same : layers.filter((item) => !item.release)
  const ranked = pool.slice().sort((a, b) => Math.abs(a.midi - layer.midi) - Math.abs(b.midi - layer.midi) || a.key.localeCompare(b.key))
  const keys = [layer.key]
  for (const item of ranked) {
    if (keys.length >= capN) break
    if (!keys.includes(item.key)) keys.push(item.key)
  }
  return keys
}

/** One presign body. Requested notes stay, and a short batch can pull nearby roots. */
export function planSignKeys(layers: InstrumentLayer[] | undefined, requested: string[], prefetch: boolean, cap = 24): string[] {
  const capN = Math.max(1, Math.min(24, cap))
  const out: string[] = []
  const seen = new Set<string>()
  const push = (key: string) => {
    if (!key || seen.has(key) || out.length >= capN) return
    seen.add(key)
    out.push(key)
  }
  for (const key of requested) push(key)
  if (prefetch && layers) {
    for (const key of requested) {
      for (const extra of playbackKeys(layers, key, capN)) push(extra)
    }
  }
  return out
}

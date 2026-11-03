import type { TheoryProgression } from './types'

export interface GenreInfo {
  id: string
  name: string
}

/** Genres the progression browser can filter. Names are the words shown on the chips. */
export const GENRE_INFO: GenreInfo[] = [
  { id: 'pop', name: 'Pop' },
  { id: 'rnb', name: 'R&B' },
  { id: 'hiphop', name: 'Hip-hop' },
  { id: 'trap', name: 'Trap' },
  { id: 'gospel', name: 'Gospel' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'neosoul', name: 'Neo-soul' },
  { id: 'latin', name: 'Latin' },
  { id: 'afrobeats', name: 'Afrobeats' },
  { id: 'edm', name: 'EDM' },
  { id: 'film', name: 'Film' },
  { id: 'lofi', name: 'Lo-fi' },
  { id: 'rock', name: 'Rock' },
  { id: 'country', name: 'Country' },
  { id: 'maqam', name: 'Maqam' },
  { id: 'raga', name: 'Raga' },
  { id: 'makam', name: 'Makam' },
  { id: 'japanese', name: 'Japanese' },
  { id: 'blues', name: 'Blues' },
  { id: 'folk', name: 'Folk' },
]

export interface SongSet {
  id: string
  name: string
  genre: string
  style: string
  progressionIds: string[]
}

interface SpellStep {
  root: number
  chordId: string
  roman: string
}

const ROOT: Record<string, number> = { I: 0, II: 2, III: 4, IV: 5, V: 7, VI: 9, VII: 11 }

const COLOR: Record<string, string> = {
  maj: 'maj7',
  min: 'm7',
  '7': '9',
  maj7: 'maj9',
  m7: 'm9',
  m9: 'm11',
  '9': '13',
  sus4: '7sus4',
  add9: 'maj9',
  neutral: 'neutral7',
}

const LINE_NAMES = ['Home', 'Lift', 'Answer', 'Return', 'Chorus', 'Bridge', 'Tag', 'Coda']

/**
 * Song books. A heading is `genre | Song name`. Following lines are roman progressions.
 * Variants (turn, color, cadence, borrowed) are generated, so this stays a short score.
 */
const BOOKS = `
pop | Open Air
I V vi IV
vi IV I V
I vi IV V
IV V iii vi
pop | Bright Corner
I vi IV V
I IV V IV
I V IV V
vi iii IV I
rnb | Velvet Room
ii7 V7 Imaj7 vi7
Imaj7 vi7 ii7 V7
iv7 bVII7 Imaj7
ii7 V7 iii7 vi7
rnb | Slow Dance
Imaj7 IV V vi
vi7 ii7 V7 Imaj7
I vi ii V
ii7 V7 I vi7
hiphop | Block Party
I V vi IV
vi IV I V
I IV V vi
ii V I IV
hiphop | Head Nod
I vi IV V
IV I V vi
vi ii V I
I IV vi V
trap | Low Loop
i bVI bVII i
i bVI v bVII
i bIII bVII i
i iv bVII v
trap | Night Circuit
i bVII bVI V
i v bVI bVII
i bIII iv v
i bVI bIII bVII
gospel | Choir Lift
I IV iv I
I V vi IV
IV I V ii
I ii V I
gospel | Sunday Room
I IV V vi
ii V I IV
I V IV I
vi IV I V
jazz | Long Cadence
ii7 V7 Imaj7
Imaj7 vi7 ii7 V7
iii7 vi7 ii7 V7
ii7 bII7 Imaj7
jazz | Fifth Fall
vi7 ii7 V7 Imaj7
ii7 V7 iii7 VI7
Imaj7 IVmaj7 iiim7 VImaj7
iii7 VI7 ii7 V7
neosoul | Honey
Imaj7 iv7 Imaj7 V7
ii9 V13 Imaj9
Imaj9 vi7 ii7 V9
iv bVII I
neosoul | Glow
Imaj7 iii7 vi7 ii7
vi7 IVmaj7 Imaj7 V7
ii7 V7 Imaj7
I vi ii V
latin | Havana
I V vi IV
i bVII bVI V
I IV V I
ii V I vi
latin | Clave
i iv V i
I vi ii V
i bVI bVII i
IV V iii vi
afrobeats | Offbeat
I V vi IV
I IV V IV
vi IV I V
I ii vi V
afrobeats | Highlife
I V IV I
vi IV I V
I IV vi IV
ii V I IV
edm | Night Drive
vi IV I V
I V vi IV
vi IV I IV
I vi IV V
edm | Warehouse
i bVI bIII bVII
i bVII bVI V
i iv bVII i
vi IV I V
film | Descending Gate
i bVI bIII bVII
i iv v VI
i bII V i
i VI III v
film | Wide Shot
i v bVI bVII
i iv bVI V
i bVII iv i
i II V i
lofi | Window Seat
Imaj7 vi7 ii7 V7
ii7 V7 Imaj7
I vi IV V
iv bVII I
lofi | Rain On Glass
vi7 IVmaj7 Imaj7 V7
Imaj7 iii7 vi7 ii7
ii7 V7 I
I IV ii V
rock | Three Chord
I IV V IV
I bVII IV I
I V vi IV
I IV I V
rock | Open Riff
I bVII bVI IV
I V IV V
i bVII bVI V
I IV V I
country | Porch Light
I IV I V
I V IV I
I vi IV V
I IV V IV
country | Highway
I IV V I
I V vi IV
I ii IV V
IV I V vi
maqam | Rast Room
I IV V I
I V I IV
I bVII IV V
IV V I V
maqam | Hijaz Gate
i bII V i
i iv bII V
i bII i bVII
i V bII i
maqam | Bayati Night
i bVII bVI V
i iv V i
i bII bIII i
i iv bVI V
maqam | Nahawand
i bVI bIII bVII
i iv V i
i v bVI V
i VI III VII
raga | Bhairav
i bII V i
i iv bII V
I bII V I
i bVII bII i
raga | Kafi
i iv v VII
i bIII iv v
i VII i iv
i v bVI VII
raga | Yaman
I II IV V
IV V I II
I V ii IV
ii V I IV
makam | Rast Makam
I IV V I
I V IV I
IV V I V
I bVII V I
makam | Hicaz
i bII V i
i bII iv V
i V bII i
i iv V i
japanese | In Scale
i bII iv v
i iv v i
i bVI bVII i
i v iv i
japanese | Yo Scale
I II IV V
I V IV I
IV V I II
I IV V IV
blues | Twelve Bar
I I IV I
IV IV I I
V IV I V
I IV V I
blues | Minor Blues
i i iv i
iv iv i i
V iv i V
i iv V i
folk | Campfire
I V IV I
I IV V I
I vi IV I
IV I V vi
folk | Modal
i bVII bVI bVII
I bVII IV I
i iv bVII i
I V vi IV
`

let cached: TheoryProgression[] | null = null

export function generatedProgressions(): TheoryProgression[] {
  if (!cached) cached = build()
  return cached
}

export function songSetsFrom(progressions: TheoryProgression[]): SongSet[] {
  const map = new Map<string, SongSet>()
  for (const item of progressions) {
    if (!item.song || !item.genre) continue
    const key = `${item.genre}:${item.song}`
    let set = map.get(key)
    if (!set) {
      const info = GENRE_INFO.find((genre) => genre.id === item.genre)
      set = {
        id: `${item.genre}-${slug(item.song)}`,
        name: item.song,
        genre: item.genre,
        style: info?.name ?? item.genre,
        progressionIds: [],
      }
      map.set(key, set)
    }
    set.progressionIds.push(item.id)
  }
  return [...map.values()]
}

function build(): TheoryProgression[] {
  const out: TheoryProgression[] = []
  const seen = new Set<string>()
  let genre = ''
  let song = ''
  let index = 0
  for (const raw of BOOKS.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (line.includes('|')) {
      const [left, right] = line.split('|')
      genre = left.trim()
      song = right.trim()
      index = 0
      continue
    }
    const steps = parseLine(line)
    if (!steps.length || !genre || !song) continue
    for (const variant of variants(steps)) {
      const signature = `${genre}|${variant.steps.map((step) => `${step.root}:${step.chordId}`).join('.')}`
      if (seen.has(signature)) continue
      seen.add(signature)
      const base = LINE_NAMES[index] ?? `Line ${index + 1}`
      const name = variant.kind === 'root' ? `${song} ${base}` : `${song} ${base} ${variant.kind}`
      const info = GENRE_INFO.find((item) => item.id === genre)
      out.push({
        id: `${genre}-${slug(song)}-${index}-${variant.kind}`,
        name,
        description: `${name}. ${line}. A ${info?.name ?? genre} progression from the ${song} set.`,
        targets: variant.steps.map((step) => step.root * 100),
        genre,
        song,
        spell: variant.steps.map((step) => ({ root: step.root, chordId: step.chordId, roman: step.roman })),
      })
    }
    index += 1
  }
  return out
}

function variants(steps: SpellStep[]) {
  return [
    { kind: 'root', steps },
    { kind: 'turn', steps: rotate(steps, 1) },
    { kind: 'color', steps: colorize(steps) },
    { kind: 'cadence', steps: cadence(steps) },
    { kind: 'borrowed', steps: borrow(steps) },
  ]
}

function rotate(steps: SpellStep[], by: number) {
  if (steps.length < 2) return steps
  const shift = ((by % steps.length) + steps.length) % steps.length
  return [...steps.slice(shift), ...steps.slice(0, shift)]
}

function colorize(steps: SpellStep[]): SpellStep[] {
  return steps.map((step) => {
    const next = COLOR[step.chordId]
    if (!next || next === step.chordId) return step
    return { ...step, chordId: next, roman: `${step.roman} color` }
  })
}

function cadence(steps: SpellStep[]): SpellStep[] {
  if (!steps.length) return steps
  const minor = steps[0].chordId === 'min' || steps[0].chordId.startsWith('m')
  const dominant: SpellStep = { root: 7, chordId: minor ? 'maj' : '7', roman: minor ? 'V' : 'V7' }
  const last = steps[steps.length - 1]
  const landing: SpellStep = last.root === dominant.root && last.chordId === dominant.chordId
    ? { root: 5, chordId: minor ? 'min' : 'maj', roman: minor ? 'iv' : 'IV' }
    : dominant
  return [...steps.slice(0, -1), landing]
}

function borrow(steps: SpellStep[]): SpellStep[] {
  if (steps.length < 2) return steps
  const next = steps.slice()
  const minor = steps[1].chordId === 'min' || steps[1].chordId.startsWith('m')
  next[1] = { root: 10, chordId: minor ? 'min' : 'maj', roman: 'bVII' }
  return next
}

export function parseLine(line: string): SpellStep[] {
  const steps: SpellStep[] = []
  for (const token of line.split(/\s+/)) {
    const step = parseToken(token)
    if (step) steps.push(step)
  }
  return steps
}

function parseToken(token: string): SpellStep | null {
  let text = token.trim()
  if (!text) return null
  let alter = 0
  if (text.startsWith('b') && text.length > 1) {
    alter = -1
    text = text.slice(1)
  } else if (text.startsWith('#') && text.length > 1) {
    alter = 1
    text = text.slice(1)
  }
  const match = text.match(/^(VII|VI|V|IV|III|II|I)(.*)$/i)
  if (!match) return null
  const numeral = match[1].toUpperCase()
  const minor = match[1] === match[1].toLowerCase()
  const base = ROOT[numeral]
  if (base == null) return null
  return {
    root: (base + alter + 12) % 12,
    chordId: match[2] ? mapSuffix(match[2], minor) : minor ? 'min' : 'maj',
    roman: token.trim(),
  }
}

function mapSuffix(suffix: string, minor: boolean) {
  const table: Record<string, string> = {
    maj9: 'maj9',
    maj7: 'maj7',
    m7b5: 'm7b5',
    madd9: 'madd9',
    add9: 'add9',
    m11: 'm11',
    m9: 'm9',
    m7: 'm7',
    sus4: 'sus4',
    sus2: 'sus2',
    dim: 'dim',
    aug: 'aug',
    '13': '13',
    '11': minor ? 'm11' : '11',
    '9': minor ? 'm9' : '9',
    '7': minor ? 'm7' : '7',
    '6': minor ? 'm6' : '6',
    n: 'neutral',
    m: 'min',
  }
  return table[suffix] ?? (minor ? 'min' : 'maj')
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

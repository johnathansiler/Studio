/** Local chord-idea library. Numerals are resolved from the project key. No network calls. */

import { nameChord, voiceChord } from './scale'

export type Mode = 'major' | 'minor'

export interface IdeaChord {
  symbol: string
  beats: number
}

export interface IdeaVariation {
  name: string
  chords: IdeaChord[]
}

export interface Progression {
  id: string
  name: string
  genres: string[]
  moods: string[]
  mode: Mode
  tempo: number
  feel: string
  why: string
  chords: IdeaChord[]
  similar: string[]
  variations: IdeaVariation[]
}

export interface SpelledChord {
  symbol: string
  name: string
  pitches: number[]
  startBeat: number
  beats: number
}

export interface StarterNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]
const MINOR = [0, 2, 3, 5, 7, 8, 10]
const TOKENS = ['VII', 'III', 'VI', 'IV', 'II', 'V', 'I']

const bar = (symbol: string, beats = 4): IdeaChord => ({ symbol, beats })

export const GENRES = ['pop', 'trap', 'r&b', 'gospel', 'lo-fi', 'edm', 'rock', 'country', 'jazz', 'cinematic', 'drill', 'afrobeats', 'reggaeton', 'blues', 'folk'] as const
export const MOODS = ['uplifting', 'dark', 'tense', 'nostalgic', 'bittersweet', 'warm', 'driving', 'smooth', 'heavy', 'dreamy'] as const

export const PROGRESSIONS: Progression[] = [
  idea('axis', 'Open Lift', ['pop', 'rock', 'country'], ['uplifting'], 'major', 104, 'Uplifting and anthemic.', 'The vi softens the V, then IV lands without a hard stop.', ['I', 'V', 'vi', 'IV'], ['sensitive', 'fifties'], [vary('Borrowed iv', ['I', 'V', 'vi', 'iv'])]),
  idea('sensitive', 'Soft Turn', ['pop', 'folk'], ['nostalgic', 'bittersweet'], 'major', 92, 'Nostalgic and bittersweet.', 'Starting on vi makes the major I feel like a memory.', ['vi', 'IV', 'I', 'V'], ['axis', 'minor-loop'], [vary('Stay on IV', ['vi', 'IV', 'I', 'IV'])]),
  idea('fifties', 'Corner Shop', ['pop', 'country'], ['warm', 'nostalgic'], 'major', 96, 'Warm and familiar.', 'I to vi is a gentle drop, and V asks to begin again.', ['I', 'vi', 'IV', 'V'], ['axis', 'doo'], [vary('Add a 7', ['I', 'vi7', 'IV', 'V7'])]),
  idea('doo', 'Street Corner', ['pop', 'r&b'], ['warm'], 'major', 88, 'Close and singable.', 'The vi is the same notes as the I, one step away.', ['I', 'vi', 'ii', 'V'], ['fifties', 'twofive'], [vary('Seventh on V', ['I', 'vi', 'ii', 'V7'])]),
  idea('minor-loop', 'Night Drive', ['pop', 'edm', 'reggaeton'], ['driving', 'dark'], 'minor', 100, 'Dark and rolling.', 'VI, III, and VII are major colors inside a minor loop.', ['i', 'VI', 'III', 'VII'], ['andalusian', 'trap-loop'], [vary('Raise the V', ['i', 'VI', 'III', 'V'])]),
  idea('andalusian', 'Descending Gate', ['folk', 'cinematic', 'rock'], ['tense', 'dark'], 'minor', 90, 'Dark and tense.', 'Each step falls, and the final V pulls back to i.', ['i', 'VII', 'VI', 'V'], ['minor-loop', 'phrygian'], [vary('Minor v', ['i', 'VII', 'VI', 'v'])]),
  idea('blues12', 'Twelve Rooms', ['blues', 'rock', 'jazz'], ['driving', 'warm'], 'major', 84, 'Blues gravity, three lines.', 'IV lifts the second line and V turns the corner home.', blues(), ['country-vamp', 'rock-cadence'], [vary('Quick IV', ['I', 'IV', 'I', 'I', 'IV', 'IV', 'I', 'I', 'V', 'IV', 'I', 'V'])]),
  idea('circle', 'Fifth Fall', ['jazz', 'pop'], ['smooth'], 'major', 110, 'A circle of fifths in four chords.', 'Each root falls a fifth, so the bass walks itself home.', ['vi', 'ii', 'V', 'I'], ['twofive', 'doo'], [vary('Keep going', ['iii', 'vi', 'ii', 'V'])]),
  idea('twofive', 'Long Cadence', ['jazz', 'r&b'], ['smooth', 'warm'], 'major', 120, 'The ii–V–I cadence.', 'ii prepares V, and V is the chord that wants I.', ['ii7', 'V7', 'Imaj7'], ['circle', 'turnaround'], [vary('Tritone sub', ['ii7', 'bII7', 'Imaj7'])]),
  idea('turnaround', 'Last Call', ['jazz'], ['smooth'], 'major', 132, 'A turnaround that loops.', 'The vi sends the cadence back to the top.', ['Imaj7', 'vi7', 'ii7', 'V7'], ['twofive', 'lofi'], [vary('Chromatic ii', ['Imaj7', 'vi7', '#ivdim', 'V7'])]),
  idea('gospel-iv', 'Choir Lift', ['gospel', 'r&b'], ['bittersweet', 'uplifting'], 'major', 76, 'A gospel lift from the IV to iv.', 'The borrowed iv adds sadness on the way back to I.', ['I', 'IV', 'iv', 'I'], ['worship', 'axis'], [vary('Add the V', ['I', 'IV', 'iv', 'V'])]),
  idea('worship', 'Wide Room', ['gospel', 'pop'], ['uplifting', 'dreamy'], 'major', 72, 'Open and slow.', 'IV under a held I feels like a congregation standing up.', ['I', 'V', 'vi', 'IV'], ['gospel-iv', 'axis'], [vary('Minor color', ['I', 'V', 'vi', 'iv'])]),
  idea('rock-cadence', 'Three Chord', ['rock', 'country', 'blues'], ['driving'], 'major', 126, 'Direct and physical.', 'I, IV, and V are the three chords a riff can live on.', ['I', 'IV', 'V', 'IV'], ['country-vamp', 'blues12'], [vary('bVII tag', ['I', 'bVII', 'IV', 'I'])]),
  idea('country-vamp', 'Porch', ['country', 'folk'], ['warm'], 'major', 112, 'Plainspoken and bright.', 'IV answers I, and V is saved for the turn.', ['I', 'IV', 'I', 'V'], ['rock-cadence', 'axis'], [vary('Relative minor', ['I', 'IV', 'vi', 'V'])]),
  idea('trap-loop', 'Low Loop', ['trap', 'drill'], ['dark', 'heavy'], 'minor', 140, 'Sparse and heavy.', 'The minor i sits while VI and VII move around it.', ['i', 'VI', 'v', 'VII'], ['drill-loop', 'minor-loop'], [vary('Hard V', ['i', 'VI', 'V', 'VII'])]),
  idea('drill-loop', 'Slide', ['drill', 'trap'], ['tense', 'dark'], 'minor', 144, 'Tense and narrow.', 'bVI to bVII climbs without resolving.', ['i', 'bVI', 'bVII', 'i'], ['trap-loop', 'andalusian'], [vary('Add v', ['i', 'bVI', 'bVII', 'v'])]),
  idea('rnb', 'Velvet', ['r&b'], ['smooth', 'nostalgic'], 'major', 86, 'Smooth and close.', 'Sevenths keep every chord from sounding finished.', ['ii7', 'V7', 'Imaj7', 'vi7'], ['lofi', 'twofive'], [vary('iv color', ['ii7', 'V7', 'Imaj7', 'iv7'])]),
  idea('lofi', 'Window Seat', ['lo-fi', 'jazz'], ['dreamy', 'nostalgic'], 'major', 74, 'Dusty and unhurried.', 'maj7 and m7 share tones, so the loop never jars.', ['Imaj7', 'vi7', 'ii7', 'V7'], ['rnb', 'turnaround'], [vary('Sus the V', ['Imaj7', 'vi7', 'ii7', 'Vsus'])]),
  idea('edm', 'Festival', ['edm', 'pop'], ['uplifting', 'driving'], 'major', 128, 'Built for a drop.', 'vi–IV–I–V delays the tonic so the drop can own it.', ['vi', 'IV', 'I', 'V'], ['axis', 'minor-loop'], [vary('Minor drop', ['vi', 'IV', 'i', 'V'])]),
  idea('cinematic', 'Wide Dark', ['cinematic'], ['dark', 'tense'], 'minor', 70, 'Wide and uneasy.', 'The major VI is hopeful, then v refuses to resolve.', ['i', 'VI', 'III', 'v'], ['andalusian', 'minor-loop'], [vary('Picardy', ['i', 'VI', 'iv', 'I'])]),
  idea('afro', 'Offbeat', ['afrobeats', 'pop'], ['warm', 'driving'], 'major', 108, 'Light and off the beat.', 'The same pop loop, with the bass answering late.', ['I', 'V', 'vi', 'IV'], ['axis', 'reggae'], [vary('ii for IV', ['I', 'V', 'vi', 'ii'])]),
  idea('reggae', 'Dembow', ['reggaeton', 'pop'], ['driving'], 'minor', 96, 'A minor loop with a skip.', 'i–VI–III–VII is the minor four-chord, danced instead of strummed.', ['i', 'VI', 'III', 'VII'], ['minor-loop', 'afro'], [vary('V turn', ['i', 'VI', 'III', 'V'])]),
  idea('folk', 'Campfire', ['folk', 'country'], ['warm', 'nostalgic'], 'major', 98, 'Simple enough to sing over.', 'Plagal IV–I feels like an ending that is not final.', ['I', 'V', 'IV', 'I'], ['country-vamp', 'axis'], [vary('Add vi', ['I', 'vi', 'IV', 'I'])]),
  idea('phrygian', 'Flat Two', ['cinematic', 'rock'], ['tense', 'dark'], 'minor', 92, 'Dark, with a flat two.', 'bII leans down into i instead of a normal V.', ['i', 'bII', 'i', 'bVII'], ['andalusian', 'drill-loop'], [vary('V instead', ['i', 'bII', 'bVII', 'V'])]),
  idea('steps', 'Step Circle', ['pop', 'cinematic'], ['nostalgic'], 'major', 80, 'A long falling bass.', 'The bass descends while the chords keep a common tone.', ['I', 'V', 'vi', 'iii', 'IV', 'I', 'IV', 'V'], ['circle', 'axis'], [vary('Stop early', ['I', 'V', 'vi', 'IV'])]),
  idea('mixo', 'Flat Seven', ['rock', 'folk'], ['driving', 'warm'], 'major', 118, 'Major, but the bVII keeps it open.', 'bVII is the mixolydian color: almost I, not quite.', ['I', 'bVII', 'IV', 'I'], ['rock-cadence', 'country-vamp'], [vary('Double back', ['I', 'bVII', 'IV', 'bVII'])]),
  idea('backdoor', 'Side Door', ['jazz', 'r&b', 'gospel'], ['smooth', 'bittersweet'], 'major', 90, 'Home from the side.', 'bVII7 shares a tone with V, so it can still resolve to I.', ['iv', 'bVII7', 'I'], ['gospel-iv', 'twofive'], [vary('Plain iv', ['iv', 'bVII', 'I'])]),
  idea('neapolitan', 'Flat Two Cadence', ['cinematic', 'jazz'], ['tense'], 'minor', 66, 'A classical lean into V.', 'bII is a half step above i, and it falls to V.', ['i', 'bII', 'V', 'i'], ['phrygian', 'andalusian'], [vary('Major end', ['i', 'bII', 'V', 'I'])]),
  idea('minor-plagal', 'Soft Amen', ['gospel', 'folk'], ['bittersweet'], 'minor', 78, 'A minor amen.', 'iv to i is the plagal move without a dominant.', ['i', 'iv', 'i', 'VI'], ['gospel-iv', 'folk'], [vary('Add VII', ['i', 'iv', 'VII', 'i'])]),
  idea('royal', 'Royal Road', ['pop', 'j-pop'], ['uplifting', 'bittersweet'], 'major', 128, 'Bright, with a small ache.', 'IV–V–iii–vi loops major and minor without a stop.', ['IV', 'V', 'iii', 'vi'], ['axis', 'sensitive'], [vary('Land on I', ['IV', 'V', 'iii', 'I'])]),
  idea('blues-minor', 'Minor Blues', ['blues', 'rock'], ['dark', 'heavy'], 'minor', 80, 'Blues in minor.', 'The i stays put while iv and V change the question.', ['i', 'i', 'i', 'i', 'iv', 'iv', 'i', 'i', 'V', 'iv', 'i', 'V'], ['blues12', 'andalusian'], [vary('bVI for V', ['i', 'iv', 'bVI', 'V'])]),
  idea('trap-major', 'Bright 808', ['trap', 'pop'], ['uplifting', 'heavy'], 'major', 136, 'Major chords, heavy drums.', 'The pop loop still works when the drums are sparse.', ['I', 'V', 'vi', 'IV'], ['axis', 'trap-loop'], [vary('vi first', ['vi', 'IV', 'I', 'V'])]),
]

function idea(id: string, name: string, genres: string[], moods: string[], mode: Mode, tempo: number, feel: string, why: string, symbols: string[], similar: string[], variations: IdeaVariation[]): Progression {
  return { id, name, genres, moods, mode, tempo, feel, why, chords: symbols.map((symbol) => bar(symbol)), similar, variations }
}

function vary(name: string, symbols: string[]): IdeaVariation {
  return { name, chords: symbols.map((symbol) => bar(symbol)) }
}

function blues(): string[] {
  return ['I', 'I', 'I', 'I', 'IV', 'IV', 'I', 'I', 'V', 'IV', 'I', 'V']
}

export function progressionById(id: string) {
  return PROGRESSIONS.find((item) => item.id === id) ?? null
}

export function filterIdeas(query: string, genre: string, mood: string) {
  const text = query.trim().toLowerCase()
  return PROGRESSIONS.filter((item) => {
    if (genre && genre !== 'all' && !item.genres.includes(genre)) return false
    if (mood && mood !== 'all' && !item.moods.includes(mood)) return false
    if (!text) return true
    const hay = `${item.name} ${item.feel} ${item.why} ${item.genres.join(' ')} ${item.moods.join(' ')} ${item.chords.map((chord) => chord.symbol).join(' ')}`.toLowerCase()
    return hay.includes(text)
  })
}

export function randomIdea(list: Progression[], rng: () => number = Math.random) {
  if (!list.length) return null
  const index = Math.min(list.length - 1, Math.floor(rng() * list.length))
  return list[index]
}

/** Resolve one numeral in a key. Secondary chords (`V/V`) are major-key functions of their target. */
export function spellSymbol(symbol: string, mode: Mode, keyRoot: number) {
  const parsed = parseNumeral(symbol, mode)
  const root = (pitchClass(keyRoot) + parsed.pc) % 12
  const pitches = parsed.intervals.map((interval) => 60 + root + interval)
  return { symbol, name: nameChord(pitches), pitches, pc: root, intervals: parsed.intervals }
}

export function spellProgression(chords: IdeaChord[], mode: Mode, keyRoot: number): SpelledChord[] {
  let beat = 0
  return chords.map((chord) => {
    const spelled = spellSymbol(chord.symbol, mode, keyRoot)
    const next = { symbol: chord.symbol, name: spelled.name, pitches: spelled.pitches, startBeat: beat, beats: chord.beats }
    beat += chord.beats
    return next
  })
}

export function voiceLead(chords: SpelledChord[]) {
  let previous: number[] = []
  return chords.map((chord) => {
    const pitches = voiceChord(chord.pitches, { voiceLead: previous.length > 0, previous })
    previous = pitches
    return { ...chord, pitches }
  })
}

export function starterParts(progression: Progression, keyRoot: number) {
  const raw = spellProgression(progression.chords, progression.mode, keyRoot)
  const spelled = voiceLead(raw)
  const style = drumStyle(progression.genres)
  const chords: StarterNote[] = []
  const bass: StarterNote[] = []
  const drums: StarterNote[] = []
  for (let index = 0; index < raw.length; index++) {
    const chord = spelled[index]
    for (const pitch of chord.pitches) {
      chords.push({ pitch, startBeat: chord.startBeat, durationBeats: Math.max(0.25, chord.beats - 0.05), velocity: 0.78 })
    }
    bass.push(...bassLine(style, raw[index]))
    drums.push(...drumBar(style, chord.startBeat, chord.beats))
  }
  return { chords, bass, drums, spelled }
}

export function romanLine(chords: IdeaChord[]) {
  return chords.map((chord) => chord.symbol).join('–')
}

function parseNumeral(symbol: string, mode: Mode) {
  const parts = symbol.split('/').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return parseCore(parts[0] || 'I', mode)
  const target = parseCore(parts[1], mode)
  const applied = parseCore(parts[0], 'major')
  return { pc: (target.pc + applied.pc) % 12, intervals: applied.intervals }
}

function parseCore(symbol: string, mode: Mode) {
  let text = symbol.trim()
  let accidental = 0
  while (text.startsWith('b')) {
    accidental -= 1
    text = text.slice(1)
  }
  while (text.startsWith('#')) {
    accidental += 1
    text = text.slice(1)
  }
  const upper = text.toUpperCase()
  const token = TOKENS.find((item) => upper.startsWith(item)) ?? 'I'
  const letters = text.slice(0, token.length)
  const rest = text.slice(token.length)
  const degree = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'].indexOf(token) + 1
  const scale = accidental !== 0 ? MAJOR : mode === 'minor' ? MINOR : MAJOR
  const pc = (scale[degree - 1] + accidental + 12) % 12
  const minorCase = letters === letters.toLowerCase() && letters !== letters.toUpperCase()
  return { pc, intervals: qualityIntervals(rest, minorCase) }
}

function qualityIntervals(rest: string, minorCase: boolean) {
  const mark = rest.toLowerCase()
  if (mark.includes('dim7') || mark.includes('°7')) return [0, 3, 6, 9]
  if (mark.includes('m7b5') || mark.includes('ø')) return [0, 3, 6, 10]
  if (mark.includes('°') || mark.includes('dim')) return [0, 3, 6]
  if (mark.includes('aug') || mark.includes('+')) return [0, 4, 8]
  if (mark.includes('sus2')) return [0, 2, 7]
  if (mark.includes('sus')) return [0, 5, 7]
  if (mark.includes('maj7')) return [0, 4, 7, 11]
  if (mark.includes('add9')) return minorCase ? [0, 3, 7, 14] : [0, 4, 7, 14]
  if (minorCase && mark.includes('7')) return [0, 3, 7, 10]
  if (mark.includes('7')) return [0, 4, 7, 10]
  return minorCase ? [0, 3, 7] : [0, 4, 7]
}

function bassLine(style: string, chord: SpelledChord): StarterNote[] {
  const root = 36 + (chord.pitches[0] % 12)
  const fifth = root + 7
  const beats = chord.beats
  if (style === 'trap') {
    return [
      { pitch: root, startBeat: chord.startBeat, durationBeats: Math.min(beats, 2), velocity: 0.9 },
      { pitch: root + 12, startBeat: chord.startBeat + Math.min(2.5, beats - 0.5), durationBeats: 0.5, velocity: 0.7 },
    ].filter((note) => note.startBeat < chord.startBeat + beats)
  }
  if (style === 'jazz') {
    const steps = [root, root + 4, fifth, root + 10]
    return steps.filter((_, index) => index < beats).map((pitch, index) => ({
      pitch,
      startBeat: chord.startBeat + index,
      durationBeats: 0.9,
      velocity: 0.7,
    }))
  }
  if (style === 'reggae') {
    return [0.5, 2.5].filter((beat) => beat < beats).map((beat) => ({
      pitch: root,
      startBeat: chord.startBeat + beat,
      durationBeats: 0.4,
      velocity: 0.75,
    }))
  }
  const notes: StarterNote[] = [{ pitch: root, startBeat: chord.startBeat, durationBeats: Math.min(1.5, beats - 0.1), velocity: 0.8 }]
  if (beats >= 4) notes.push({ pitch: fifth, startBeat: chord.startBeat + 2, durationBeats: 1.5, velocity: 0.72 })
  return notes
}

function drumBar(style: string, start: number, beats: number): StarterNote[] {
  const notes: StarterNote[] = []
  const add = (pitch: number, beatsIn: number[], velocity: number, duration = 0.25) => {
    for (const beat of beatsIn) {
      if (beat < beats) notes.push({ pitch, startBeat: start + beat, durationBeats: duration, velocity })
    }
  }
  if (style === 'trap') {
    add(36, [0, 0.75, 1.75, 2.5], 0.9)
    add(38, [2], 0.85)
    add(42, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], 0.45, 0.12)
  } else if (style === 'edm') {
    add(36, [0, 1, 2, 3], 0.9)
    add(38, [1, 3], 0.7)
    add(42, [0.5, 1.5, 2.5, 3.5], 0.5, 0.12)
  } else if (style === 'jazz') {
    add(36, [0, 2.5], 0.55)
    add(38, [1, 3], 0.35, 0.1)
    add(51, [0, 0.67, 1, 1.67, 2, 2.67, 3, 3.67], 0.4, 0.1)
  } else if (style === 'reggae') {
    add(36, [0, 2.5], 0.85)
    add(38, [1.5, 3.5], 0.7)
    add(42, [0.5, 1.5, 2.5, 3.5], 0.5, 0.12)
  } else if (style === 'afro') {
    add(36, [0, 1.5, 2.5], 0.8)
    add(38, [1, 3], 0.65)
    add(42, [0.5, 1.5, 2.5, 3.5], 0.5, 0.12)
  } else if (style === 'blues') {
    add(36, [0, 2.67], 0.8)
    add(38, [1, 3], 0.75)
    add(42, [0, 0.67, 1, 1.67, 2, 2.67, 3, 3.67], 0.4, 0.1)
  } else if (style === 'cinematic') {
    add(36, [0], 0.8)
    add(38, [2], 0.55)
    add(42, [0, 2], 0.3, 0.2)
  } else {
    add(36, [0, 2], 0.85)
    add(38, [1, 3], 0.75)
    add(42, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], 0.4, 0.1)
  }
  return notes
}

function drumStyle(genres: string[]) {
  if (genres.includes('trap') || genres.includes('drill')) return 'trap'
  if (genres.includes('edm')) return 'edm'
  if (genres.includes('jazz') || genres.includes('lo-fi')) return 'jazz'
  if (genres.includes('reggaeton')) return 'reggae'
  if (genres.includes('afrobeats')) return 'afro'
  if (genres.includes('blues')) return 'blues'
  if (genres.includes('cinematic')) return 'cinematic'
  return 'pop'
}

function pitchClass(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

export function chordNames(progression: Progression, keyRoot: number) {
  return spellProgression(progression.chords, progression.mode, keyRoot).map((chord) => chord.name).join(' ')
}

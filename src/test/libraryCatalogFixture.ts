/** Synthetic private-library catalog. Shape matches the real gzip file. */

const PACKS = ['Trap Drums', 'Vocal Pads', 'Finger Bass', 'Special Sauce', 'Dusty Keys', 'Room Mics', 'Night Choir', 'Vinyl Tools']
const TYPES = ['one-shot', 'loop', 'sfx', 'multisample note'] as const
const CATEGORIES = ['kick', 'snare', 'hat', 'bass', 'pad', 'fx', 'keys', 'perc']
const INSTRUMENTS = ['808 bass', 'electric bass', 'choir', 'vinyl crackle', 'piano', 'synth', 'shaker', 'clap']
const GENRES = ['trap', 'lo-fi', 'house', 'soul', 'ambient', 'boom bap', 'dnb', 'pop']
const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B', 'A minor', 'D minor']
const NOTES = ['C1', 'C#1', 'D1', 'Eb1', 'E1', 'F1', 'F#1', 'G1', 'C2', 'C#2', 'D2', 'A2', 'C3', 'F3']
const MOODS = ['gritty', 'ethereal', 'vintage', 'dark', 'bright', 'warm', 'dusty', 'soft']
const TAGS = ['drum machine', 'acoustic', 'texture', 'vocal', 'analog', 'room', 'close', 'wide']

export interface SyntheticEntry {
  key: string
  size: number
  format: string
  pack: string
  type: string
  category: string
  instrument: string
  genre: string[]
  bpm: number | null
  musical_key: string
  note: string
  mood: string[]
  tags: string[]
  license: string
  search: string
}

export function syntheticLibrary(count = 91_800) {
  const entries: SyntheticEntry[] = []
  for (let i = 0; i < count; i++) {
    const pack = PACKS[i % PACKS.length]
    const type = TYPES[i % TYPES.length]
    const category = CATEGORIES[i % CATEGORIES.length]
    const instrument = INSTRUMENTS[i % INSTRUMENTS.length]
    const genre = GENRES[i % GENRES.length]
    const musical = KEYS[i % KEYS.length]
    const note = NOTES[i % NOTES.length]
    const mood = MOODS[i % MOODS.length]
    const tag = TAGS[i % TAGS.length]
    const bpm = type === 'loop' ? 70 + (i % 110) : null
    entries.push({
      key: `${pack.replace(/\s+/g, '_')}/${type}/${i.toString(36)}.wav`,
      size: 48_000 + (i % 4000),
      format: i % 19 === 0 ? 'aif' : 'wav',
      pack,
      type,
      category,
      instrument,
      genre: [genre],
      bpm,
      musical_key: musical,
      note,
      mood: [mood],
      tags: [tag],
      license: 'private',
      search: `${genre} ${category} ${instrument} ${note.toLowerCase()} ${tag}`,
    })
  }
  const plant = (index: number, entry: SyntheticEntry) => {
    entries[index] = entry
  }
  plant(0, {
    key: 'Drums/139_Trap_Click_C.wav',
    size: 200_000,
    format: 'wav',
    pack: 'Trap Drums',
    type: 'one-shot',
    category: 'kick',
    instrument: '808 bass',
    genre: ['trap'],
    bpm: 140,
    musical_key: 'C',
    note: 'C2',
    mood: ['gritty'],
    tags: ['drum machine'],
    license: 'private',
    search: 'trap 808 click c one shot kick drum',
  })
  plant(1, {
    key: 'Bass/C_sharp.wav',
    size: 180_000,
    format: 'wav',
    pack: 'Finger Bass',
    type: 'one-shot',
    category: 'bass',
    instrument: 'electric bass',
    genre: ['soul'],
    bpm: null,
    musical_key: 'C#',
    note: 'C#2',
    mood: ['warm'],
    tags: ['analog'],
    license: 'private',
    search: 'bass electric c# one shot finger',
  })
  plant(2, {
    key: 'Choir/vocal_pad.wav',
    size: 900_000,
    format: 'wav',
    pack: 'Vocal Pads',
    type: 'loop',
    category: 'pad',
    instrument: 'choir',
    genre: ['lo-fi'],
    bpm: 100,
    musical_key: 'A minor',
    note: 'A3',
    mood: ['ethereal'],
    tags: ['vocal'],
    license: 'private',
    search: 'choir pad loop vocal ethereal',
  })
  plant(3, {
    key: 'FX/vinyl_crackle.wav',
    size: 320_000,
    format: 'wav',
    pack: 'Special Sauce',
    type: 'sfx',
    category: 'fx',
    instrument: 'vinyl crackle',
    genre: ['ambient'],
    bpm: null,
    musical_key: '',
    note: '',
    mood: ['vintage'],
    tags: ['vinyl', 'crackle'],
    license: 'private',
    search: 'vinyl crackle texture sfx vintage',
  })
  return {
    version: 3,
    generated_at: '2026-11-11T00:00:00Z',
    count,
    pending: '',
    entries,
  }
}

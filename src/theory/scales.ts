/**
 * Scale and mode catalog. Intervals are cents above the tonic.
 * 100 cents is one equal-tempered semitone. 50 cents is a quarter tone.
 * The first 19 entries stay in this order: the tuner addresses them by index.
 */

export type ScaleFamily = 'mode' | 'jazz' | 'blues' | 'pentatonic' | 'world' | 'maqam'

export interface ScaleSpec {
  id: ScaleId
  name: string
  family: ScaleFamily
  /** Cents above the tonic, inside one octave, strictly increasing, starting at 0. */
  cents: readonly number[]
  aliases: readonly string[]
  /** True when a degree is not on a 12-tone semitone. */
  microtonal: boolean
}

function define(draft: (typeof DRAFTS)[number]): ScaleSpec {
  const cents = 'cents' in draft && draft.cents ? draft.steps : draft.steps.map((step) => Math.round(step * 100))
  return {
    id: draft.id,
    name: draft.name,
    family: draft.family,
    cents,
    aliases: 'aliases' in draft ? draft.aliases : [],
    microtonal: cents.some((interval) => interval % 100 !== 0),
  }
}

const DRAFTS = [
  { id: 'ionian', name: 'Major', family: 'mode', steps: [0, 2, 4, 5, 7, 9, 11], aliases: ['ionian', 'major'] },
  { id: 'dorian', name: 'Dorian', family: 'mode', steps: [0, 2, 3, 5, 7, 9, 10], aliases: ['kafi'] },
  { id: 'phrygian', name: 'Phrygian', family: 'mode', steps: [0, 1, 3, 5, 7, 8, 10], aliases: ['bhairavi'] },
  { id: 'lydian', name: 'Lydian', family: 'mode', steps: [0, 2, 4, 6, 7, 9, 11], aliases: ['yaman', 'kalyani'] },
  { id: 'mixolydian', name: 'Mixolydian', family: 'mode', steps: [0, 2, 4, 5, 7, 9, 10], aliases: ['khamaj'] },
  { id: 'aeolian', name: 'Minor', family: 'mode', steps: [0, 2, 3, 5, 7, 8, 10], aliases: ['natural minor', 'aeolian'] },
  { id: 'locrian', name: 'Locrian', family: 'mode', steps: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'harmonicMinor', name: 'Harmonic minor', family: 'mode', steps: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodicMinor', name: 'Melodic minor', family: 'jazz', steps: [0, 2, 3, 5, 7, 9, 11], aliases: ['jazz minor'] },
  { id: 'majorPentatonic', name: 'Maj pentatonic', family: 'pentatonic', steps: [0, 2, 4, 7, 9], aliases: ['chinese', 'gong'] },
  { id: 'minorPentatonic', name: 'Min pentatonic', family: 'pentatonic', steps: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', family: 'blues', steps: [0, 3, 5, 6, 7, 10], aliases: ['minor blues'] },
  { id: 'wholeTone', name: 'Whole tone', family: 'jazz', steps: [0, 2, 4, 6, 8, 10], aliases: ['messiaen 1'] },
  { id: 'dimHalfWhole', name: 'Half-whole', family: 'jazz', steps: [0, 1, 3, 4, 6, 7, 9, 10], aliases: ['dominant diminished', 'messiaen 2'] },
  { id: 'dimWholeHalf', name: 'Whole-half', family: 'jazz', steps: [0, 2, 3, 5, 6, 8, 9, 11], aliases: ['diminished'] },
  { id: 'hirajoshi', name: 'Hirajoshi', family: 'world', steps: [0, 2, 3, 7, 8] },
  { id: 'phrygianDominant', name: 'Phrygian dom', family: 'mode', steps: [0, 1, 4, 5, 7, 8, 10], aliases: ['spanish', 'hijazkar 12', 'jewish'] },
  { id: 'hungarianMinor', name: 'Hungarian min', family: 'world', steps: [0, 2, 3, 6, 7, 8, 11], aliases: ['gypsy', 'double harmonic minor'] },
  { id: 'insen', name: 'In Sen', family: 'world', steps: [0, 1, 5, 7, 10] },

  { id: 'harmonicMajor', name: 'Harmonic major', family: 'mode', steps: [0, 2, 4, 5, 7, 8, 11] },
  { id: 'doubleHarmonic', name: 'Double harmonic', family: 'world', steps: [0, 1, 4, 5, 7, 8, 11], aliases: ['byzantine', 'bhairav', 'arabic'] },
  { id: 'neapolitanMinor', name: 'Neapolitan min', family: 'mode', steps: [0, 1, 3, 5, 7, 8, 11] },
  { id: 'neapolitanMajor', name: 'Neapolitan maj', family: 'mode', steps: [0, 1, 3, 5, 7, 9, 11] },
  { id: 'enigmatic', name: 'Enigmatic', family: 'mode', steps: [0, 1, 4, 6, 8, 10, 11] },
  { id: 'persian', name: 'Persian', family: 'world', steps: [0, 1, 4, 5, 6, 8, 11] },
  { id: 'hungarianMajor', name: 'Hungarian maj', family: 'world', steps: [0, 3, 4, 6, 7, 9, 10] },
  { id: 'romanian', name: 'Romanian', family: 'world', steps: [0, 2, 3, 6, 7, 9, 10], aliases: ['ukrainian dorian'] },
  { id: 'dorianb2', name: 'Dorian b2', family: 'jazz', steps: [0, 1, 3, 5, 7, 9, 10], aliases: ['phrygian natural 6'] },
  { id: 'lydianAugmented', name: 'Lydian augmented', family: 'jazz', steps: [0, 2, 4, 6, 8, 9, 11] },
  { id: 'lydianDominant', name: 'Lydian dominant', family: 'jazz', steps: [0, 2, 4, 6, 7, 9, 10], aliases: ['acoustic', 'overtone'] },
  { id: 'mixolydianb6', name: 'Mixolydian b6', family: 'jazz', steps: [0, 2, 4, 5, 7, 8, 10], aliases: ['hindu', 'charukesi'] },
  { id: 'locrianNatural2', name: 'Locrian nat2', family: 'jazz', steps: [0, 2, 3, 5, 6, 8, 10], aliases: ['half diminished'] },
  { id: 'altered', name: 'Altered', family: 'jazz', steps: [0, 1, 3, 4, 6, 8, 10], aliases: ['super locrian', 'altered dominant'] },
  { id: 'locrianNatural6', name: 'Locrian nat6', family: 'mode', steps: [0, 1, 3, 5, 6, 9, 10] },
  { id: 'ionianSharp5', name: 'Ionian #5', family: 'mode', steps: [0, 2, 4, 5, 8, 9, 11] },
  { id: 'lydianSharp2', name: 'Lydian #2', family: 'mode', steps: [0, 3, 4, 6, 7, 9, 11] },
  { id: 'ultralocrian', name: 'Ultralocrian', family: 'mode', steps: [0, 1, 3, 4, 6, 8, 9] },
  { id: 'bebopMajor', name: 'Bebop major', family: 'jazz', steps: [0, 2, 4, 5, 7, 8, 9, 11] },
  { id: 'bebopDominant', name: 'Bebop dominant', family: 'jazz', steps: [0, 2, 4, 5, 7, 9, 10, 11] },
  { id: 'bebopMinor', name: 'Bebop minor', family: 'jazz', steps: [0, 2, 3, 5, 7, 8, 9, 10] },
  { id: 'augmentedHex', name: 'Augmented', family: 'jazz', steps: [0, 3, 4, 7, 8, 11] },
  { id: 'prometheus', name: 'Prometheus', family: 'jazz', steps: [0, 2, 4, 6, 9, 10] },
  { id: 'tritoneScale', name: 'Tritone', family: 'jazz', steps: [0, 1, 4, 6, 7, 10] },
  { id: 'leadingWhole', name: 'Leading whole', family: 'jazz', steps: [0, 2, 4, 6, 8, 10, 11] },
  { id: 'majorBlues', name: 'Major blues', family: 'blues', steps: [0, 2, 3, 4, 7, 9] },
  { id: 'mixoBlues', name: 'Mixolydian blues', family: 'blues', steps: [0, 2, 3, 4, 5, 7, 9, 10] },
  { id: 'egyptian', name: 'Egyptian', family: 'pentatonic', steps: [0, 2, 5, 7, 10], aliases: ['suspended pentatonic'] },
  { id: 'yo', name: 'Yo', family: 'pentatonic', steps: [0, 2, 5, 7, 9], aliases: ['ritusen'] },
  { id: 'iwato', name: 'Iwato', family: 'pentatonic', steps: [0, 1, 5, 6, 10] },
  { id: 'kumoi', name: 'Kumoi', family: 'pentatonic', steps: [0, 2, 3, 7, 9] },
  { id: 'pelog', name: 'Pelog', family: 'world', steps: [0, 1, 3, 7, 8], aliases: ['balinese'] },
  { id: 'miyako', name: 'Miyako-bushi', family: 'world', steps: [0, 1, 5, 7, 8] },
  { id: 'dominantPent', name: 'Dominant pent', family: 'pentatonic', steps: [0, 2, 4, 7, 10] },
  { id: 'minor6Pent', name: 'Minor 6 pent', family: 'pentatonic', steps: [0, 3, 5, 7, 9] },
  { id: 'todi', name: 'Todi', family: 'world', steps: [0, 1, 3, 6, 7, 8, 11] },
  { id: 'marwa', name: 'Marwa', family: 'world', steps: [0, 1, 4, 6, 7, 9, 11] },
  { id: 'purvi', name: 'Purvi', family: 'world', steps: [0, 1, 4, 6, 7, 8, 11] },
  { id: 'messiaen3', name: 'Messiaen 3', family: 'jazz', steps: [0, 2, 3, 4, 6, 7, 8, 10, 11] },
  { id: 'messiaen4', name: 'Messiaen 4', family: 'jazz', steps: [0, 1, 2, 5, 6, 7, 8, 11] },
  { id: 'messiaen5', name: 'Messiaen 5', family: 'jazz', steps: [0, 1, 5, 6, 7, 11] },
  { id: 'messiaen6', name: 'Messiaen 6', family: 'jazz', steps: [0, 2, 4, 5, 6, 8, 10, 11] },
  { id: 'messiaen7', name: 'Messiaen 7', family: 'jazz', steps: [0, 1, 2, 3, 5, 6, 7, 8, 9, 11] },

  { id: 'rast', name: 'Rast', family: 'maqam', cents: true, steps: [0, 200, 350, 500, 700, 900, 1050] },
  { id: 'bayati', name: 'Bayati', family: 'maqam', cents: true, steps: [0, 150, 300, 500, 700, 800, 1000] },
  { id: 'hijaz', name: 'Hijaz', family: 'maqam', cents: true, steps: [0, 100, 400, 500, 700, 800, 1000] },
  { id: 'hijazKar', name: 'Hijaz Kar', family: 'maqam', cents: true, steps: [0, 100, 400, 500, 700, 800, 1100] },
  { id: 'nahawand', name: 'Nahawand', family: 'maqam', cents: true, steps: [0, 200, 300, 500, 700, 800, 1000] },
  { id: 'nahawandMurassah', name: 'Nahawand murassah', family: 'maqam', cents: true, steps: [0, 200, 300, 500, 700, 800, 1100] },
  { id: 'ajam', name: 'Ajam', family: 'maqam', cents: true, steps: [0, 200, 400, 500, 700, 900, 1000] },
  { id: 'kurd', name: 'Kurd', family: 'maqam', cents: true, steps: [0, 100, 300, 500, 700, 800, 1000] },
  { id: 'saba', name: 'Saba', family: 'maqam', cents: true, steps: [0, 150, 300, 500, 600, 800, 1000] },
  { id: 'sikah', name: 'Sikah', family: 'maqam', cents: true, steps: [0, 150, 350, 500, 700, 850, 1000] },
  { id: 'huzam', name: 'Huzam', family: 'maqam', cents: true, steps: [0, 150, 350, 500, 650, 850, 1000] },
  { id: 'iraq', name: 'Iraq', family: 'maqam', cents: true, steps: [0, 150, 350, 500, 700, 850, 1050] },
  { id: 'suznak', name: 'Suznak', family: 'maqam', cents: true, steps: [0, 200, 350, 500, 700, 800, 1100] },
  { id: 'nairuz', name: 'Nairuz', family: 'maqam', cents: true, steps: [0, 200, 350, 500, 700, 850, 1000] },
  { id: 'husayni', name: 'Husayni', family: 'maqam', cents: true, steps: [0, 150, 300, 500, 700, 900, 1000] },
  { id: 'jiharkah', name: 'Jiharkah', family: 'maqam', cents: true, steps: [0, 200, 400, 500, 700, 900, 1050] },
  { id: 'nikriz', name: 'Nikriz', family: 'maqam', cents: true, steps: [0, 200, 300, 600, 700, 800, 1100] },
  { id: 'nawaAthar', name: 'Nawa Athar', family: 'maqam', cents: true, steps: [0, 200, 300, 500, 600, 900, 1100] },
  { id: 'atharKurd', name: 'Athar Kurd', family: 'maqam', cents: true, steps: [0, 100, 350, 500, 700, 800, 1100] },
  { id: 'zanjaran', name: 'Zanjaran', family: 'maqam', cents: true, steps: [0, 150, 300, 500, 600, 900, 1000] },
  { id: 'mustaar', name: 'Mustaar', family: 'maqam', cents: true, steps: [0, 150, 350, 550, 700, 850, 1000] },
  { id: 'sabaZamzam', name: 'Saba Zamzam', family: 'maqam', cents: true, steps: [0, 100, 300, 400, 600, 800, 1000] },
] as const

export type ScaleId = (typeof DRAFTS)[number]['id']

export const SCALE_LIBRARY: ScaleSpec[] = DRAFTS.map(define)

export const SCALE_FAMILIES: ScaleFamily[] = ['mode', 'jazz', 'blues', 'pentatonic', 'world', 'maqam']

export const FAMILY_LABEL: Record<ScaleFamily, string> = {
  mode: 'Modes',
  jazz: 'Jazz',
  blues: 'Blues',
  pentatonic: 'Pentatonic',
  world: 'World',
  maqam: 'Maqam',
}

/** Ids the tuner indexes as 0…18. Do not reorder. */
export const TUNER_SCALE_COUNT = 19

const BY_ID = new Map<string, ScaleSpec>(SCALE_LIBRARY.map((scale) => [scale.id, scale]))

export function scales() {
  return SCALE_LIBRARY
}

export function scaleById(id: string | undefined): ScaleSpec {
  return (id && BY_ID.get(id)) || SCALE_LIBRARY[0]
}

export function isMicrotonal(id: string | undefined) {
  return scaleById(id).microtonal
}

export function scalesInFamily(family: ScaleFamily) {
  return SCALE_LIBRARY.filter((scale) => scale.family === family)
}

export function searchScales(query: string, family?: ScaleFamily | 'all') {
  const text = query.trim().toLowerCase()
  return SCALE_LIBRARY.filter((scale) => {
    if (family && family !== 'all' && scale.family !== family) return false
    if (!text) return true
    const hay = `${scale.name} ${scale.id} ${scale.family} ${scale.aliases.join(' ')}`.toLowerCase()
    return hay.includes(text)
  })
}

/** Semitone offsets (may be fractional) for engines that still think in MIDI. */
export function semitoneIntervals(id: string | undefined): number[] {
  return scaleById(id).cents.map((cents) => cents / 100)
}

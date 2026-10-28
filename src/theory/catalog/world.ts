import { getScale, rotateCents } from '../scales'
import type { ScaleSpec } from '../types'

const KOMA = 1200 / 53

/** Turkish comma steps. The last value is the octave and is dropped. */
export function fromKoma(steps: number[]): number[] {
  const cents = [0]
  let acc = 0
  for (const step of steps) {
    acc += step
    cents.push(Math.round(acc * KOMA * 10) / 10)
  }
  if (cents[cents.length - 1] >= 1190) cents.pop()
  return cents
}

function spec(id: string, name: string, family: string, cents: number[], description: string): ScaleSpec {
  return { id, name, family, cents, description }
}

function mode(parentId: string, family: string, degree: number, id: string, name: string, description: string) {
  return spec(id, name, family, rotateCents(getScale(parentId).cents, degree), description)
}

const MELA_RI_GA: [number, number][] = [
  [100, 200],
  [100, 300],
  [100, 400],
  [200, 300],
  [200, 400],
  [300, 400],
]
const MELA_DA_NI: [number, number][] = [
  [800, 900],
  [800, 1000],
  [800, 1100],
  [900, 1000],
  [900, 1100],
  [1000, 1100],
]

const MELA_NAMES = [
  'Kanakangi', 'Ratnangi', 'Ganamurti', 'Vanaspati', 'Manavati', 'Tanarupi',
  'Senavati', 'Hanumatodi', 'Dhenuka', 'Natakapriya', 'Kokilapriya', 'Rupavati',
  'Gayakapriya', 'Vakulabharanam', 'Mayamalavagowla', 'Chakravakam', 'Suryakantam', 'Hatakambari',
  'Jhankaradhwani', 'Natabhairavi', 'Keeravani', 'Kharaharapriya', 'Gourimanohari', 'Varunapriya',
  'Mararanjani', 'Charukesi', 'Sarasangi', 'Harikambhoji', 'Dheerasankarabharanam', 'Naganandini',
  'Yagapriya', 'Ragavardhini', 'Gangeyabhushani', 'Vagadheeswari', 'Shulini', 'Chalanata',
  'Salagam', 'Jalarnavam', 'Jhalavarali', 'Navaneetam', 'Pavani', 'Raghupriya',
  'Gavambhodi', 'Bhavapriya', 'Shubhapantuvarali', 'Shadvidamargini', 'Suvarnangi', 'Divyamani',
  'Dhavalambari', 'Namanarayani', 'Kamavardhani', 'Ramapriya', 'Gamanashrama', 'Vishwambari',
  'Shamalangi', 'Shanmukhapriya', 'Simhendramadhyamam', 'Hemavati', 'Dharmavati', 'Neetimati',
  'Kantamani', 'Rishabhapriya', 'Latangi', 'Vachaspati', 'Mechakalyani', 'Chitrambari',
  'Sucharitra', 'Jyotiswarupini', 'Dhatuvardhani', 'Nasikabhushani', 'Kosalam', 'Rasikapriya',
]

function melakarta(): ScaleSpec[] {
  const out: ScaleSpec[] = []
  let number = 1
  for (const ma of [500, 600]) {
    for (const [ri, ga] of MELA_RI_GA) {
      for (const [dha, ni] of MELA_DA_NI) {
        const name = MELA_NAMES[number - 1] ?? `Melakarta ${number}`
        out.push(spec(
          `mela-${number}`,
          name,
          'raga',
          [0, ri, ga, ma, 700, dha, ni],
          `Carnatic melakarta ${number}. A parent raga the janya ragas borrow from.`,
        ))
        number += 1
      }
    }
  }
  return out
}

function makam(id: string, name: string, steps: number[], description: string) {
  return spec(id, name, 'makam', fromKoma(steps), description)
}

function build(): ScaleSpec[] {
  const harmonicModes = [
    mode('harmonicMinor', 'harmonic', 1, 'hm-locrian-n6', 'Locrian ♮6', 'Second mode of harmonic minor. Locrian with a natural sixth.'),
    mode('harmonicMinor', 'harmonic', 2, 'hm-ionian-s5', 'Ionian ♯5', 'Third mode of harmonic minor. Major with a sharp fifth.'),
    mode('harmonicMinor', 'harmonic', 3, 'hm-dorian-s4', 'Dorian ♯4', 'Fourth mode of harmonic minor. Dorian with a raised fourth.'),
    mode('harmonicMinor', 'harmonic', 5, 'hm-lydian-s2', 'Lydian ♯2', 'Sixth mode of harmonic minor. Lydian with a raised second.'),
    mode('harmonicMinor', 'harmonic', 6, 'hm-ultralocrian', 'Ultralocrian', 'Seventh mode of harmonic minor. The most diminished mode.'),
  ]
  const melodicModes = [
    mode('melodicMinor', 'melodic', 1, 'mm-dorian-b2', 'Dorian ♭2', 'Second mode of melodic minor. Minor with a flat second.'),
    mode('melodicMinor', 'melodic', 2, 'mm-lydian-aug', 'Lydian augmented', 'Third mode of melodic minor. Lydian with a sharp fifth.'),
    mode('melodicMinor', 'melodic', 3, 'mm-lydian-dom', 'Lydian dominant', 'Fourth mode of melodic minor. The acoustic scale, a bright dominant.'),
    mode('melodicMinor', 'melodic', 4, 'mm-mixo-b6', 'Mixolydian ♭6', 'Fifth mode of melodic minor. Dominant with a flat sixth.'),
    mode('melodicMinor', 'melodic', 5, 'mm-locrian-n2', 'Locrian ♮2', 'Sixth mode of melodic minor. Half-diminished, with a natural second.'),
    mode('melodicMinor', 'melodic', 6, 'mm-altered', 'Altered', 'Seventh mode of melodic minor. Every tension on a dominant.'),
  ]
  const harmonicMajor = spec('harmonic-major', 'Harmonic major', 'harmonic-major', [0, 200, 400, 500, 700, 800, 1100], 'Major with a flat sixth. Bright, then suddenly dark.')
  const doubleHarmonic = spec('double-harmonic', 'Double harmonic', 'double', [0, 100, 400, 500, 700, 800, 1100], 'Major with a flat second and flat sixth. The Byzantine scale.')

  return [
    ...harmonicModes,
    ...melodicModes,
    harmonicMajor,
    ...modesOf(harmonicMajor, 'harmonic-major', [
      ['hmj-dorian-b5', 'Dorian ♭5', 'Second mode of harmonic major.'],
      ['hmj-phrygian-b4', 'Phrygian ♭4', 'Third mode of harmonic major.'],
      ['hmj-lydian-b3', 'Lydian ♭3', 'Fourth mode of harmonic major. Lydian minor.'],
      ['hmj-mixo-b2', 'Mixolydian ♭2', 'Fifth mode of harmonic major.'],
      ['hmj-lydian-aug-s2', 'Lydian ♯2 ♯5', 'Sixth mode of harmonic major.'],
      ['hmj-locrian-bb7', 'Locrian ♭♭7', 'Seventh mode of harmonic major.'],
    ]),
    doubleHarmonic,
    ...modesOf(doubleHarmonic, 'double', [
      ['dh-lydian-s2-s6', 'Lydian ♯2 ♯6', 'Second mode of double harmonic.'],
      ['dh-ultraphrygian', 'Ultraphrygian', 'Third mode of double harmonic.'],
      ['dh-hungarian-minor', 'Double harmonic minor', 'Fourth mode of double harmonic. A Gypsy minor.'],
      ['dh-oriental', 'Oriental', 'Fifth mode of double harmonic.'],
      ['dh-ionian-aug-s2', 'Ionian ♯2 ♯5', 'Sixth mode of double harmonic.'],
      ['dh-locrian-bb3-bb7', 'Locrian ♭♭3 ♭♭7', 'Seventh mode of double harmonic.'],
    ]),
    spec('egyptian', 'Egyptian', 'pentatonic', [0, 200, 500, 700, 1000], 'Suspended pentatonic. No third, so it can sit on major or minor.'),
    spec('dominant-pentatonic', 'Dominant pentatonic', 'pentatonic', [0, 200, 400, 700, 1000], 'Major pentatonic with a flat seventh.'),
    spec('minor6-pentatonic', 'Minor 6 pentatonic', 'pentatonic', [0, 300, 500, 700, 900], 'Minor pentatonic with a major sixth.'),
    spec('hirajoshi-pent', 'Kumoi', 'japanese', [0, 200, 300, 700, 900], 'A Japanese pentatonic, softer than Hirajoshi.'),
    spec('major-blues', 'Major blues', 'blues', [0, 200, 300, 400, 700, 900], 'Major pentatonic plus the blue note.'),
    spec('blues-heptatonic', 'Blues scale', 'blues', [0, 200, 300, 500, 600, 700, 900, 1000], 'Mixolydian with both blue notes.'),
    spec('bebop-dominant', 'Bebop dominant', 'bebop', [0, 200, 400, 500, 700, 900, 1000, 1100], 'Mixolydian plus a passing tone between the flat seventh and the root.'),
    spec('bebop-major', 'Bebop major', 'bebop', [0, 200, 400, 500, 700, 800, 900, 1100], 'Major plus a passing tone between five and six.'),
    spec('bebop-dorian', 'Bebop dorian', 'bebop', [0, 200, 300, 400, 500, 700, 900, 1000], 'Dorian plus a passing tone between the minor third and the fourth.'),
    spec('bebop-melodic', 'Bebop melodic minor', 'bebop', [0, 200, 300, 500, 700, 800, 900, 1100], 'Melodic minor plus a passing tone between five and six.'),
    spec('augmented', 'Augmented', 'symmetric', [0, 300, 400, 700, 800, 1100], 'Minor thirds and half steps, repeating.'),
    spec('tritone', 'Tritone', 'symmetric', [0, 100, 400, 600, 700, 1000], 'Built around the tritone. Unsettled.'),
    spec('prometheus', 'Prometheus', 'jazz', [0, 200, 400, 600, 900, 1000], 'A mystic chord as a scale. No fifth.'),
    spec('enigmatic', 'Enigmatic', 'other', [0, 100, 400, 600, 800, 1000, 1100], 'A rare Western scale. Half steps at both ends.'),
    spec('neapolitan-minor', 'Neapolitan minor', 'other', [0, 100, 300, 500, 700, 800, 1100], 'Harmonic minor with a flat second.'),
    spec('neapolitan-major', 'Neapolitan major', 'other', [0, 100, 300, 500, 700, 900, 1100], 'Melodic minor with a flat second.'),
    spec('hungarian-major', 'Hungarian major', 'other', [0, 300, 400, 600, 700, 900, 1100], 'Major with a sharp second and a sharp fourth.'),
    spec('spanish', 'Spanish', 'other', [0, 100, 400, 500, 700, 800, 1000], 'Phrygian with a major third. Eight-note Spanish is the longer cousin.'),
    spec('spanish-8', 'Spanish 8-tone', 'other', [0, 100, 300, 400, 500, 600, 800, 1000], 'A flamenco-leaning eight-note scale.'),
    spec('gypsy', 'Gypsy', 'other', [0, 200, 300, 600, 700, 800, 1000], 'Minor with two augmented seconds.'),
    spec('romanian-minor', 'Romanian minor', 'other', [0, 200, 300, 600, 700, 900, 1000], 'Dorian with a raised fourth. Also called Ukrainian dorian.'),
    spec('iwato', 'Iwato', 'japanese', [0, 100, 500, 600, 1000], 'A Japanese pentatonic with two half steps.'),
    spec('yo', 'Yo', 'japanese', [0, 200, 500, 700, 900], 'A bright Japanese pentatonic, close to major.'),
    spec('ritsu', 'Ritsu', 'japanese', [0, 200, 400, 700, 900], 'A Japanese scale close to the major pentatonic.'),
    spec('ryukyu', 'Ryukyu', 'japanese', [0, 400, 500, 700, 1100], 'Okinawan. The major third and major seventh stand out.'),
    spec('sakura', 'Sakura', 'japanese', [0, 100, 400, 700, 800], 'The cherry-blossom scale. Phrygian, then a jump.'),
    spec('hon-kumoi', 'Hon kumoi', 'japanese', [0, 200, 300, 700, 800], 'In-sen family, used for koto.'),
    ...thaats(),
    ...janya(),
    ...melakarta(),
    ...maqamat(),
    ...dastgah(),
    ...makamlar(),
    spec('slendro', 'Slendro', 'other', [0, 240, 480, 720, 960], 'Javanese five-note scale, nearly equal. The steps are a little sharp of 12-tone.'),
    spec('pelog', 'Pelog', 'other', [0, 120, 270, 540, 690, 780, 1020], 'A Balinese seven-note pelog, approximated in cents.'),
    spec('quarter-chromatic', 'Quarter-tone chromatic', 'other', Array.from({ length: 24 }, (_, index) => index * 50), 'Every quarter tone. Scale lock can land between the piano keys.'),
  ]
}

function modesOf(parent: ScaleSpec, family: string, rows: [string, string, string][]): ScaleSpec[] {
  return rows.map((row, index) => spec(row[0], row[1], family, rotateCents(parent.cents, index + 1), row[2]))
}

function thaats(): ScaleSpec[] {
  const rows: [string, string, number[], string][] = [
    ['thaat-bilawal', 'Bilawal', [0, 200, 400, 500, 700, 900, 1100], 'The Hindustani major thaat. The same notes as the major scale.'],
    ['thaat-khamaj', 'Khamaj', [0, 200, 400, 500, 700, 900, 1000], 'Mixolydian thaat. Major with a flat seventh.'],
    ['thaat-kafi', 'Kafi', [0, 200, 300, 500, 700, 900, 1000], 'Dorian thaat. The light minor of Hindustani music.'],
    ['thaat-asavari', 'Asavari', [0, 200, 300, 500, 700, 800, 1000], 'Natural minor thaat.'],
    ['thaat-bhairavi', 'Bhairavi', [0, 100, 300, 500, 700, 800, 1000], 'Phrygian thaat. All the flats.'],
    ['thaat-bhairav', 'Bhairav', [0, 100, 400, 500, 700, 800, 1100], 'Dawn raga thaat. Flat second, major third.'],
    ['thaat-kalyan', 'Kalyan', [0, 200, 400, 600, 700, 900, 1100], 'Lydian thaat. The raised fourth is the color.'],
    ['thaat-marwa', 'Marwa', [0, 100, 400, 600, 900, 1100], 'No fifth. Flat second and raised fourth, hovering.'],
    ['thaat-poorvi', 'Poorvi', [0, 100, 400, 600, 700, 800, 1100], 'Flat second, raised fourth, flat sixth.'],
    ['thaat-todi', 'Todi', [0, 100, 300, 600, 700, 800, 1100], 'The serious morning thaat. Flat second, raised fourth.'],
  ]
  return rows.map((row) => spec(row[0], row[1], 'raga', row[2], row[3]))
}

function janya(): ScaleSpec[] {
  const rows: [string, string, number[], string][] = [
    ['raga-yaman', 'Yaman', [0, 200, 400, 600, 700, 900, 1100], 'Night raga. The raised fourth glows over a major scale.'],
    ['raga-bhimpalasi', 'Bhimpalasi', [0, 200, 300, 500, 700, 1000], 'Afternoon raga. Minor, with no sixth in the ascent.'],
    ['raga-bageshri', 'Bageshri', [0, 200, 300, 500, 800, 1000], 'Late night. Minor, and the fifth is often skipped.'],
    ['raga-darbari', 'Darbari', [0, 200, 250, 500, 700, 750, 1000], 'A grave night raga. The third and sixth are sung extra flat.'],
    ['raga-malkauns', 'Malkauns', [0, 300, 500, 800, 1000], 'A midnight pentatonic. All flat, no second.'],
    ['raga-bhupali', 'Bhupali', [0, 200, 400, 700, 900], 'Early night pentatonic. The major pentatonic of Hindustani music.'],
    ['raga-desh', 'Desh', [0, 200, 400, 500, 700, 900, 1000], 'Monsoon raga. Major, then a flat seventh on the way down.'],
    ['raga-bhairav', 'Bhairav', [0, 100, 400, 500, 700, 800, 1100], 'Dawn. The flat second leans into the tonic.'],
    ['raga-todi', 'Miyan ki Todi', [0, 100, 300, 600, 700, 800, 1100], 'Late morning. Serious, with a raised fourth.'],
    ['raga-marwa', 'Marwa', [0, 100, 400, 600, 900, 1100], 'Sunset. No fifth, so the tonic never quite arrives.'],
    ['raga-puriya', 'Puriya', [0, 100, 400, 600, 900, 1100], 'Dusk, close to Marwa, a shade more still.'],
    ['raga-hansadhvani', 'Hamsadhvani', [0, 200, 400, 700, 1100], 'A five-note blessing. Major, with no fourth or sixth.'],
    ['raga-mohanam', 'Mohanam', [0, 200, 400, 700, 900], 'Carnatic major pentatonic. Light and open.'],
    ['raga-hindolam', 'Hindolam', [0, 300, 500, 800, 1100], 'Carnatic pentatonic. Minor, with a major seventh.'],
    ['raga-madhuvanti', 'Madhuvanti', [0, 200, 300, 600, 700, 900, 1100], 'A sweet minor with a raised fourth.'],
    ['raga-jog', 'Jog', [0, 300, 400, 500, 700, 1000], 'Both thirds. Minor and major in the same raga.'],
    ['raga-ahir-bhairav', 'Ahir Bhairav', [0, 100, 400, 500, 700, 900, 1000], 'Morning. Bhairav on the bottom, Kafi on the top.'],
    ['raga-kirwani', 'Kirwani', [0, 200, 300, 500, 700, 800, 1100], 'Harmonic minor as a raga. A raised seventh.'],
    ['raga-charukesi', 'Charukesi', [0, 200, 400, 500, 700, 800, 1100], 'Melakarta 26. Major, then a flat sixth.'],
    ['raga-shivaranjani', 'Shivaranjani', [0, 200, 300, 700, 900], 'A small pentatonic, minor and wistful.'],
    ['raga-durga', 'Durga', [0, 200, 500, 700, 900], 'Pentatonic with no third. Open, folk-like.'],
    ['raga-chandrakauns', 'Chandrakauns', [0, 300, 500, 800, 1100], 'Night pentatonic. Minor third, major seventh.'],
    ['raga-kalavati', 'Kalavati', [0, 200, 400, 700, 1000], 'Five notes. Major third, flat seventh, no sixth.'],
    ['raga-abhogi', 'Abhogi', [0, 200, 300, 500, 900], 'Carnatic pentatonic. No fifth, no seventh.'],
    ['raga-amritavarshini', 'Amritavarshini', [0, 400, 600, 700, 1100], 'A rain raga. Lydian, with no second or sixth.'],
  ]
  return rows.map((row) => spec(row[0], row[1], 'raga', row[2], row[3]))
}

function maqamat(): ScaleSpec[] {
  const rows: [string, string, number[], string][] = [
    ['maqam-rast', 'Rast', [0, 200, 350, 500, 700, 900, 1050], 'The Arabic major. The thirds are quarter tones, halfway to minor.'],
    ['maqam-bayati', 'Bayati', [0, 150, 300, 500, 700, 900, 1050], 'A quarter-flat second. Folk songs and calls to prayer often sit here.'],
    ['maqam-hijaz', 'Hijaz', [0, 100, 400, 500, 700, 800, 1000], 'A flat second and a major third. The augmented second is the hook.'],
    ['maqam-hijaz-kar', 'Hijaz Kar', [0, 100, 400, 500, 700, 800, 1100], 'Hijaz with a raised seventh. It pulls harder toward the tonic.'],
    ['maqam-nahawand', 'Nahawand', [0, 200, 300, 500, 700, 800, 1100], 'Arabic harmonic minor. Minor, with a leading tone.'],
    ['maqam-nahawand-murassah', 'Nahawand murassah', [0, 200, 300, 500, 700, 800, 1000], 'Nahawand with a flat seventh. Softer than the harmonic form.'],
    ['maqam-kurd', 'Kurd', [0, 100, 300, 500, 700, 800, 1000], 'Phrygian maqam. A flat second all the way down.'],
    ['maqam-sikah', 'Sikah', [0, 150, 350, 500, 650, 850, 1050], 'The tonic itself is a quarter tone. Three-quarter-flat steps.'],
    ['maqam-huzam', 'Huzam', [0, 150, 350, 500, 650, 850, 1000], 'Sikah family. Quarter tones on the second and the sixth.'],
    ['maqam-rahat', 'Rahat al-Arwah', [0, 150, 350, 500, 700, 800, 1050], 'A Sikah opening that turns toward a minor upper tetrachord.'],
    ['maqam-iraq', 'Iraq', [0, 150, 350, 500, 650, 800, 1000], 'Another Sikah maqam, a little darker on the way down.'],
    ['maqam-saba', 'Saba', [0, 150, 300, 400, 650, 700, 1000], 'The homesick maqam. A flat fifth and a quarter-flat second.'],
    ['maqam-suznak', 'Suznak', [0, 200, 350, 500, 700, 800, 1100], 'Rast on the bottom, Hijaz on the top.'],
    ['maqam-nikriz', 'Nikriz', [0, 200, 300, 600, 700, 900, 1000], 'Minor third, then a raised fourth. A sharp turn in the middle.'],
    ['maqam-nawa-athar', 'Nawa Athar', [0, 200, 300, 600, 700, 800, 1100], 'Nahawand with a raised fourth. Two augmented seconds.'],
    ['maqam-athar-kurd', 'Athar Kurd', [0, 100, 300, 600, 700, 800, 1100], 'Kurd with a raised fourth and a raised seventh.'],
    ['maqam-ajam', 'Ajam', [0, 200, 400, 500, 700, 900, 1100], 'The 12-tone major, used when a maqam wants no quarter tone.'],
    ['maqam-jiharkah', 'Jiharkah', [0, 200, 400, 500, 700, 900, 1000], 'Major with a flat seventh. The Ajam cousin of Mixolydian.'],
    ['maqam-saba-zamzam', 'Saba Zamzam', [0, 100, 300, 400, 650, 700, 1000], 'Saba with a flat second instead of a quarter flat.'],
    ['maqam-mustaar', 'Mustaar', [0, 150, 350, 550, 700, 850, 1050], 'Sikah with a raised fourth. Rare, and very tense.'],
    ['maqam-bayatayn', 'Bayatayn', [0, 150, 300, 500, 650, 850, 1000], 'Bayati that keeps a quarter tone in the upper half.'],
    ['maqam-farahfaza', 'Farahfaza', [0, 200, 400, 500, 700, 800, 1100], 'Major on the bottom, harmonic minor on the top.'],
    ['maqam-hijaz-humayun', 'Hijaz Humayun', [0, 100, 400, 500, 700, 850, 1000], 'Hijaz whose sixth is a quarter tone.'],
    ['maqam-nairuz', 'Nairuz', [0, 200, 350, 500, 700, 850, 1100], 'Rast, with a quarter-flat sixth and a leading tone.'],
    ['maqam-yakah', 'Yakah', [0, 200, 300, 500, 700, 900, 1000], 'A light minor maqam. Close to Dorian.'],
  ]
  return rows.map((row) => spec(row[0], row[1], 'maqam', row[2], row[3]))
}

function dastgah(): ScaleSpec[] {
  const rows: [string, string, number[], string][] = [
    ['dastgah-shur', 'Shur', [0, 150, 300, 500, 700, 850, 1000], 'The main Persian mode. A koron (quarter-flat) on the second and the sixth.'],
    ['dastgah-abu-ata', 'Abu Ata', [0, 150, 300, 500, 700, 800, 1000], 'An avaz of Shur. The sixth is flat instead of koron.'],
    ['dastgah-dashti', 'Dashti', [0, 150, 300, 500, 650, 800, 1000], 'An avaz of Shur. Narrow, and often sung.'],
    ['dastgah-afshari', 'Afshari', [0, 150, 300, 500, 650, 800, 1050], 'An avaz of Shur with a raised leading tone.'],
    ['dastgah-bayat-tork', 'Bayat-e Tork', [0, 200, 350, 500, 700, 850, 1000], 'An avaz of Shur that opens like a major scale with a koron third.'],
    ['dastgah-segah', 'Segah', [0, 140, 340, 500, 700, 840, 1040], 'The tonic is felt a koron below the third of Shur.'],
    ['dastgah-chahargah', 'Chahargah', [0, 140, 390, 500, 700, 840, 1090], 'Two augmented seconds. The most major-sounding dastgah that is not Mahur.'],
    ['dastgah-homayun', 'Homayun', [0, 135, 390, 500, 700, 800, 1085], 'A koron second, then a jump to the third. Noble and sad.'],
    ['dastgah-esfahan', 'Bayat-e Esfahan', [0, 200, 300, 500, 700, 850, 1100], 'An avaz of Homayun. Harmonic minor with a koron sixth.'],
    ['dastgah-nava', 'Nava', [0, 200, 300, 500, 700, 850, 1000], 'Minor, with a koron sixth. Calm.'],
    ['dastgah-mahur', 'Mahur', [0, 200, 400, 500, 700, 900, 1100], 'The Persian major. No koron. Festive.'],
    ['dastgah-rast-panjgah', 'Rast-Panjgah', [0, 200, 350, 500, 700, 900, 1050], 'Close to Arabic Rast. A koron third and a koron seventh.'],
  ]
  return rows.map((row) => spec(row[0], row[1], 'dastgah', row[2], row[3]))
}

function makamlar(): ScaleSpec[] {
  const rows: [string, string, number[], string][] = [
    ['makam-rast', 'Rast', [9, 8, 5, 9, 9, 8, 5], 'The Turkish major. The thirds sit a comma flat of 12-tone major.'],
    ['makam-ussak', 'Uşşak', [8, 5, 9, 9, 8, 5, 9], 'A soft minor second. The first step is a küçük mücennep, about 181 cents.'],
    ['makam-huseyni', 'Hüseyni', [8, 5, 9, 9, 9, 4, 9], 'Like Uşşak, with a brighter top. A common folk makam.'],
    ['makam-hicaz', 'Hicaz', [5, 12, 5, 9, 8, 5, 9], 'A small second, then an augmented second. The Turkish Hijaz.'],
    ['makam-hicazkar', 'Hicazkar', [5, 12, 5, 9, 5, 12, 5], 'Hicaz in both tetrachords. The leading tone is low.'],
    ['makam-nikriz', 'Nikriz', [9, 4, 13, 5, 9, 8, 5], 'A minor third and a raised fourth, in comma steps.'],
    ['makam-nihavent', 'Nihavent', [9, 4, 9, 9, 4, 13, 5], 'Turkish harmonic minor. The leading tone is a comma sharp of a flat seventh.'],
    ['makam-kurdi', 'Kürdi', [4, 9, 9, 9, 4, 9, 9], 'Phrygian in commas. The second is only a bakiye, about 90 cents.'],
    ['makam-buselik', 'Buselik', [9, 4, 9, 9, 9, 4, 9], 'A minor makam with a natural sixth.'],
    ['makam-segah', 'Segah', [5, 8, 9, 5, 9, 8, 9], 'The tonic is the segâh perde, a comma flat of a minor third above Rast.'],
    ['makam-huzzam', 'Hüzzam', [5, 8, 9, 5, 8, 9, 9], 'Segah family. A favorite for vocal music.'],
    ['makam-saba', 'Saba', [8, 5, 5, 13, 5, 8, 9], 'The flat fifth is the point. Longing, and hard to leave.'],
    ['makam-karcigar', 'Karcığar', [8, 5, 9, 5, 8, 9, 9], 'Uşşak below, Hicaz above.'],
    ['makam-suzinak', 'Suzinak', [9, 8, 5, 9, 5, 12, 5], 'Rast below, Hicaz above.'],
    ['makam-neva', 'Neva', [9, 4, 9, 9, 8, 5, 9], 'A light minor, close to Dorian in commas.'],
    ['makam-mahur', 'Mahur', [9, 8, 5, 9, 9, 9, 4], 'Bright, close to major. The seventh is a little flat of the leading tone.'],
    ['makam-acem-asiran', 'Acem Aşiran', [9, 4, 9, 9, 4, 9, 9], 'Natural minor in the Arel-Ezgi commas.'],
    ['makam-evcara', 'Evcara', [5, 12, 5, 9, 9, 8, 5], 'Hicaz on the bottom, Rast on the top.'],
    ['makam-ferahfeza', 'Ferahfeza', [9, 4, 9, 9, 9, 8, 5], 'Minor opening, major-colored top.'],
    ['makam-sultaniyegah', 'Sultaniyegah', [9, 4, 9, 9, 4, 12, 6], 'A harmonic-minor cousin used for larger vocal pieces.'],
    ['makam-pesendide', 'Pesendide', [8, 5, 9, 9, 5, 12, 5], 'Uşşak below, a Hicaz cadence on top.'],
    ['makam-sedaraban', 'Şedaraban', [5, 12, 5, 9, 4, 13, 5], 'Hicaz below and a raised leading tone.'],
    ['makam-bestenigar', 'Bestenigar', [8, 5, 8, 9, 8, 5, 10], 'A compound makam. The sixth is a comma flat.'],
    ['makam-isfahan', 'Isfahan', [9, 4, 9, 5, 8, 9, 9], 'A minor makam with a Hicaz-colored upper half.'],
    ['makam-tahir', 'Tahir', [8, 5, 9, 9, 8, 8, 6], 'Close to Uşşak, with a slightly low seventh.'],
  ]
  return rows.map((row) => makam(row[0], row[1], row[2], row[3]))
}

export const WORLD_SCALES: ScaleSpec[] = build()

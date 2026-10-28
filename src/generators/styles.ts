import type { ArpPattern, StrumPattern } from './types'

export type ChordColor = 'triad' | 'seventh' | 'ninth' | 'sus' | 'dyad' | 'shell' | 'dom' | 'min'
export type BassPick = 'root' | 'fifth' | 'oct' | 'third' | 'seventh' | 'below' | 'next'
export type ChordStep = number | { d: number; c: ChordColor }

export interface BassHit {
  at: number
  dur: number
  pick: BassPick
  vel: number
}

export interface Style {
  id: string
  name: string
  blurb: string
  swing: number
  color: ChordColor
  major: ChordStep[][]
  minor: ChordStep[][]
  /** Used when the phrase is 8 bars or longer. */
  long?: ChordStep[]
  bass: BassHit[]
  walk?: boolean
  pedal?: boolean
  low?: boolean
  slide?: boolean
  /** 16 weights, 1–9. 8 and 9 always play. */
  melody: string
  arp: { pattern: ArpPattern; rate: number; octaves: number; gate: number }
  strum: StrumPattern
  rolls?: boolean
  drums: { kick: string; snare: string; hat: string; extra?: { pitch: number; row: string }[] }
}

const b = (at: number, dur: number, pick: BassPick, vel = 0.84): BassHit => ({ at, dur, pick, vel })

export const STYLES: Style[] = [
  {
    id: 'pop',
    name: 'Pop',
    blurb: 'Even kick, backbeat, and a bright four-chord loop.',
    swing: 0,
    color: 'triad',
    major: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 5, 3, 4]],
    minor: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 3]],
    bass: [b(0, 1.4, 'root', 0.88), b(2, 1.4, 'fifth', 0.76)],
    melody: '8...6...7...5...',
    arp: { pattern: 'up', rate: 0.5, octaves: 2, gate: 0.8 },
    strum: 'down',
    drums: { kick: '8.......8.......', snare: '....8.......8...', hat: '5.5.5.5.5.5.5.5.' },
  },
  {
    id: 'trap',
    name: 'Trap',
    blurb: 'Half-time snare, a long 808, and rolling hats.',
    swing: 0,
    color: 'triad',
    major: [[0, 4, 5, 3], [5, 3, 0, 4]],
    minor: [[0, 5, 4, 6], [0, 5, 6, 0], [0, 3, 5, 6]],
    bass: [b(0, 1.7, 'root', 0.96), b(2.5, 0.35, 'oct', 0.72), b(3.45, 0.4, 'next', 0.64)],
    low: true,
    slide: true,
    melody: '9.......7.......',
    arp: { pattern: 'up', rate: 0.5, octaves: 2, gate: 0.7 },
    strum: 'block',
    rolls: true,
    drums: { kick: '8..6.....8..5...', snare: '........8.......', hat: '6.4.6.4.7.5.6.3.' },
  },
  {
    id: 'boom-bap',
    name: 'Boom bap',
    blurb: 'Swung kick, ghost snares, and a dusty backbeat.',
    swing: 0.58,
    color: 'seventh',
    major: [[1, 4, 0, 5], [0, 5, 1, 4]],
    minor: [[0, 3, 0, 4], [0, 5, 3, 4]],
    bass: [b(0, 0.7, 'root', 0.86), b(1.5, 0.4, 'fifth', 0.7), b(2.5, 0.45, 'oct', 0.74), b(3.5, 0.3, 'root', 0.66)],
    melody: '6..4..5...4.6...',
    arp: { pattern: 'broken', rate: 0.5, octaves: 1, gate: 0.75 },
    strum: 'jazz',
    drums: { kick: '8.....8.5..6....', snare: '....8...3...8...', hat: '6.4.6.4.6.4.6.4.', extra: [{ pitch: 39, row: '....6.......6...' }] },
  },
  {
    id: 'house',
    name: 'House',
    blurb: 'Four on the floor and chords on the off-beat.',
    swing: 0,
    color: 'triad',
    major: [[5, 3, 0, 4], [0, 3, 5, 4]],
    minor: [[0, 5, 2, 6], [0, 3, 0, 6]],
    bass: [b(0, 0.4, 'root', 0.9), b(1, 0.35, 'root', 0.82), b(2, 0.4, 'oct', 0.8), b(3, 0.35, 'fifth', 0.78)],
    melody: '..7...6...7...5.',
    arp: { pattern: 'upDown', rate: 0.25, octaves: 2, gate: 0.45 },
    strum: 'disco',
    drums: { kick: '8...8...8...8...', snare: '....7.......7...', hat: '4...4...4...4...', extra: [{ pitch: 46, row: '..6...6...6...6.' }] },
  },
  {
    id: 'techno',
    name: 'Techno',
    blurb: 'A steady kick, short pulses, and a narrow loop.',
    swing: 0,
    color: 'triad',
    major: [[0, 0, 3, 4], [0, 3, 0, 0]],
    minor: [[0, 0, 3, 0], [0, 6, 0, 5]],
    bass: [b(0, 0.22, 'root', 0.9), b(0.5, 0.16, 'root', 0.55), b(1.5, 0.16, 'root', 0.6), b(2, 0.22, 'oct', 0.84), b(2.5, 0.16, 'root', 0.5), b(3.5, 0.16, 'fifth', 0.58)],
    low: true,
    melody: '5.4.5.4.5.4.3.4.',
    arp: { pattern: 'up', rate: 0.25, octaves: 2, gate: 0.35 },
    strum: 'funk',
    drums: { kick: '9...9...9...9...', snare: '....8.......8...', hat: '4.6.4.6.4.6.4.6.', extra: [{ pitch: 37, row: '......5.......5.' }] },
  },
  {
    id: 'drill',
    name: 'Drill',
    blurb: 'Sparse 808 slides and a snare that sits late.',
    swing: 0,
    color: 'triad',
    major: [[0, 5, 3, 0], [0, 3, 5, 0]],
    minor: [[0, 5, 6, 0], [0, 3, 6, 5]],
    bass: [b(0, 1.3, 'root', 0.97), b(2.7, 0.4, 'oct', 0.74), b(3.35, 0.5, 'below', 0.7)],
    low: true,
    slide: true,
    melody: '9.........6.....',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.65 },
    strum: 'block',
    rolls: true,
    drums: { kick: '8.....6...8.....', snare: '........9.......', hat: '7.5.6.4.7.3.6.5.' },
  },
  {
    id: 'afrobeats',
    name: 'Afrobeats',
    blurb: 'Off-beat chords and a bass that answers late.',
    swing: 0,
    color: 'triad',
    major: [[0, 4, 5, 3], [0, 3, 4, 3]],
    minor: [[0, 5, 2, 6], [0, 3, 5, 6]],
    bass: [b(0, 0.35, 'root', 0.88), b(1, 0.28, 'fifth', 0.72), b(1.75, 0.35, 'root', 0.8), b(2.5, 0.3, 'oct', 0.74), b(3.25, 0.28, 'fifth', 0.7)],
    melody: '7..5..6...5.7...',
    arp: { pattern: 'upDown', rate: 0.5, octaves: 1, gate: 0.55 },
    strum: 'afro',
    drums: { kick: '8....6..5..6....', snare: '....6.....6...6.', hat: '5.5.5.5.5.5.5.5.', extra: [{ pitch: 54, row: '..4...4...4...4.' }] },
  },
  {
    id: 'amapiano',
    name: 'Amapiano',
    blurb: 'Log-drum bass, a soft shaker, and jazzy chords.',
    swing: 0.12,
    color: 'seventh',
    major: [[0, 5, 3, 4], [0, 3, 0, 4]],
    minor: [[0, 3, 4, 3], [0, 5, 3, 6]],
    bass: [b(0, 0.28, 'root', 0.9), b(0.75, 0.22, 'fifth', 0.7), b(1.25, 0.28, 'oct', 0.78), b(2, 0.28, 'root', 0.86), b(2.75, 0.22, 'third', 0.68), b(3.25, 0.28, 'oct', 0.76)],
    low: true,
    melody: '6...5.6...4...7.',
    arp: { pattern: 'broken', rate: 0.5, octaves: 2, gate: 0.6 },
    strum: 'jazz',
    drums: { kick: '8....6.....5....', snare: '....7.......7...', hat: '5.3.5.3.5.3.5.3.', extra: [{ pitch: 54, row: '4.4.4.4.4.4.4.4.' }] },
  },
  {
    id: 'reggaeton',
    name: 'Reggaeton',
    blurb: 'Dembow kick and snare under a minor loop.',
    swing: 0,
    color: 'triad',
    major: [[0, 4, 5, 3], [0, 3, 4, 0]],
    minor: [[0, 5, 2, 6], [0, 3, 5, 4]],
    bass: [b(0, 0.4, 'root', 0.92), b(0.75, 0.28, 'root', 0.74), b(1.5, 0.35, 'fifth', 0.8), b(2.5, 0.32, 'root', 0.84)],
    low: true,
    melody: '8...6...5...7...',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.6 },
    strum: 'tresillo',
    drums: { kick: '8..8..8...8.....', snare: '....8..8....8..8', hat: '5.5.5.5.5.5.5.5.' },
  },
  {
    id: 'rnb',
    name: 'R&B',
    blurb: 'Smooth sevenths and a bass that leans late.',
    swing: 0.28,
    color: 'ninth',
    major: [[1, 4, 0, 5], [0, 5, 1, 4]],
    minor: [[0, 3, 6, 4], [0, 5, 3, 4]],
    bass: [b(0.05, 0.65, 'root', 0.84), b(1.5, 0.35, 'fifth', 0.7), b(2.25, 0.35, 'third', 0.68), b(3, 0.4, 'seventh', 0.72), b(3.75, 0.18, 'next', 0.55)],
    melody: '7..5.6...5..4...',
    arp: { pattern: 'broken', rate: 0.5, octaves: 1, gate: 0.85 },
    strum: 'jazz',
    drums: { kick: '8.....6...6.....', snare: '....8...3...8...', hat: '4.5.4.5.4.5.4.5.' },
  },
  {
    id: 'rock',
    name: 'Rock',
    blurb: 'Backbeat, eighth-note hats, and a plain riff.',
    swing: 0,
    color: 'triad',
    major: [[0, 3, 4, 3], [0, 6, 3, 0], [0, 3, 0, 4]],
    minor: [[0, 6, 5, 6], [0, 5, 6, 0]],
    bass: [b(0, 0.85, 'root', 0.9), b(2, 0.35, 'root', 0.78), b(2.5, 0.35, 'fifth', 0.74), b(3.5, 0.28, 'root', 0.7)],
    melody: '8...7...6...5...',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.7 },
    strum: 'rock',
    drums: { kick: '8.......8..6....', snare: '....9.......9...', hat: '7.7.7.7.7.7.7.7.', extra: [{ pitch: 49, row: '6...............' }] },
  },
  {
    id: 'funk',
    name: 'Funk',
    blurb: 'Sixteenth-note pops and short stabbed chords.',
    swing: 0.08,
    color: 'dom',
    major: [[0, 3, 0, 3], [0, 0, 3, 4]],
    minor: [[0, 3, 0, 3], [0, 3, 6, 3]],
    bass: [b(0, 0.18, 'root', 0.92), b(0.75, 0.14, 'oct', 0.7), b(1.5, 0.18, 'root', 0.84), b(2.25, 0.14, 'fifth', 0.68), b(2.75, 0.14, 'oct', 0.72), b(3.5, 0.16, 'root', 0.8)],
    melody: '6.5.4.6.5.3.6.4.',
    arp: { pattern: 'inside', rate: 0.25, octaves: 1, gate: 0.4 },
    strum: 'funk',
    drums: { kick: '8..6..5...6.5...', snare: '....8...3...8.3.', hat: '6.4.6.5.6.4.6.3.' },
  },
  {
    id: 'jazz',
    name: 'Jazz',
    blurb: 'Swing, shell voicings, and a walking bass.',
    swing: 0.72,
    color: 'shell',
    major: [[1, 4, 0, 5], [0, 5, 1, 4], [2, 5, 1, 4]],
    minor: [[1, 4, 0, 0], [0, 3, 6, 4]],
    bass: [],
    walk: true,
    melody: '6.5.6.4.6.5.4.3.',
    arp: { pattern: 'broken', rate: 0.5, octaves: 1, gate: 0.8 },
    strum: 'jazz',
    drums: {
      kick: '4.......4.......',
      snare: '................',
      hat: '................',
      extra: [
        { pitch: 51, row: '6.4.6.4.6.4.6.4.' },
        { pitch: 37, row: '..3...5...3...4.' },
      ],
    },
  },
  {
    id: 'lofi',
    name: 'Lo-fi',
    blurb: 'Slow swing, soft sevenths, and a lazy bass.',
    swing: 0.6,
    color: 'seventh',
    major: [[0, 5, 1, 4], [1, 4, 0, 5]],
    minor: [[0, 3, 6, 5], [0, 5, 3, 4]],
    bass: [b(0.08, 1.5, 'root', 0.72), b(2.12, 1.3, 'fifth', 0.64)],
    melody: '8.....6.....5...',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.9 },
    strum: 'block',
    drums: { kick: '7.....5.........', snare: '....6.......6...', hat: '5.3.5.3.5.3.5.3.' },
  },
  {
    id: 'gospel',
    name: 'Gospel',
    blurb: 'A borrowed minor color and a bass that walks into the next chord.',
    swing: 0.16,
    color: 'triad',
    major: [[0, 3, { d: 3, c: 'min' }, 0], [0, 4, 5, { d: 3, c: 'min' }], [0, 4, 5, 3]],
    minor: [[0, 3, 0, 5], [0, 5, 3, 6]],
    bass: [b(0, 0.8, 'root', 0.86), b(1.5, 0.35, 'fifth', 0.7), b(2, 0.6, 'oct', 0.78), b(3, 0.4, 'third', 0.68), b(3.75, 0.18, 'next', 0.6)],
    melody: '7..6..5...6.5.7.',
    arp: { pattern: 'upDown', rate: 0.5, octaves: 1, gate: 0.85 },
    strum: 'gospel',
    drums: { kick: '8....6..8.......', snare: '....8.......8...', hat: '6.6.6.6.6.6.6.6.', extra: [{ pitch: 54, row: '..4...4...4...4.' }] },
  },
  {
    id: 'maqam',
    name: 'Maqam',
    blurb: 'A pedal tone, jins steps, and a maqsum darbuka.',
    swing: 0,
    color: 'dyad',
    major: [[0, 1, 0, 4], [0, 3, 4, 0], [0, 0, 4, 3]],
    minor: [[0, 1, 0, 3], [0, 4, 3, 0], [0, 1, 4, 0]],
    bass: [b(0, 3.6, 'root', 0.8)],
    pedal: true,
    melody: '8.6.7.6.8.....5.',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.9 },
    strum: 'block',
    drums: { kick: '8.......8.......', snare: '................', hat: '................', extra: [{ pitch: 37, row: '..7...7.......7.' }] },
  },
  {
    id: 'latin',
    name: 'Latin',
    blurb: 'Son clave, tumbao bass, and a montuno.',
    swing: 0,
    color: 'triad',
    major: [[0, 3, 4, 0], [0, 4, 3, 4]],
    minor: [[0, 5, 2, 6], [0, 3, 4, 0]],
    bass: [b(0, 0.35, 'root', 0.86), b(1.5, 0.3, 'fifth', 0.74), b(2.5, 0.28, 'oct', 0.72), b(3.5, 0.28, 'root', 0.8)],
    melody: '6..5..7.5...6...',
    arp: { pattern: 'upDown', rate: 0.5, octaves: 1, gate: 0.55 },
    strum: 'montuno',
    drums: {
      kick: '8.......8...5...',
      snare: '................',
      hat: '4.4.4.4.4.4.4.4.',
      extra: [
        { pitch: 75, row: '8..8..8...8.8...' },
        { pitch: 62, row: '.7..7.7..7..7.7.' },
      ],
    },
  },
  {
    id: 'reggae',
    name: 'Reggae',
    blurb: 'Off-beat chords and a one-drop kick.',
    swing: 0,
    color: 'triad',
    major: [[0, 4, 5, 3], [0, 3, 0, 4]],
    minor: [[0, 5, 2, 6], [0, 3, 5, 6]],
    bass: [b(0.5, 0.4, 'root', 0.86), b(2.5, 0.4, 'fifth', 0.78)],
    melody: '..7...6...7...5.',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.5 },
    strum: 'skank',
    drums: { kick: '........8.......', snare: '........8.......', hat: '..5...5...5...5.' },
  },
  {
    id: 'disco',
    name: 'Disco',
    blurb: 'Four on the floor and an octave bass.',
    swing: 0,
    color: 'triad',
    major: [[0, 3, 0, 4], [0, 5, 3, 4]],
    minor: [[0, 5, 3, 6], [0, 3, 0, 4]],
    bass: [b(0, 0.32, 'root', 0.9), b(0.5, 0.24, 'oct', 0.72), b(1, 0.32, 'root', 0.86), b(1.5, 0.24, 'oct', 0.7), b(2, 0.32, 'fifth', 0.84), b(2.5, 0.24, 'oct', 0.68), b(3, 0.32, 'root', 0.86), b(3.5, 0.24, 'oct', 0.7)],
    melody: '5...6...5...7...',
    arp: { pattern: 'upDown', rate: 0.25, octaves: 2, gate: 0.4 },
    strum: 'disco',
    drums: { kick: '8...8...8...8...', snare: '....8.......8...', hat: '5...5...5...5...', extra: [{ pitch: 46, row: '..7...7...7...7.' }] },
  },
  {
    id: 'dnb',
    name: 'Drum & bass',
    blurb: 'A fast break and a bass that keeps moving.',
    swing: 0,
    color: 'triad',
    major: [[0, 5, 3, 4], [5, 3, 0, 6]],
    minor: [[0, 5, 3, 6], [0, 0, 5, 6]],
    bass: [b(0, 0.32, 'root', 0.92), b(0.75, 0.22, 'root', 0.7), b(2, 0.3, 'fifth', 0.82), b(2.75, 0.24, 'oct', 0.74)],
    low: true,
    melody: '6.4.5.6.3...5.4.',
    arp: { pattern: 'upDown', rate: 0.25, octaves: 2, gate: 0.35 },
    strum: 'funk',
    drums: { kick: '8...5.....8.5...', snare: '....8..8....8..5', hat: '6.4.6.4.6.4.6.4.' },
  },
  {
    id: 'blues',
    name: 'Blues',
    blurb: 'A shuffle and dominant chords, twelve bars when you have room.',
    swing: 0.66,
    color: 'dom',
    major: [[0, 3, 0, 4], [0, 0, 3, 4]],
    minor: [[0, 3, 0, 4], [0, 3, 4, 0]],
    long: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4],
    bass: [b(0, 0.85, 'root', 0.88), b(1, 0.7, 'fifth', 0.74), b(2, 0.7, 'root', 0.8), b(3, 0.55, 'below', 0.7)],
    melody: '7.5.6.4.7.5.4.6.',
    arp: { pattern: 'up', rate: 0.5, octaves: 1, gate: 0.7 },
    strum: 'rock',
    drums: { kick: '8.......8.......', snare: '....8.......8...', hat: '................', extra: [{ pitch: 51, row: '6.4.6.4.6.4.6.4.' }] },
  },
  {
    id: 'bossa',
    name: 'Bossa',
    blurb: 'Soft clave, gentle sevenths, and a quiet bass.',
    swing: 0,
    color: 'seventh',
    major: [[0, 5, 1, 4], [0, 3, 4, 0]],
    minor: [[0, 3, 6, 4], [0, 5, 3, 4]],
    bass: [b(0, 0.55, 'root', 0.7), b(1.5, 0.4, 'fifth', 0.6), b(3, 0.45, 'oct', 0.58)],
    melody: '6...5...7...4...',
    arp: { pattern: 'broken', rate: 0.5, octaves: 1, gate: 0.85 },
    strum: 'jazz',
    drums: { kick: '8...5...6...5...', snare: '................', hat: '3.3.3.3.3.3.3.3.', extra: [{ pitch: 37, row: '8..5..8...8.5...' }] },
  },
]

export function styleById(id: string) {
  return STYLES.find((style) => style.id === id) ?? STYLES[0]
}

export function rowVelocities(row: string) {
  const chars = row.padEnd(16, '.').slice(0, 16)
  return [...chars].map((char) => {
    if (char === '.' || char === '0') return 0
    const value = Number.parseInt(char, 10)
    return Number.isFinite(value) ? value / 8 : 0
  })
}

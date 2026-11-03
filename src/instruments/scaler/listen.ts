import { yinPitch } from '../../audio/stretch/voice'
import { NOTE_NAMES } from '../../theory/pitch'

const TEMPLATES: { suffix: string; intervals: number[] }[] = [
  { suffix: 'maj7', intervals: [0, 4, 7, 11] },
  { suffix: '7', intervals: [0, 4, 7, 10] },
  { suffix: 'm7', intervals: [0, 3, 7, 10] },
  { suffix: 'dim', intervals: [0, 3, 6] },
  { suffix: 'aug', intervals: [0, 4, 8] },
  { suffix: 'sus4', intervals: [0, 5, 7] },
  { suffix: 'sus2', intervals: [0, 2, 7] },
  { suffix: '', intervals: [0, 4, 7] },
  { suffix: 'm', intervals: [0, 3, 7] },
]

export interface HeardPitch {
  midi: number
  cents?: number
  weight: number
}

/** Monophonic pitches from a buffer, for key detection. */
export function pitchesFromAudio(channel: Float32Array, sampleRate: number): HeardPitch[] {
  if (channel.length < 1024 || sampleRate < 1000) return []
  const frame = Math.min(4096, channel.length)
  const hop = Math.max(512, Math.floor(frame / 2))
  const counts = new Map<number, number>()
  for (let start = 0; start + frame <= channel.length; start += hop) {
    const hit = yinPitch(channel.subarray(start, start + frame), sampleRate, 60, 1400)
    if (hit.hz < 40 || hit.confidence < 0.45) continue
    const midi = Math.round(69 + 12 * Math.log2(hit.hz / 440))
    if (midi < 0 || midi > 127) continue
    counts.set(midi, (counts.get(midi) ?? 0) + hit.confidence)
  }
  return [...counts.entries()].map(([midi, weight]) => ({ midi, weight }))
}

/** Twelve-bin pitch class energy, summed across octaves. */
export function chromaBins(channel: Float32Array, sampleRate: number): number[] {
  const bins = new Array<number>(12).fill(0)
  if (channel.length < 256 || sampleRate < 1000) return bins
  const frame = Math.min(2048, channel.length)
  const hop = Math.max(256, Math.floor(frame / 2))
  for (let start = 0; start + frame <= channel.length; start += hop) {
    const slice = channel.subarray(start, start + frame)
    for (let pc = 0; pc < 12; pc++) {
      for (const octave of [48, 60, 72]) {
        bins[pc] += goertzel(slice, sampleRate, midiHz(octave + pc))
      }
    }
  }
  const peak = Math.max(...bins, 1e-9)
  return bins.map((value) => value / peak)
}

export function chordFromChroma(bins: number[]): string {
  const ranked = bins.map((weight, pc) => ({ pc, weight })).sort((a, b) => b.weight - a.weight)
  const strong = ranked.filter((item) => item.weight > 0.35).slice(0, 4)
  if (strong.length < 2) return ''
  return nameChordPcs(strong.map((item) => item.pc))
}

export function nameChordPcs(pcs: number[]): string {
  const unique = [...new Set(pcs.map((pc) => ((pc % 12) + 12) % 12))].sort((a, b) => a - b)
  if (unique.length < 2) return ''
  let best = { symbol: '', score: Infinity }
  for (const root of unique) {
    const intervals = unique.map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b)
    for (const template of TEMPLATES) {
      if (template.intervals.length !== intervals.length) continue
      let score = 0
      for (let i = 0; i < intervals.length; i++) score += Math.abs(intervals[i] - template.intervals[i])
      if (score < best.score) best = { symbol: `${NOTE_NAMES[root]}${template.suffix}`, score }
    }
  }
  return best.symbol
}

/** Chords whose notes start together, so a recorded chord stays a chord. */
export function chordsFromMidi(notes: { midi: number; startBeat: number; durationBeats: number }[]): string[] {
  const buckets = new Map<number, number[]>()
  for (const note of notes) {
    const key = Math.round(note.startBeat * 4) / 4
    const list = buckets.get(key) ?? []
    list.push(note.midi)
    buckets.set(key, list)
  }
  const symbols: string[] = []
  for (const pcs of [...buckets.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])) {
    const symbol = nameChordPcs(pcs)
    if (symbol) symbols.push(symbol)
  }
  return symbols
}

export function audioChordSymbols(channel: Float32Array, sampleRate: number): string[] {
  const symbol = chordFromChroma(chromaBins(channel, sampleRate))
  return symbol ? [symbol] : []
}

function midiHz(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12)
}

function goertzel(frame: Float32Array, sampleRate: number, freq: number) {
  const n = frame.length
  const k = Math.round((n * freq) / sampleRate)
  const omega = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(omega)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = frame[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

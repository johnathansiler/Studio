import type { ResolvedChord } from './chords'
import { clamp, roundBeat } from './rng'
import { surfaceRng } from './chords'
import { styleById, type Style } from './styles'
import type { ArpPattern, GeneratedNote, GeneratorInput } from './types'

const RATES = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125]

export function arpNotes(chords: ResolvedChord[], style: Style, input: GeneratorInput): GeneratedNote[] {
  const options = input.options ?? {}
  const pattern = options.arpPattern ?? style.arp.pattern
  const rate = nearestRate(options.rate ?? style.arp.rate)
  const octaves = clamp(Math.round(options.octaves ?? style.arp.octaves), 1, 3)
  const gate = clamp(options.gate ?? style.arp.gate, 0.1, 1)
  const rng = surfaceRng(input, 6)
  const notes: GeneratedNote[] = []
  let cursor = 0
  for (const chord of chords) {
    const line = arpLine(chord, pattern, octaves, rng)
    const steps = Math.max(1, Math.floor((chord.beats + 1e-6) / rate))
    for (let step = 0; step < steps; step++) {
      const tone = line[(cursor + step) % line.length]
      const start = chord.start + step * rate
      notes.push({
        pitch: tone.pitch,
        fine: tone.fine || undefined,
        startBeat: roundBeat(start),
        durationBeats: roundBeat(Math.max(0.05, rate * gate)),
        velocity: step % line.length === 0 ? 0.84 : 0.7,
      })
    }
    cursor += steps
  }
  return notes
}

function nearestRate(rate: number) {
  if (!Number.isFinite(rate)) return 0.5
  return RATES.reduce((best, item) => (Math.abs(item - rate) < Math.abs(best - rate) ? item : best))
}

function arpLine(chord: ResolvedChord, pattern: ArpPattern, octaves: number, rng: () => number) {
  const base = uniqueTones(chord)
  const extended = []
  for (let octave = 0; octave < octaves; octave++) {
    for (const tone of base) extended.push({ pitch: clamp(tone.pitch + octave * 12, 0, 108), fine: tone.fine })
  }
  const line = extended.length ? extended : [{ pitch: 60, fine: 0 }]
  if (pattern === 'down') return [...line].reverse()
  if (pattern === 'upDown') {
    const down = [...line].reverse().slice(1, -1)
    return line.length < 2 ? line : [...line, ...down]
  }
  if (pattern === 'downUp') {
    const rev = [...line].reverse()
    return line.length < 2 ? line : [...rev, ...line.slice(1, -1)]
  }
  if (pattern === 'inside') return inside(line)
  if (pattern === 'outside') return inside(line).reverse()
  if (pattern === 'broken') return broken(line)
  if (pattern === 'random') return shuffle(line, rng)
  return line
}

function uniqueTones(chord: ResolvedChord) {
  const tones = chord.pitches.map((pitch, index) => ({ pitch: clamp(Math.round(pitch), 0, 108), fine: chord.cents?.[index] ?? 0 }))
  tones.sort((a, b) => a.pitch - b.pitch)
  const unique: { pitch: number; fine: number }[] = []
  for (const tone of tones) {
    if (unique.some((item) => item.pitch === tone.pitch)) continue
    unique.push(tone)
  }
  return unique
}

function inside(line: { pitch: number; fine: number }[]) {
  const out = []
  let low = 0
  let high = line.length - 1
  while (low <= high) {
    out.push(line[low])
    low += 1
    if (low <= high) {
      out.push(line[high])
      high -= 1
    }
  }
  return out
}

function broken(line: { pitch: number; fine: number }[]) {
  const root = line[0]
  const rel = (pitch: number) => ((pitch - root.pitch) % 12 + 12) % 12
  const fifth = line.find((tone) => rel(tone.pitch) === 7) ?? line[Math.min(2, line.length - 1)]
  const third = line.find((tone) => {
    const interval = rel(tone.pitch)
    return interval === 3 || interval === 4
  }) ?? line[Math.min(1, line.length - 1)]
  const octave = line.find((tone) => tone.pitch === root.pitch + 12) ?? { pitch: clamp(root.pitch + 12, 0, 108), fine: root.fine }
  return [root, fifth, third, fifth, octave, fifth]
}

function shuffle<T>(items: T[], rng: () => number) {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

export function defaultArp(styleId: string) {
  return styleById(styleId).arp
}

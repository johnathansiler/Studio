import { surfaceRng } from './chords'
import type { ResolvedChord } from './chords'
import { pickWeighted, roundBeat, swingTime } from './rng'
import { rowVelocities, type Style } from './styles'
import { degreeStep, normalizeIntervals, place, tonicMidi } from './tune'
import type { GeneratedNote, GeneratorInput } from './types'

export function melodyNotes(chords: ResolvedChord[], style: Style, input: GeneratorInput): GeneratedNote[] {
  const rng = surfaceRng(input, 5)
  const scale = normalizeIntervals(input.scale)
  const tonic = tonicMidi(input.key)
  const weights = rowVelocities(style.melody)
  const mask = weights.map((weight) => (weight >= 8 / 9 ? true : weight <= 0 ? false : rng() < weight))
  if (mask.filter(Boolean).length < 2) {
    const ranked = weights.map((weight, index) => ({ weight, index })).sort((a, b) => b.weight - a.weight)
    mask[ranked[0]?.index ?? 0] = true
    mask[ranked[1]?.index ?? 4] = true
  }
  const bar = input.beatsPerBar ?? 4
  const steps = Math.max(1, Math.round(bar * 4))
  const total = input.bars * bar
  const notes: GeneratedNote[] = []
  let previous = 67
  let repeated = 0
  for (let barIndex = 0; barIndex < input.bars; barIndex++) {
    const last = barIndex === input.bars - 1
    for (let step = 0; step < steps; step++) {
      const on = mask[step % mask.length]
      const beat = barIndex * bar + step / 4
      if (!on && !(last && step === 0)) continue
      const chord = chordAt(chords, beat)
      if (!chord) continue
      const progress = beat / Math.max(0.25, total)
      const goal = progress < 0.55 ? previous + (progress < 0.25 ? 2 : 3) : previous - 2
      let choice = choose(rng, scale, tonic, chord, goal)
      if (choice.pitch === previous && repeated >= 2) {
        const other = choose(rng, scale, tonic, chord, goal + 3)
        if (other.pitch !== previous) choice = other
      }
      repeated = choice.pitch === previous ? repeated + 1 : 0
      previous = choice.pitch
      const durSteps = lasting(mask, step, steps)
      notes.push({
        pitch: choice.pitch,
        fine: choice.fine || undefined,
        startBeat: roundBeat(swingTime(beat, style.swing)),
        durationBeats: roundBeat(Math.max(0.12, (durSteps / 4) * 0.9)),
        velocity: 0.62 + weights[step % weights.length] * 0.28,
      })
    }
  }
  const tail = notes[notes.length - 1]
  const finalChord = chords[chords.length - 1]
  if (tail && finalChord) {
    const resolved = closestTone(finalChord, tail.pitch, scale, tonic)
    tail.pitch = resolved.pitch
    tail.fine = resolved.fine || undefined
    tail.durationBeats = roundBeat(Math.max(tail.durationBeats, 0.45))
  }
  return notes
}

function lasting(mask: boolean[], step: number, steps: number) {
  let count = 1
  for (let next = step + 1; next < steps; next++) {
    if (mask[next % mask.length]) break
    count += 1
    if (count >= 4) break
  }
  return count
}

function choose(rng: () => number, scale: ReturnType<typeof normalizeIntervals>, tonic: number, chord: ResolvedChord, goal: number) {
  const options: { pitch: number; fine: number; weight: number }[] = []
  for (let octave = -1; octave <= 2; octave++) {
    for (let degree = 0; degree < scale.length; degree++) {
      const step = degreeStep(scale, degree + octave * scale.length)
      const placed = place(tonic, step.semitones, step.cents)
      if (placed.pitch < 58 || placed.pitch > 81) continue
      const chordTone = chord.pitches.some((pitch) => ((pitch % 12) + 12) % 12 === ((placed.pitch % 12) + 12) % 12)
      const dist = Math.abs(placed.pitch - goal)
      const weight = (chordTone ? 4 : 1) * (dist <= 2 ? 3 : dist <= 5 ? 1.6 : 0.35)
      options.push({ pitch: placed.pitch, fine: chordFine(chord, placed.pitch) || placed.fine, weight })
    }
  }
  for (let index = 0; index < chord.pitches.length; index++) {
    const pc = ((chord.pitches[index] % 12) + 12) % 12
    const fine = chord.cents?.[index] ?? 0
    for (const pitch of [pc + 60, pc + 72]) {
      if (pitch < 58 || pitch > 81) continue
      const dist = Math.abs(pitch - goal)
      options.push({ pitch, fine, weight: 3.2 * (dist <= 4 ? 2 : 0.45) })
    }
  }
  if (!options.length) return { pitch: Math.max(58, Math.min(81, Math.round(goal))), fine: 0 }
  return pickWeighted(options, rng)
}

function closestTone(chord: ResolvedChord, previous: number, scale: ReturnType<typeof normalizeIntervals>, tonic: number) {
  const rootPc = chord.root
  let best = { pitch: previous, fine: 0 }
  let bestDist = 99
  for (const pitch of [rootPc + 60, rootPc + 72, rootPc + 48]) {
    const dist = Math.abs(pitch - previous)
    if (dist < bestDist) {
      bestDist = dist
      best = { pitch, fine: chordFine(chord, pitch) }
    }
  }
  const step = degreeStep(scale, 0)
  const placed = place(tonic, step.semitones, step.cents)
  void placed
  return best
}

function chordFine(chord: ResolvedChord, pitch: number) {
  const index = chord.pitches.findIndex((item) => ((item % 12) + 12) % 12 === ((pitch % 12) + 12) % 12)
  return index < 0 ? 0 : chord.cents?.[index] ?? 0
}

function chordAt(chords: ResolvedChord[], beat: number) {
  return chords.find((chord) => beat >= chord.start - 1e-6 && beat < chord.start + chord.beats - 1e-6) ?? chords[chords.length - 1]
}

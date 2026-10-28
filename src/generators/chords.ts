import { nameChord } from '../model/scale'
import { channelRng, harmonyRng, mod12, roundBeat, swingTime } from './rng'
import type { ChordColor, Style } from './styles'
import { degreeStep, isMinorish, normalizeIntervals, place, snapTarget, tonicMidi, type ScaleStep } from './tune'
import type { GeneratorChord, GeneratorInput } from './types'

export interface ResolvedChord extends GeneratorChord {
  start: number
  root: number
}

const SKIPS: Record<ChordColor, number[] | null> = {
  triad: [0, 2, 4],
  seventh: [0, 2, 4, 6],
  ninth: [0, 2, 4, 6, 8],
  sus: [0, 3, 4],
  dyad: [0, 1, 2],
  shell: [0, 2, 4, 6],
  dom: null,
  min: null,
}

export function buildChords(input: GeneratorInput, style: Style): ResolvedChord[] {
  const scale = normalizeIntervals(input.scale)
  const minor = isMinorish(scale)
  const recipes = minor ? style.minor : style.major
  const rng = harmonyRng((input.seed ^ styleSalt(style.id)) >>> 0)
  const useLong = !!style.long && input.bars >= 8 && rng() < 0.55
  const recipe = useLong && style.long ? style.long : recipes[Math.floor(rng() * recipes.length) % recipes.length]
  const bar = input.beatsPerBar ?? 4
  const variation = input.variation ?? 0
  const chords: ResolvedChord[] = []
  let start = 0
  for (let index = 0; index < input.bars; index++) {
    const token = recipe[index % recipe.length]
    const degree = typeof token === 'number' ? token : token.d
    const color = typeof token === 'number' ? style.color : token.c
    chords.push(spell(scale, input.key, degree, color, variation, start, bar))
    start += bar
  }
  return lead(chords, variation)
}

export function coverChords(chords: GeneratorChord[], totalBeats: number): ResolvedChord[] {
  const source = chords.filter((chord) => chord.beats > 0 && chord.pitches.length)
  if (!source.length || totalBeats <= 0) return []
  const out: ResolvedChord[] = []
  let beat = 0
  let index = 0
  while (beat < totalBeats - 1e-6 && index < 512) {
    const chord = source[index % source.length]
    const beats = Math.min(chord.beats, totalBeats - beat)
    const root = chord.root ?? mod12(Math.min(...chord.pitches))
    out.push({ ...chord, pitches: chord.pitches.map((pitch) => Math.round(pitch)), cents: chord.cents, beats, start: beat, root: mod12(root) })
    beat += beats
    index += 1
  }
  return out
}

export function chordNotes(chords: ResolvedChord[], style: Style, input: GeneratorInput) {
  const stab = stabs(style.id)
  const swing = style.swing
  const notes = []
  for (const chord of chords) {
    const played = style.color === 'shell' || chordIsShell(chord, style) ? withoutRoot(chord) : chord.pitches.map((pitch, index) => ({ pitch, fine: chord.cents?.[index] || 0 }))
    const events = stab ? stab.filter((hit) => hit.at < chord.beats - 0.02) : [{ at: 0, dur: Math.max(0.2, chord.beats - 0.05) }]
    for (const event of events) {
      const at = swingTime(chord.start + event.at, swing)
      for (const tone of played) {
        notes.push({
          pitch: tone.pitch,
          fine: tone.fine || undefined,
          startBeat: roundBeat(at),
          durationBeats: roundBeat(Math.max(0.12, Math.min(event.dur, chord.start + chord.beats - at - 0.02))),
          velocity: 0.78,
        })
      }
    }
  }
  void input
  return notes
}

function chordIsShell(chord: ResolvedChord, style: Style) {
  return style.color === 'shell' && chord.pitches.length > 2
}

function spell(scale: ScaleStep[], key: number, degree: number, color: ChordColor, variation: number, start: number, beats: number): ResolvedChord {
  const tonic = tonicMidi(key)
  const rootStep = degreeStep(scale, degree)
  const tones = tonesFor(scale, rootStep, degree, color)
  const placed = tones.map((tone) => place(tonic, tone.semitones, tone.cents))
  const rootPlaced = place(tonic, rootStep.semitones, rootStep.cents)
  const symbol = nameChord(placed.map((tone) => tone.pitch)) || nameChord([rootPlaced.pitch])
  void variation
  return {
    pitches: placed.map((tone) => tone.pitch),
    cents: placed.map((tone) => tone.fine),
    beats,
    start,
    symbol,
    root: mod12(rootPlaced.pitch),
  }
}

function tonesFor(scale: ScaleStep[], root: ScaleStep, degree: number, color: ChordColor): ScaleStep[] {
  if (color === 'dom') return [0, 4, 7, 10].map((target) => snapTarget(scale, root, target))
  if (color === 'min') return [0, 3, 7].map((target) => snapTarget(scale, root, target))
  const skips = SKIPS[color] ?? [0, 2, 4]
  return skips.map((skip) => degreeStep(scale, degree + skip))
}

function withoutRoot(chord: ResolvedChord) {
  const tones = chord.pitches.map((pitch, index) => ({ pitch, fine: chord.cents?.[index] || 0 }))
  const index = tones.findIndex((tone) => mod12(tone.pitch) === chord.root)
  if (index < 0 || tones.length < 3) return tones
  return tones.filter((_, toneIndex) => toneIndex !== index)
}

function lead(chords: ResolvedChord[], variation: number): ResolvedChord[] {
  let previous: number[] = []
  return chords.map((chord, index) => {
    let pitches = chord.pitches.map((pitch) => pitch)
    const cents = chord.cents ? [...chord.cents] : pitches.map(() => 0)
    pitches = fitRegister(pitches)
    if (variation && pitches.length > 1) {
      const times = (variation + index) % pitches.length
      for (let turn = 0; turn < times; turn++) {
        const bass = pitches[0]
        const bassCents = cents[0]
        pitches = [...pitches.slice(1), bass + 12]
        cents.splice(0, 1)
        cents.push(bassCents)
      }
    }
    if (previous.length) {
      let best = pitches
      let bestCents = cents
      let bestCost = Infinity
      for (const shift of [-12, 0, 12]) {
        const candidate = pitches.map((pitch) => pitch + shift)
        if (candidate.some((pitch) => pitch < 48 || pitch > 78)) continue
        const cost = movement(candidate, previous)
        if (cost < bestCost) {
          bestCost = cost
          best = candidate
          bestCents = cents
        }
      }
      pitches = best
      previous = pitches
      return { ...chord, pitches, cents: bestCents }
    }
    previous = pitches
    return { ...chord, pitches, cents }
  })
}

function fitRegister(pitches: number[]) {
  let next = [...pitches]
  const average = () => next.reduce((sum, pitch) => sum + pitch, 0) / next.length
  while (average() < 64 && next.every((pitch) => pitch + 12 <= 84)) next = next.map((pitch) => pitch + 12)
  while (average() > 76 && next.every((pitch) => pitch - 12 >= 48)) next = next.map((pitch) => pitch - 12)
  return next
}

function styleSalt(id: string) {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash + id.charCodeAt(index) * (index + 3)) >>> 0
  return hash || 1
}

function movement(candidate: number[], previous: number[]) {
  const used = new Set<number>()
  let cost = 0
  for (const pitch of candidate) {
    let best = 99
    let index = -1
    previous.forEach((other, otherIndex) => {
      if (used.has(otherIndex)) return
      const dist = Math.abs(other - pitch)
      if (dist < best) {
        best = dist
        index = otherIndex
      }
    })
    if (index >= 0) used.add(index)
    cost += index >= 0 ? best : 12
  }
  return cost
}

function stabs(styleId: string) {
  if (styleId === 'house' || styleId === 'disco') return [{ at: 0.5, dur: 0.35 }, { at: 1.5, dur: 0.35 }, { at: 2.5, dur: 0.35 }, { at: 3.5, dur: 0.3 }]
  if (styleId === 'techno') return [{ at: 0, dur: 0.18 }, { at: 1.5, dur: 0.18 }, { at: 3, dur: 0.18 }]
  if (styleId === 'funk') return [{ at: 0, dur: 0.16 }, { at: 0.75, dur: 0.12 }, { at: 1.5, dur: 0.16 }, { at: 2.25, dur: 0.12 }, { at: 2.75, dur: 0.12 }, { at: 3.5, dur: 0.14 }]
  if (styleId === 'reggae' || styleId === 'afrobeats') return [{ at: 0.5, dur: 0.28 }, { at: 1.5, dur: 0.28 }, { at: 2.5, dur: 0.28 }, { at: 3.5, dur: 0.24 }]
  return null
}

export function surfaceRng(input: GeneratorInput, channel: number) {
  return channelRng(input.seed, input.variation ?? 0, channel)
}

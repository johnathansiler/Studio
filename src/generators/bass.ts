import { surfaceRng } from './chords'
import type { ResolvedChord } from './chords'
import { clamp, mod12, roundBeat, swingTime } from './rng'
import type { BassHit, Style } from './styles'
import { degreeStep, normalizeIntervals, place, tonicMidi } from './tune'
import type { GeneratedNote, GeneratorInput } from './types'

export function bassNotes(chords: ResolvedChord[], style: Style, input: GeneratorInput): GeneratedNote[] {
  const rng = surfaceRng(input, 4)
  const scale = normalizeIntervals(input.scale)
  const tonic = tonicMidi(input.key)
  const notes: GeneratedNote[] = []
  chords.forEach((chord, index) => {
    const next = chords[index + 1] ?? chords[0]
    if (style.walk) {
      notes.push(...walk(chord, next, scale, tonic, input.key, style, rng))
      return
    }
    const pattern = hitsInside(style.bass, chord.beats)
    for (const hit of pattern) {
      const played = pitchFor(hit, chord, next, style, scale, tonic)
      notes.push({
        pitch: played.pitch,
        fine: played.fine || undefined,
        slide: style.slide && (hit.pick === 'next' || hit.pick === 'below') ? true : undefined,
        startBeat: roundBeat(swingTime(chord.start + hit.at, style.swing)),
        durationBeats: roundBeat(Math.max(0.08, Math.min(hit.dur, chord.beats - hit.at - 0.02))),
        velocity: hit.vel,
      })
    }
    if (style.pedal && rng() > 0.35) {
      const neighbor = degreeStep(scale, 1)
      const placed = place(tonic, neighbor.semitones, neighbor.cents)
      const rootMidi = bassRegister(chord.root, style.low, 0)
      let pitch = rootMidi + (placed.pitch - tonic)
      while (pitch - rootMidi > 7) pitch -= 12
      while (rootMidi - pitch > 7) pitch += 12
      pitch = clamp(pitch, 28, 55)
      notes.push({
        pitch,
        fine: placed.fine || undefined,
        startBeat: roundBeat(chord.start + Math.min(chord.beats * 0.5, chord.beats - 0.3)),
        durationBeats: roundBeat(Math.max(0.2, chord.beats * 0.3)),
        velocity: 0.62,
      })
    }
  })
  return notes
}

function hitsInside(pattern: BassHit[], beats: number) {
  const out: BassHit[] = []
  let origin = 0
  while (origin < beats - 0.02) {
    const window = Math.min(4, beats - origin)
    for (const hit of pattern) {
      if (hit.at >= window - 0.001) continue
      out.push({ ...hit, at: origin + hit.at })
    }
    origin += 4
    if (!pattern.length) break
  }
  return out
}

function pitchFor(hit: BassHit, chord: ResolvedChord, next: ResolvedChord, style: Style, scale: ReturnType<typeof normalizeIntervals>, tonic: number) {
  if (hit.pick === 'next') {
    const pc = mod12(next.root - 1)
    return { pitch: bassRegister(pc, style.low, 0), fine: 0 }
  }
  if (hit.pick === 'below') {
    const step = degreeStep(scale, -1)
    const placed = place(tonic, step.semitones, step.cents)
    const pc = mod12(placed.pitch)
    return { pitch: bassRegister(pc, style.low, 0), fine: placed.fine }
  }
  const interval = hit.pick === 'fifth' ? 7 : hit.pick === 'oct' ? 12 : hit.pick === 'third' ? thirdOf(chord) : hit.pick === 'seventh' ? seventhOf(chord) : 0
  const rootPitch = bassRegister(chord.root, style.low, 0)
  if (interval === 0) return { pitch: rootPitch, fine: rootFine(chord) }
  let pitch = rootPitch + interval
  while (pitch > (style.low ? 52 : 58)) pitch -= 12
  while (pitch < 28) pitch += 12
  return { pitch: clamp(pitch, 24, 64), fine: fineFor(chord, mod12(chord.root + interval)) }
}

function walk(chord: ResolvedChord, next: ResolvedChord, scale: ReturnType<typeof normalizeIntervals>, tonic: number, key: number, style: Style, rng: () => number): GeneratedNote[] {
  void key
  const beats = Math.max(1, Math.round(chord.beats))
  const notes: GeneratedNote[] = []
  let previous = bassRegister(chord.root, false, 0)
  const tones = chord.pitches.map((pitch) => mod12(pitch))
  for (let beat = 0; beat < beats; beat++) {
    const at = chord.start + beat
    let pc = chord.root
    let fine = rootFine(chord)
    if (beat === beats - 1) {
      const target = bassRegister(next.root, false, 0)
      const direction = target >= previous ? 1 : -1
      const approach = mod12(next.root - direction)
      pc = rng() > 0.35 ? approach : next.root
      fine = 0
    } else if (beat === 0) {
      pc = chord.root
    } else {
      const step = degreeStep(scale, Math.floor(rng() * scale.length))
      const scalePc = mod12(place(tonic, step.semitones, step.cents).pitch)
      pc = rng() > 0.45 ? tones[Math.floor(rng() * tones.length)] ?? chord.root : scalePc
      fine = fineFor(chord, pc) || (pc === scalePc ? place(tonic, step.semitones, step.cents).fine : 0)
    }
    let pitch = bassRegister(pc, false, 0)
    if (beat > 0 && Math.abs(pitch - previous) > 7) pitch += pitch < previous ? 12 : -12
    pitch = clamp(pitch, 28, 55)
    previous = pitch
    notes.push({
      pitch,
      fine: fine || undefined,
      startBeat: roundBeat(swingTime(at, style.swing)),
      durationBeats: roundBeat(Math.max(0.2, 0.9)),
      velocity: beat === 0 ? 0.78 : 0.66,
    })
  }
  return notes
}

function bassRegister(pc: number, low: boolean | undefined, extra: number) {
  let pitch = 36 + mod12(pc) + extra
  if (low && pitch > 42) pitch -= 12
  while (pitch < 28) pitch += 12
  while (pitch > 52 && extra === 0) pitch -= 12
  return clamp(pitch, 24, 64)
}

function thirdOf(chord: ResolvedChord) {
  const found = chord.pitches.find((pitch) => {
    const rel = mod12(pitch - chord.root)
    return rel === 3 || rel === 4
  })
  return found == null ? 4 : mod12(found - chord.root)
}

function seventhOf(chord: ResolvedChord) {
  const found = chord.pitches.find((pitch) => {
    const rel = mod12(pitch - chord.root)
    return rel === 10 || rel === 11
  })
  return found == null ? 10 : mod12(found - chord.root)
}

function rootFine(chord: ResolvedChord) {
  return fineFor(chord, chord.root)
}

function fineFor(chord: ResolvedChord, pc: number) {
  const index = chord.pitches.findIndex((pitch) => mod12(pitch) === mod12(pc))
  if (index < 0) return 0
  return chord.cents?.[index] ?? 0
}

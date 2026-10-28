import { clampMidi, toneFromCents } from '../theory/pitch'
import { mod12 } from './rng'
import type { ScaleInterval } from './types'

export interface ScaleStep {
  semitones: number
  cents: number
}

const MAJOR = [0, 2, 4, 5, 7, 9, 11]

export function normalizeIntervals(scale: ScaleInterval[]): ScaleStep[] {
  const steps: ScaleStep[] = []
  for (const item of scale) {
    if (typeof item === 'number' && Number.isFinite(item)) steps.push({ semitones: item, cents: 0 })
    else if (item && typeof item === 'object' && Number.isFinite(item.semitones)) {
      steps.push({ semitones: item.semitones, cents: Number.isFinite(item.cents) ? (item.cents as number) : 0 })
    }
  }
  steps.sort((a, b) => a.semitones * 100 + a.cents - (b.semitones * 100 + b.cents))
  if (!steps.length || steps[0].semitones > 0.01 || steps[0].cents > 1) steps.unshift({ semitones: 0, cents: 0 })
  return steps.length ? steps : MAJOR.map((semitones) => ({ semitones, cents: 0 }))
}

export function isMinorish(scale: ScaleStep[]) {
  let best: ScaleStep | null = null
  let bestDist = 9
  for (const step of scale) {
    const dist = Math.abs(step.semitones + step.cents / 100 - 3.5)
    if (step.semitones > 2 && step.semitones < 5 && dist < bestDist) {
      best = step
      bestDist = dist
    }
  }
  if (!best) return false
  return best.semitones + best.cents / 100 < 3.6
}

export function degreeStep(scale: ScaleStep[], degree: number): ScaleStep {
  const count = scale.length
  const wrapped = ((degree % count) + count) % count
  const octave = Math.floor(degree / count)
  const step = scale[wrapped]
  return { semitones: step.semitones + octave * 12, cents: step.cents }
}

/** MIDI pitch plus a cent offset, folded the same way as the scale library. */
export function place(tonicMidi: number, semitones: number, cents = 0) {
  const tone = toneFromCents(tonicMidi * 100 + semitones * 100 + cents)
  return { pitch: clampMidi(tone.midi), fine: tone.cents }
}

export function soundingCents(pitch: number, fine = 0) {
  return pitch * 100 + fine
}

export function tonicMidi(key: number) {
  return 60 + mod12(key)
}

/** Use a scale tone when it is within 60 cents of the equal target, so maqam thirds stay. */
export function snapTarget(scale: ScaleStep[], root: ScaleStep, targetSemitones: number): ScaleStep {
  const want = root.semitones * 100 + root.cents + targetSemitones * 100
  let best: ScaleStep = { semitones: root.semitones + targetSemitones, cents: root.cents }
  let bestDist = 61
  for (let octave = -1; octave <= 2; octave++) {
    for (const step of scale) {
      const sounded = (step.semitones + octave * 12) * 100 + step.cents
      const dist = Math.abs(sounded - want)
      if (dist < bestDist) {
        bestDist = dist
        best = { semitones: step.semitones + octave * 12, cents: step.cents }
      }
    }
  }
  if (bestDist <= 60) return best
  return { semitones: root.semitones + targetSemitones, cents: root.cents }
}

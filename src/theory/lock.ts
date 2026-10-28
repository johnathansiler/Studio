import { SCALES, snapPitch, type ScaleId } from '../model/scale'
import { detectScale } from './detect'
import { mod1200 } from './pitch'
import { findScale, getScale, isTwelveTone, nearestDegree, snapToScale } from './scales'
import type { Tone } from './types'

export function isBuiltinScale(id: string): id is ScaleId {
  return SCALES.some((scale) => scale.id === id)
}

export function nearestBuiltin(cents: readonly number[]): ScaleId {
  const rounded = cents.map((value) => mod12round(value / 100))
  let best: ScaleId = 'ionian'
  let bestScore = Infinity
  for (const scale of SCALES) {
    const have = new Set<number>(scale.intervals)
    let score = 0
    for (const interval of rounded) if (!have.has(interval)) score += 1
    for (const interval of scale.intervals) if (!rounded.includes(interval)) score += 1
    if (score < bestScore) {
      bestScore = score
      best = scale.id
    }
  }
  return best
}

function mod12round(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

export interface LockState {
  root: number
  scale: string
  library?: string
}

/** True when the active scale uses pitches between the piano keys. */
export function scaleIsMicrotonal(state: LockState) {
  const spec = findScale(state.library || state.scale)
  return !!spec && !isTwelveTone(spec)
}

/**
 * Scale-lock one pitch. Built-in 12-tone scales keep the existing snap, including its tie break.
 * Microtonal and catalog scales return a MIDI note plus cents.
 */
export function lockedTone(pitch: number, fine: number, state: LockState): Tone {
  const id = state.library || state.scale
  const spec = findScale(id)
  const builtin = !state.library && isBuiltinScale(state.scale) && (!spec || isTwelveTone(spec))
  if (builtin || !spec) {
    const scale = isBuiltinScale(state.scale) ? state.scale : 'ionian'
    return { midi: snapPitch(Math.round(pitch), state.root, scale), cents: fine || 0 }
  }
  return snapToScale(pitch, fine || 0, state.root, id)
}

export interface KeySuggestion {
  root: number
  scale: ScaleId
  library: string
  name: string
  score: number
}

/** Best key for the notes already on a track. `library` is set when the winner is not one of the built-in scales. */
export function suggestKey(notes: { midi: number; cents?: number; weight?: number }[]): KeySuggestion {
  const top = detectScale(notes)[0] ?? { root: 0, scaleId: 'ionian', name: 'Major', score: 0 }
  if (isBuiltinScale(top.scaleId)) {
    return { root: top.root, scale: top.scaleId, library: '', name: top.name, score: top.score }
  }
  const spec = getScale(top.scaleId)
  return { root: top.root, scale: nearestBuiltin(spec.cents), library: top.scaleId, name: spec.name, score: top.score }
}

/** How a piano key relates to the active scale. `near` is the neighbor of a quarter tone. */
export function pitchRole(midi: number, fine: number, root: number, scaleId: string): 'in' | 'near' | 'out' {
  const spec = findScale(scaleId)
  if (!spec) return 'out'
  const relative = mod1200((midi - root) * 100 + (fine || 0))
  const distance = nearestDegree(relative, spec.cents).distance
  if (distance <= 18) return 'in'
  if (distance <= 55) return 'near'
  return 'out'
}

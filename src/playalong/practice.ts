/** Practice speed. Recorded takes stay exactly as captured. Everything else can be time-stretched. */

import { isRecordedClip } from '../audio/recordTake'
import type { PracticeRate } from './types'

export interface PracticePlan {
  rate: PracticeRate
  /** True when the in-house time-stretch should lengthen the buffer. */
  stretch: boolean
  /** Shown when the rate cannot change. */
  reason?: string
}

export function asPracticeRate(value: number): PracticeRate {
  if (value === 0.5 || value === 0.75) return value
  return 1
}

/**
 * 50% and 75% slow the clip without pitching it.
 * A recorded vocal or take always stays at 100% and is not stretched.
 */
export function practicePlan(clip: { playback?: string } | null | undefined, rate: number): PracticePlan {
  if (isRecordedClip(clip)) {
    return { rate: 1, stretch: false, reason: 'This take plays as sung. Speed stays at 100%.' }
  }
  const next = asPracticeRate(rate)
  if (next === 1) return { rate: 1, stretch: false }
  return { rate: next, stretch: true }
}

/** Count-in length in seconds at the practice rate. Pitch is unchanged; only the wait grows. */
export function countInSecondsAt(tempo: number, beats: number, rate: PracticeRate) {
  const speed = rate > 0 ? rate : 1
  return (Math.max(0, beats) * 60) / Math.max(1, tempo) / speed
}

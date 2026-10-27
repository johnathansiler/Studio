/** One sixteenth note, in quarter-note beats. */
export const STEP_BEAT = 0.25

export function clampStepCount(value: number): number {
  if (!Number.isFinite(value)) return 16
  return Math.max(1, Math.min(64, Math.round(value)))
}

export function clampSwing(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(0.9, value))
}

/** Odd steps are delayed by `swing` times one step. Even steps stay on the grid. */
export function stepStart(index: number, stepBeats = STEP_BEAT, swing = 0): number {
  const step = Math.max(0, index)
  const delay = step % 2 === 1 ? clampSwing(swing) * stepBeats : 0
  return step * stepBeats + delay
}

/** Step sounding at `beat` inside a loop of `count` steps. */
export function stepIndexAt(beat: number, count: number, stepBeats = STEP_BEAT, swing = 0): number {
  const steps = clampStepCount(count)
  const width = stepBeats > 0 ? stepBeats : STEP_BEAT
  const loop = width * steps
  const local = ((beat % loop) + loop) % loop
  let index = Math.min(steps - 1, Math.floor(local / width + 1e-9))
  if (index % 2 === 1 && local + 1e-9 < stepStart(index, width, swing)) index = Math.max(0, index - 1)
  return index
}

/**
 * Step index on the sample clock. `beatSamples` is one quarter note.
 * The rack drum machine calls this instead of keeping its own counter.
 */
export function drumStepIndex(timeSamples: number, beatSamples: number, steps = 16, swing = 0): number {
  const beat = beatSamples > 0 ? timeSamples / beatSamples : 0
  return stepIndexAt(beat, steps, STEP_BEAT, swing)
}

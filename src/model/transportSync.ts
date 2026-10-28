/** One transport clock for Arrange, Session, Beats, the piano roll, and the mixer. */

export interface LoopClock {
  loopEnabled: boolean
  loopStartSample: number
  loopEndSample: number
}

/** Playback position inside the shared loop. Samples before the end stay put. */
export function transportSample(sample: number, project: LoopClock) {
  const linear = Math.max(0, sample)
  if (!project.loopEnabled) return linear
  const start = Math.max(0, project.loopStartSample)
  const end = Math.max(start + 1, project.loopEndSample)
  if (linear < start) return linear
  if (linear < end) return linear
  const length = end - start
  return start + ((linear - start) % length)
}

/** Playing with the loop on never runs off the end. The extra samples are the tail after the arrangement. */
export function playbackStops(sample: number, project: LoopClock, arrangementEnd: number, extraSamples: number) {
  if (project.loopEnabled) return false
  return sample > arrangementEnd + Math.max(0, extraSamples)
}

export function transportMoving(status: string) {
  return status === 'playing' || status === 'recording' || status === 'counting-in'
}

/** Views draw this. It is the engine playhead after the loop wrap, wrapped again only if needed. */
export function displayedPlayhead(positionSamples: number, project: LoopClock) {
  return transportSample(positionSamples, project)
}

/**
 * Beat inside a piano-roll clip. Song loop wrap is already in the sample. A looping clip folds the line.
 * `viewBeats` is the grid that is actually drawn, which can be longer than the clip.
 */
export function pianoPlayheadBeat(
  beat: number,
  clip: { startBeat: number; durationBeats: number; loop?: boolean },
  viewBeats?: number,
): number | null {
  const local = beat - clip.startBeat
  if (local < -1e-4) return null
  const span = Math.max(0.25, clip.durationBeats)
  const view = Math.max(span, viewBeats ?? span)
  if (clip.loop) return ((local % span) + span) % span
  if (local > view + 1e-4) return null
  return local
}

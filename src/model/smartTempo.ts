import type { AudioClip, Project, StretchMode } from './types'

/** Keep a detected tempo inside the transport range. */
export function clampTempo(bpm: number): number {
  if (!Number.isFinite(bpm)) return 120
  return Math.max(30, Math.min(300, Math.round(bpm * 10) / 10))
}

/**
 * Make the song use the clip's tempo.
 * The transport tempo (and the downbeat point, when the map has one) changes.
 */
export function adaptProjectTempo(project: Project, bpm: number): number {
  const value = clampTempo(bpm)
  project.tempo = value
  const first = project.tempoMap?.find((point) => point.beat <= 1e-3)
  if (first) first.bpm = value
  return value
}

/** Pitch-preserving stretch settings that lock the clip to the song tempo. */
export function conformStretchPatch(bpm: number, mode: StretchMode | undefined): { sourceBpm: number; followTempo: true; mode: StretchMode } {
  return {
    sourceBpm: clampTempo(bpm),
    followTempo: true,
    mode: mode === 'tape' || !mode ? 'pro' : mode,
  }
}

export function clipTempo(clip: AudioClip | undefined): number | null {
  const bpm = clip?.stretch?.sourceBpm
  if (bpm == null || !(bpm > 0)) return null
  return bpm
}

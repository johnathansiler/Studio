import type { ClipStretch, ClipTempoMode } from './types'

/** The four tempo choices on an audio clip. */
export const CLIP_TEMPO_MODES = ['follow', 'half', 'double', 'lock'] as const

export const CLIP_TEMPO_LABEL: Record<ClipTempoMode, string> = {
  follow: 'Follow',
  half: '½×',
  double: '2×',
  lock: 'Lock',
}

/**
 * Per-clip tempo against the song.
 *
 * Follow plays at the song tempo. Half plays at half of it, double at twice it,
 * and both keep that ratio when the song tempo changes. Lock holds one BPM.
 *
 * A clip with no mode and followTempo off keeps its file length. That is how a
 * newly placed loop can stay at the file tempo until someone asks it to sync.
 * Lock at the source BPM is that same speed, and it stays there when the song changes.
 */
export function clipTempoMode(stretch: Pick<ClipStretch, 'followTempo' | 'tempoMode'> | undefined | null): ClipTempoMode | 'free' {
  const mode = stretch?.tempoMode
  if (mode === 'follow' || mode === 'half' || mode === 'double' || mode === 'lock') return mode
  return stretch?.followTempo ? 'follow' : 'free'
}

/** Song-tempo multiplier. Half is 1/2, double is 2. Lock and free are not a ratio. */
export function tempoModeFactor(mode: ClipTempoMode | 'free'): number | null {
  if (mode === 'half') return 0.5
  if (mode === 'double') return 2
  if (mode === 'follow') return 1
  return null
}

/**
 * Project beats occupied by `sourceBeats` of source material.
 * Half doubles the bar length. Double cuts it in half. Follow keeps it.
 */
export function projectBeatSpan(sourceBeats: number, mode: 'follow' | 'half' | 'double'): number {
  if (mode === 'half') return sourceBeats * 2
  if (mode === 'double') return sourceBeats / 2
  return sourceBeats
}

/** The clip's length is owned by a tempo mode, including a locked BPM. */
export function tempoDrivesLength(stretch: Pick<ClipStretch, 'followTempo' | 'tempoMode'> | undefined | null): boolean {
  return clipTempoMode(stretch) !== 'free'
}

/** This clip must be rendered again when the song tempo changes. Lock does not. */
export function tempoFollowsProject(stretch: Pick<ClipStretch, 'followTempo' | 'tempoMode'> | undefined | null): boolean {
  const mode = clipTempoMode(stretch)
  return mode === 'follow' || mode === 'half' || mode === 'double'
}

export function clampLockBpm(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 120
  return Math.round(Math.min(960, Math.max(10, bpm)) * 10) / 10
}

/**
 * Tempo the clip is playing at.
 * Follow, half, and double are ratios of the song. Lock is the stored BPM.
 * A free clip reports the tempo implied by its current stretch, which is the
 * source BPM when the file length has not been changed.
 */
export function effectiveClipBpm(input: {
  mode: ClipTempoMode | 'free'
  projectBpm: number
  sourceBpm: number | null | undefined
  lockBpm?: number | null
  sourceSamples?: number
  durationSamples?: number
}): number | null {
  const { mode, projectBpm } = input
  if (mode === 'follow') return projectBpm
  if (mode === 'half') return projectBpm / 2
  if (mode === 'double') return projectBpm * 2
  if (mode === 'lock') {
    if (input.lockBpm && input.lockBpm > 0) return input.lockBpm
    return input.sourceBpm && input.sourceBpm > 0 ? input.sourceBpm : null
  }
  const source = input.sourceBpm
  const sourceSamples = input.sourceSamples
  const duration = input.durationSamples
  if (source && source > 0 && sourceSamples && sourceSamples > 0 && duration && duration > 0) {
    return source * (sourceSamples / duration)
  }
  return source && source > 0 ? source : null
}

/** Samples of a locked clip. The song tempo does not change this length. */
export function lockedTimelineSamples(sourceSamples: number, sourceBpm: number, lockBpm: number): number {
  return Math.max(1, Math.round(sourceSamples * (sourceBpm / lockBpm)))
}

/**
 * Settings for a mode choice.
 * Lock remembers the tempo the clip is playing at right now, unless one was already stored.
 */
export function clipTempoPatch(
  stretch: ClipStretch,
  mode: ClipTempoMode,
  projectBpm: number,
  durationSamples: number,
): Partial<ClipStretch> {
  if (mode === 'lock') {
    const current = clipTempoMode(stretch)
    const playing = current === 'lock' && stretch.lockBpm && stretch.lockBpm > 0
      ? stretch.lockBpm
      : effectiveClipBpm({
          mode: current,
          projectBpm,
          sourceBpm: stretch.sourceBpm,
          lockBpm: stretch.lockBpm,
          sourceSamples: stretch.sourceSamples,
          durationSamples,
        })
    return {
      tempoMode: 'lock',
      followTempo: false,
      lockBpm: clampLockBpm(playing ?? stretch.sourceBpm ?? projectBpm),
    }
  }
  return { tempoMode: mode, followTempo: true }
}

/** Short label drawn on the clip for the modes that change its bar length. */
export function clipTempoBadge(stretch: Pick<ClipStretch, 'followTempo' | 'tempoMode'> | undefined | null): string {
  const mode = clipTempoMode(stretch)
  if (mode === 'half' || mode === 'double' || mode === 'lock') return CLIP_TEMPO_LABEL[mode]
  return ''
}

export function formatBpm(bpm: number): string {
  if (!Number.isFinite(bpm)) return ''
  const rounded = Math.round(bpm * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

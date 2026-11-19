import type { ClipHearing } from './types'

export type TempoRelation = 'match' | 'half' | 'double' | 'apart'

/** Detected tempo against a reference: the clip's source BPM, or the song. */
export function relateTempo(detected: number, reference: number | null | undefined): TempoRelation {
  if (!(detected > 0) || !(reference && reference > 0)) return 'apart'
  const near = (target: number) => Math.abs(detected - target) / target < 0.04
  if (near(reference)) return 'match'
  if (near(reference / 2)) return 'half'
  if (near(reference * 2)) return 'double'
  return 'apart'
}

/**
 * Tempo "Use for song" should apply.
 * An octave error (half or double the tempo already stored on the clip) keeps
 * that stored tempo, so Follow does not jump an octave. A real disagreement
 * uses the detection.
 */
export function tempoForSong(detected: number, sourceBpm: number | null | undefined): number {
  if (!(detected > 0)) return 0
  const relation = relateTempo(detected, sourceBpm)
  if (sourceBpm && sourceBpm > 0 && (relation === 'match' || relation === 'half' || relation === 'double')) {
    return roundTempo(sourceBpm)
  }
  return roundTempo(detected)
}

export function roundTempo(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0
  return Math.round(bpm * 10) / 10
}

function formatBpm(bpm: number): string {
  const rounded = roundTempo(bpm)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** One line for the dock: the measured source tempo and how it sits. */
export function tempoReadout(detected: number, sourceBpm: number | null | undefined, projectBpm: number): string {
  if (!(detected > 0)) return 'No clear tempo'
  const bpm = formatBpm(detected)
  const source = relateTempo(detected, sourceBpm)
  const song = relateTempo(detected, projectBpm)
  const parts = [`${bpm} BPM`]
  if (sourceBpm && sourceBpm > 0) {
    if (source === 'match') parts.push('matches the source')
    else if (source === 'half') parts.push(`half the source (${formatBpm(sourceBpm)})`)
    else if (source === 'double') parts.push(`double the source (${formatBpm(sourceBpm)})`)
    else parts.push(`source is ${formatBpm(sourceBpm)}`)
  }
  if (song === 'match') parts.push('matches the song')
  else if (song === 'half') parts.push('half the song')
  else if (song === 'double') parts.push('double the song')
  else if (projectBpm > 0) parts.push(`song is ${formatBpm(projectBpm)}`)
  return parts.join(' · ')
}

export function keyReadout(hearing: ClipHearing): string {
  if (!hearing.clearKey || !hearing.key) return 'No clear key'
  const percent = Math.round(Math.max(0, Math.min(1, hearing.confidence)) * 100)
  return `${hearing.key} · ${percent}%`
}

export function altReadout(hearing: ClipHearing): string {
  if (!hearing.clearKey || !hearing.alt) return ''
  const percent = Math.round(Math.max(0, Math.min(1, hearing.altConfidence)) * 100)
  return `Also ${hearing.alt} · ${percent}%`
}

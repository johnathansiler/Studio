import type { MeterChange, Project, SongSection, TempoPoint } from '../model/types'
import { orderedSections } from '../model/sections'
import { meterChanges, projectTempoMap } from '../model/tempoMap'

/**
 * Read-only views of the shared project.
 * Unstuck, generators, and other screens should use these instead of keeping
 * their own copy of sections, markers, or the tempo map.
 */
export function selectSections(project: Project): SongSection[] {
  return orderedSections(project)
}

export function selectMarkers(project: Project): SongSection[] {
  return orderedSections(project).filter((section) => section.kind === 'marker' || section.durationBeats <= 0)
}

export function selectSongParts(project: Project): SongSection[] {
  return orderedSections(project).filter((section) => section.kind !== 'marker' && section.durationBeats > 0)
}

/** Smallest section that contains this quarter-note beat, if any. */
export function selectSectionAt(project: Project, beat: number): SongSection | null {
  const hits = selectSongParts(project).filter((section) => beat >= section.startBeat - 1e-6 && beat < section.startBeat + section.durationBeats)
  hits.sort((a, b) => a.durationBeats - b.durationBeats)
  return hits[0] ?? null
}

export function selectTempoMap(project: Project): TempoPoint[] {
  return projectTempoMap(project).map((point) => ({ ...point }))
}

export function selectMeterMap(project: Project): MeterChange[] {
  return meterChanges(project).map((change) => ({ ...change }))
}

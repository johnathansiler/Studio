import type { PatternClip } from './steps'
import type { AudioClip, MeterChange, MidiClip, Project, SectionKind, SongSection, TempoPoint } from './types'
import { uid } from './types'
import { downbeatAt, meterAtBeat, projectBeatSample, projectSampleBeat } from './tempoMap'

export const SECTION_KINDS: { id: SectionKind; name: string; color: string }[] = [
  { id: 'intro', name: 'Intro', color: '#79b8d4' },
  { id: 'verse', name: 'Verse', color: '#73c48f' },
  { id: 'pre', name: 'Pre', color: '#8fd0c4' },
  { id: 'chorus', name: 'Chorus', color: '#e0b15a' },
  { id: 'bridge', name: 'Bridge', color: '#c58be0' },
  { id: 'breakdown', name: 'Break', color: '#f09a6a' },
  { id: 'solo', name: 'Solo', color: '#ef6b6b' },
  { id: 'outro', name: 'Outro', color: '#93a399' },
  { id: 'marker', name: 'Marker', color: '#eef3ea' },
  { id: 'custom', name: 'Section', color: '#79b8d4' },
]

export function sectionKind(kind: string): (typeof SECTION_KINDS)[number] {
  return SECTION_KINDS.find((item) => item.id === kind) ?? SECTION_KINDS[SECTION_KINDS.length - 1]
}

export function sectionName(kind: SectionKind, sections: SongSection[]): string {
  const label = sectionKind(kind).name
  const taken = new Set(sections.map((section) => section.name))
  if (!taken.has(label)) return label
  let n = 2
  while (taken.has(`${label} ${n}`)) n += 1
  return `${label} ${n}`
}

/** Four bars of the meter in effect at `beat`, or zero for a marker. */
export function defaultSectionLength(project: Project, beat: number, kind: SectionKind): number {
  if (kind === 'marker') return 0
  const meter = meterAtBeat(project, beat)
  return 4 * meter.numerator * (4 / meter.denominator)
}

export function createSection(project: Project, beat: number, kind: SectionKind, name?: string): SongSection {
  const spec = sectionKind(kind)
  const start = kind === 'marker' ? Math.max(0, beat) : downbeatAt(project, Math.max(0, beat))
  return {
    id: uid('sec'),
    name: name || sectionName(kind, project.sections ?? []),
    kind,
    startBeat: start,
    durationBeats: defaultSectionLength(project, start, kind),
    color: spec.color,
  }
}

const BEAT_EPS = 1e-4

function inRange(beat: number, start: number, end: number) {
  return beat >= start - BEAT_EPS && beat < end - 1e-6
}

interface AudioPlace {
  clip: AudioClip
  trackId: string
  beat: number
  touched: boolean
  remove: boolean
}

function arrangementAudio(project: Project): AudioPlace[] {
  const placed: AudioPlace[] = []
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (clip.slotOnly) continue
      placed.push({ clip, trackId: track.id, beat: projectSampleBeat(project, clip.startSample), touched: false, remove: false })
    }
  }
  return placed
}

function writeAudio(project: Project, placed: AudioPlace[]) {
  for (const track of project.tracks) {
    track.clips = track.clips.filter((clip) => !placed.some((item) => item.clip === clip && item.remove))
  }
  for (const item of placed) {
    if (item.remove || !item.touched) continue
    item.clip.startSample = Math.max(0, Math.round(projectBeatSample(project, item.beat)))
  }
}

function writeLoop(project: Project, loop: { start: number; end: number; touched: boolean }) {
  if (!loop.touched) return
  const start = Math.max(0, Math.round(projectBeatSample(project, loop.start)))
  const end = Math.max(start + 1, Math.round(projectBeatSample(project, loop.end)))
  project.loopStartSample = start
  project.loopEndSample = end
}

function shiftNumber(beat: number, start: number, end: number, delta: number): number | null {
  if (end <= start) return null
  if (inRange(beat, start, end)) return beat + delta
  return null
}

function midiClips(project: Project): MidiClip[] {
  return project.tracks.flatMap((track) => track.midiClips.filter((clip) => !clip.slotOnly && clip.scene == null))
}

function patternClips(project: Project): PatternClip[] {
  return (project.patternClips ?? []).filter((clip) => clip.scene == null)
}

function tempoPoints(project: Project): TempoPoint[] {
  return project.tempoMap ?? []
}

function meterPoints(project: Project): MeterChange[] {
  return project.meterMap ?? []
}

/** Move a section. Its clips, notes, tempo, and meter travel with it. Markers only move themselves. */
export function moveSectionContents(project: Project, sectionId: string, newStartBeat: number): boolean {
  const section = (project.sections ?? []).find((item) => item.id === sectionId)
  if (!section) return false
  const start = section.startBeat
  const next = Math.max(0, newStartBeat)
  const delta = next - start
  if (Math.abs(delta) < 1e-6) return false
  const end = start + Math.max(0, section.durationBeats)
  const audio = arrangementAudio(project)
  const loop = { start: projectSampleBeat(project, project.loopStartSample), end: projectSampleBeat(project, project.loopEndSample), touched: false }
  if (section.durationBeats <= 0) {
    section.startBeat = next
    return true
  }
  const bump = (beat: number) => shiftNumber(beat, start, end, delta)
  for (const item of audio) {
    const moved = bump(item.beat)
    if (moved == null) continue
    item.beat = moved
    item.touched = true
  }
  for (const clip of midiClips(project)) {
    const moved = bump(clip.startBeat)
    if (moved != null) clip.startBeat = moved
  }
  for (const clip of patternClips(project)) {
    const moved = bump(clip.startBeat)
    if (moved != null) clip.startBeat = moved
  }
  for (const lane of project.automation ?? []) {
    for (const point of lane.points) {
      const moved = bump(point.beat)
      if (moved != null) point.beat = moved
    }
  }
  for (const lane of project.rackAutomation ?? []) {
    for (const point of lane.points) {
      const moved = bump(point.beat)
      if (moved != null) point.beat = moved
    }
  }
  for (const point of tempoPoints(project)) {
    if (point.beat <= 1e-6) continue
    const moved = bump(point.beat)
    if (moved != null) point.beat = Math.max(1e-4, moved)
  }
  for (const point of meterPoints(project)) {
    if (point.beat <= 1e-6) continue
    const moved = bump(point.beat)
    if (moved != null) point.beat = Math.max(1e-4, moved)
  }
  for (const other of project.sections ?? []) {
    if (other.id === section.id) continue
    const moved = bump(other.startBeat)
    if (moved != null) other.startBeat = Math.max(0, moved)
  }
  const loopStart = bump(loop.start)
  const loopEnd = bump(loop.end)
  if (loopStart != null) {
    loop.start = loopStart
    loop.touched = true
  }
  if (loopEnd != null) {
    loop.end = loopEnd
    loop.touched = true
  }
  section.startBeat = next
  writeAudio(project, audio)
  writeLoop(project, loop)
  return true
}

function cloneMidi(clip: MidiClip, startBeat: number): MidiClip {
  const copy = JSON.parse(JSON.stringify(clip)) as MidiClip
  copy.id = uid('midi')
  copy.startBeat = startBeat
  copy.notes = copy.notes.map((note) => ({ ...note, id: uid('note') }))
  if (copy.takes) {
    copy.takes = copy.takes.map((take) => ({
      ...take,
      id: uid('take'),
      notes: take.notes.map((note) => ({ ...note, id: uid('note') })),
    }))
  }
  return copy
}

function cloneAudio(clip: AudioClip, startSample: number): AudioClip {
  const copy = JSON.parse(JSON.stringify(clip)) as AudioClip
  copy.id = uid('clip')
  copy.startSample = startSample
  if (copy.stretch?.markers) copy.stretch.markers = copy.stretch.markers.map((marker) => ({ ...marker, id: uid('warp') }))
  if (copy.folder) {
    const laneIds = new Map<string, string>()
    copy.folder.lanes = copy.folder.lanes.map((lane) => {
      const id = uid('lane')
      laneIds.set(lane.id, id)
      return { ...lane, id }
    })
    copy.folder.comps = copy.folder.comps.map((comp) => ({
      ...comp,
      id: uid('comp'),
      segments: comp.segments.map((segment) => ({ ...segment, laneId: laneIds.get(segment.laneId) || segment.laneId })),
    }))
  }
  return copy
}

/** Copy the section to sit just after itself, pushing later material right. */
export function duplicateSectionContents(project: Project, sectionId: string): SongSection | null {
  const section = (project.sections ?? []).find((item) => item.id === sectionId)
  if (!section) return null
  const start = section.startBeat
  const length = Math.max(0, section.durationBeats)
  const copy = createSection(project, start + length, section.kind, sectionName(section.kind, project.sections ?? []))
  copy.startBeat = start + (length > 0 ? length : 1)
  copy.durationBeats = length
  copy.color = section.color
  copy.name = section.name.replace(/(?: copy)+$/, '') + ' copy'
  if (length <= 0) {
    project.sections = [...(project.sections ?? []), copy]
    return copy
  }
  const end = start + length
  const audio = arrangementAudio(project)
  const loop = { start: projectSampleBeat(project, project.loopStartSample), end: projectSampleBeat(project, project.loopEndSample), touched: false }
  const midiCopies: { trackId: string; clip: MidiClip }[] = []
  for (const track of project.tracks) {
    for (const clip of track.midiClips) {
      if (clip.slotOnly || clip.scene != null) continue
      if (inRange(clip.startBeat, start, end)) midiCopies.push({ trackId: track.id, clip })
    }
  }
  const patternCopies = patternClips(project).filter((clip) => inRange(clip.startBeat, start, end))
  const audioCopies = audio.filter((item) => inRange(item.beat, start, end)).map((item) => ({ trackId: item.trackId, clip: item.clip, beat: item.beat }))
  const sectionCopies = (project.sections ?? []).filter((item) => item.id !== section.id && inRange(item.startBeat, start, end))
  const tempoCopies = tempoPoints(project).filter((point) => point.beat > 1e-6 && inRange(point.beat, start, end))
  const meterCopies = meterPoints(project).filter((point) => inRange(point.beat, start, end))
  const push = (beat: number) => (beat >= end ? beat + length : beat)
  for (const item of audio) {
    const next = push(item.beat)
    if (next !== item.beat) {
      item.beat = next
      item.touched = true
    }
  }
  for (const clip of midiClips(project)) clip.startBeat = push(clip.startBeat)
  for (const clip of patternClips(project)) clip.startBeat = push(clip.startBeat)
  for (const lane of project.automation ?? []) for (const point of lane.points) point.beat = push(point.beat)
  for (const lane of project.rackAutomation ?? []) for (const point of lane.points) point.beat = push(point.beat)
  for (const point of tempoPoints(project)) if (point.beat > 1e-6) point.beat = push(point.beat)
  for (const point of meterPoints(project)) if (point.beat > 1e-6) point.beat = push(point.beat)
  for (const other of project.sections ?? []) if (other.id !== section.id) other.startBeat = push(other.startBeat)
  const loopStart = push(loop.start)
  const loopEnd = push(loop.end)
  if (loopStart !== loop.start || loopEnd !== loop.end) {
    loop.start = loopStart
    loop.end = loopEnd
    loop.touched = true
  }
  for (const item of midiCopies) {
    const track = project.tracks.find((candidate) => candidate.id === item.trackId)
    track?.midiClips.push(cloneMidi(item.clip, end + (item.clip.startBeat - start)))
  }
  if (patternCopies.length) {
    project.patternClips = [
      ...(project.patternClips ?? []),
      ...patternCopies.map((clip) => ({ ...clip, id: uid('pcl'), startBeat: end + (clip.startBeat - start) })),
    ]
  }
  for (const lane of project.automation ?? []) {
    const extra = lane.points.filter((point) => inRange(point.beat, start, end)).map((point) => ({ ...point, beat: end + (point.beat - start) }))
    lane.points.push(...extra)
  }
  for (const lane of project.rackAutomation ?? []) {
    const extra = lane.points.filter((point) => inRange(point.beat, start, end)).map((point) => ({ ...point, beat: end + (point.beat - start) }))
    lane.points.push(...extra)
  }
  if (tempoCopies.length) {
    project.tempoMap = [...tempoPoints(project), ...tempoCopies.map((point) => ({ ...point, beat: end + (point.beat - start) }))]
  }
  if (meterCopies.length) {
    project.meterMap = [...meterPoints(project), ...meterCopies.map((point) => ({ ...point, beat: end + (point.beat - start) }))]
  }
  const nested = sectionCopies.map((item) => ({
    ...item,
    id: uid('sec'),
    name: `${item.name} copy`,
    startBeat: end + (item.startBeat - start),
  }))
  project.sections = [...(project.sections ?? []), copy, ...nested]
  for (const item of audioCopies) {
    const track = project.tracks.find((candidate) => candidate.id === item.trackId)
    if (!track) continue
    const beat = end + (item.beat - start)
    const sample = Math.max(0, Math.round(projectBeatSample(project, beat)))
    track.clips.push(cloneAudio(item.clip, sample))
  }
  writeAudio(project, audio)
  writeLoop(project, loop)
  return copy
}

/** Remove a marker, or remove a section's contents and close the gap. */
export function deleteSectionContents(project: Project, sectionId: string): boolean {
  const section = (project.sections ?? []).find((item) => item.id === sectionId)
  if (!section) return false
  const start = section.startBeat
  const length = Math.max(0, section.durationBeats)
  project.sections = (project.sections ?? []).filter((item) => item.id !== sectionId)
  if (length <= 0) return true
  const end = start + length
  const audio = arrangementAudio(project)
  const loop = { start: projectSampleBeat(project, project.loopStartSample), end: projectSampleBeat(project, project.loopEndSample), touched: false }
  const pull = (beat: number) => {
    if (inRange(beat, start, end)) return null
    if (beat >= end - 1e-6) return beat - length
    return beat
  }
  for (const item of audio) {
    const next = pull(item.beat)
    if (next == null) item.remove = true
    else if (next !== item.beat) {
      item.beat = next
      item.touched = true
    }
  }
  for (const track of project.tracks) {
    track.midiClips = track.midiClips.filter((clip) => {
      if (clip.slotOnly || clip.scene != null) return true
      const next = pull(clip.startBeat)
      if (next == null) return false
      clip.startBeat = next
      return true
    })
  }
  if (project.patternClips) {
    project.patternClips = project.patternClips.filter((clip) => {
      if (clip.scene != null) return true
      const next = pull(clip.startBeat)
      if (next == null) return false
      clip.startBeat = next
      return true
    })
  }
  for (const lane of project.automation ?? []) {
    lane.points = lane.points.flatMap((point) => {
      const next = pull(point.beat)
      if (next == null) return []
      point.beat = next
      return [point]
    })
  }
  for (const lane of project.rackAutomation ?? []) {
    lane.points = lane.points.flatMap((point) => {
      const next = pull(point.beat)
      if (next == null) return []
      point.beat = next
      return [point]
    })
  }
  if (project.tempoMap) {
    project.tempoMap = project.tempoMap.flatMap((point) => {
      if (point.beat <= 1e-6) return [point]
      const next = pull(point.beat)
      if (next == null) return []
      point.beat = next
      return [point]
    })
  }
  if (project.meterMap) {
    project.meterMap = project.meterMap.flatMap((point) => {
      if (point.beat <= 1e-6) return [point]
      const next = pull(point.beat)
      if (next == null) return []
      point.beat = next
      return [point]
    })
  }
  project.sections = (project.sections ?? []).flatMap((item) => {
    const next = pull(item.startBeat)
    if (next == null) return []
    item.startBeat = Math.max(0, next)
    return [item]
  })
  const loopStart = pull(loop.start)
  const loopEnd = pull(loop.end)
  if (loopStart == null) loop.start = start
  else loop.start = loopStart
  if (loopEnd == null) loop.end = start
  else loop.end = loopEnd
  if (loop.start !== projectSampleBeat(project, project.loopStartSample) || loop.end !== projectSampleBeat(project, project.loopEndSample)) {
    loop.touched = true
  }
  if (loop.end < loop.start) loop.end = loop.start + length
  writeAudio(project, audio)
  writeLoop(project, loop)
  return true
}

export function resizeSection(project: Project, sectionId: string, durationBeats: number): boolean {
  const section = (project.sections ?? []).find((item) => item.id === sectionId)
  if (!section || section.kind === 'marker') return false
  section.durationBeats = Math.max(0.25, durationBeats)
  return true
}

/** Keep the list ordered for readers such as Unstuck and the generators. */
export function orderedSections(project: Pick<Project, 'sections'>): SongSection[] {
  return [...(project.sections ?? [])]
    .filter((section) => Number.isFinite(section.startBeat) && Number.isFinite(section.durationBeats))
    .sort((a, b) => a.startBeat - b.startBeat || b.durationBeats - a.durationBeats)
}

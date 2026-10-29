import { uid, type AudioClip, type MidiClip, type MidiNote, type Project } from './types'

/** One sixteenth note, in quarter-note beats. */
export const STEP_BEAT = 0.25

export type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'openhat' | 'tom' | 'cymbal' | 'perc' | 'note'

export interface StepCell {
  on: boolean
  velocity: number
  pan: number
  pitch: number
  fine: number
  gate: number
  /** Beats added to the step, after swing. */
  nudge?: number
}

export interface StepChannel {
  id: string
  name: string
  kind: DrumKind
  note: number
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  /** Mixer track or bus id. Null uses the first instrument track. */
  output: string | null
  sampleId: string | null
  /** Row length. Shorter than the pattern loops as a polymeter. */
  steps: number
  /** Null follows the pattern swing. */
  swing: number | null
  cells: StepCell[]
}

export interface BeatPattern {
  id: string
  name: string
  color: string
  steps: number
  swing: number
  channels: StepChannel[]
}

export interface BeatRack {
  activeId: string
  patterns: BeatPattern[]
}

export interface PatternClip {
  id: string
  patternId: string
  startBeat: number
  lengthBeats: number
  /** Session scene, when placed in a clip slot. */
  scene: number | null
  /** Arrangement track this clip lives on. Place uses the lane under the pointer, or Drums. */
  trackId?: string
  /** Set when someone places the clip. The old automatic clip has no flag. */
  placed?: boolean
  /** Beats into the pattern hidden by trimming the left edge. */
  offsetBeats?: number
  /** A piano-roll copy is the one that plays. */
  suppressed?: boolean
}

export interface RenderedHit {
  channelId: string
  kind: DrumKind
  output: string | null
  sampleId: string | null
  volume: number
  pitch: number
  fine: number
  pan: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export function clampStepCount(value: number): number {
  if (!Number.isFinite(value)) return 16
  return Math.max(1, Math.min(64, Math.round(value)))
}

export function clampSwing(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(0.9, value))
}

export function emptyCell(): StepCell {
  return { on: false, velocity: 0.8, pan: 0, pitch: 0, fine: 0, gate: 0.8 }
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

export function channelSteps(channel: StepChannel, patternSteps: number): number {
  return clampStepCount(channel.steps || patternSteps)
}

export function channelSwing(channel: StepChannel, patternSwing: number): number {
  return clampSwing(channel.swing == null ? patternSwing : channel.swing)
}

export function hitsInRange(
  channel: StepChannel,
  patternSteps: number,
  patternSwing: number,
  fromBeat: number,
  toBeat: number,
): RenderedHit[] {
  if (!(toBeat > fromBeat)) return []
  const count = channelSteps(channel, patternSteps)
  const swing = channelSwing(channel, patternSwing)
  const loop = STEP_BEAT * count
  const hits: RenderedHit[] = []
  const first = Math.floor(fromBeat / loop) - 1
  const last = Math.floor((toBeat - 1e-9) / loop) + 1
  for (let cycle = first; cycle <= last; cycle++) {
    for (let step = 0; step < count; step++) {
      const cell = channel.cells[step]
      if (!cell?.on) continue
      const start = cycle * loop + stepStart(step, STEP_BEAT, swing) + (cell.nudge || 0)
      if (start < fromBeat - 1e-9 || start >= toBeat - 1e-9) continue
      const next = cycle * loop + (step + 1 < count ? stepStart(step + 1, STEP_BEAT, swing) : loop)
      const span = Math.max(0.02, next - start)
      const gate = Math.max(0.05, Math.min(1, cell.gate || 0.8))
      hits.push({
        channelId: channel.id,
        kind: channel.kind,
        output: channel.output,
        sampleId: channel.sampleId,
        volume: channel.volume,
        pitch: channel.note + (cell.pitch || 0),
        fine: cell.fine || 0,
        pan: Math.max(-1, Math.min(1, (channel.pan || 0) + (cell.pan || 0))),
        startBeat: start,
        durationBeats: span * gate,
        velocity: Math.max(0.05, Math.min(1, cell.velocity || 0.8)),
      })
    }
  }
  return hits
}

export function renderPattern(pattern: BeatPattern, fromBeat: number, toBeat: number): RenderedHit[] {
  const solo = pattern.channels.some((channel) => channel.solo)
  const hits: RenderedHit[] = []
  for (const channel of pattern.channels) {
    if (channel.mute || (solo && !channel.solo)) continue
    hits.push(...hitsInRange(channel, pattern.steps, pattern.swing, fromBeat, toBeat))
  }
  hits.sort((a, b) => a.startBeat - b.startBeat)
  return hits
}

export function fillEvery(cells: StepCell[], every: number, count: number): StepCell[] {
  const step = Math.max(1, Math.round(every))
  return cells.map((cell, index) => (index < count && index % step === 0 ? { ...cell, on: true } : cell))
}

export function randomizeCells(cells: StepCell[], count: number, rng: () => number = Math.random): StepCell[] {
  return cells.map((cell, index) => {
    if (index >= count) return cell
    return { ...cell, on: rng() > 0.55, velocity: 0.45 + rng() * 0.5 }
  })
}

export function humanizeCells(cells: StepCell[], count: number, amount = 0.4, rng: () => number = Math.random): StepCell[] {
  const depth = Math.max(0, Math.min(1, amount))
  return cells.map((cell, index) => {
    if (index >= count || !cell.on) return cell
    const nudge = (rng() - 0.5) * 2 * depth
    return {
      ...cell,
      velocity: Math.max(0.05, Math.min(1, cell.velocity * (1 + nudge * 0.35))),
      fine: Math.max(-100, Math.min(100, cell.fine + nudge * 12)),
      gate: Math.max(0.05, Math.min(1, cell.gate + nudge * 0.08)),
    }
  })
}

export function shiftCells(cells: StepCell[], count: number, direction: number): StepCell[] {
  const next = cells.map((cell) => ({ ...cell }))
  const width = Math.max(1, Math.min(count, cells.length))
  const head = next.slice(0, width)
  const moved = direction < 0 ? [...head.slice(1), head[0]] : [head[head.length - 1], ...head.slice(0, -1)]
  for (let index = 0; index < width; index++) next[index] = moved[index]
  return next
}

const KIT: { name: string; kind: DrumKind; note: number; color: string; on: number[] }[] = [
  { name: 'Kick', kind: 'kick', note: 36, color: '#ef6b6b', on: [0, 4, 8, 12] },
  { name: 'Snare', kind: 'snare', note: 38, color: '#e0b15a', on: [4, 12] },
  { name: 'Clap', kind: 'clap', note: 39, color: '#f09a6a', on: [4, 12] },
  { name: 'Hat', kind: 'hat', note: 42, color: '#79b8d4', on: [0, 2, 4, 6, 8, 10, 12, 14] },
  { name: 'Perc', kind: 'perc', note: 56, color: '#c58be0', on: [6, 14] },
]

function makeChannel(spec: (typeof KIT)[number], steps: number): StepChannel {
  const cells = Array.from({ length: 64 }, () => emptyCell())
  for (const step of spec.on) {
    if (step < steps) cells[step] = { ...emptyCell(), on: true, velocity: spec.kind === 'hat' ? 0.55 : 0.9 }
  }
  return {
    id: uid('row'),
    name: spec.name,
    kind: spec.kind,
    note: spec.note,
    color: spec.color,
    volume: 0.85,
    pan: spec.kind === 'hat' ? 0.15 : 0,
    mute: false,
    solo: false,
    output: null,
    sampleId: null,
    steps,
    swing: null,
    cells,
  }
}

export function starterPattern(): BeatPattern {
  const steps = 16
  return {
    id: uid('pat'),
    name: 'Pattern 1',
    color: '#73c48f',
    steps,
    swing: 0,
    channels: KIT.map((spec) => makeChannel(spec, steps)),
  }
}

export function clonePattern(pattern: BeatPattern, name: string): BeatPattern {
  return {
    ...pattern,
    id: uid('pat'),
    name,
    channels: pattern.channels.map((channel) => ({
      ...channel,
      id: uid('row'),
      cells: channel.cells.map((cell) => ({ ...cell })),
    })),
  }
}

function cellMatches(cell: StepCell | undefined, factory: StepCell): boolean {
  const value = { ...emptyCell(), ...cell }
  return value.on === factory.on
    && value.velocity === factory.velocity
    && value.pan === factory.pan
    && value.pitch === factory.pitch
    && value.fine === factory.fine
    && value.gate === factory.gate
    && (value.nudge || 0) === (factory.nudge || 0)
}

/** The untouched starter, still sitting on the automatic arrangement clip. */
export function isFactoryPattern(pattern: BeatPattern): boolean {
  if (pattern.name !== 'Pattern 1' || pattern.color !== '#73c48f' || pattern.steps !== 16 || pattern.swing !== 0) return false
  if (pattern.channels.length !== KIT.length) return false
  return pattern.channels.every((channel, index) => {
    const factory = makeChannel(KIT[index], 16)
    if (channel.name !== factory.name || channel.kind !== factory.kind || channel.note !== factory.note) return false
    if (channel.color !== factory.color || channel.volume !== factory.volume || channel.pan !== factory.pan) return false
    if (channel.mute || channel.solo || channel.output != null || channel.sampleId != null) return false
    if (channel.steps !== 16 || channel.swing != null) return false
    const count = Math.max(channel.cells?.length ?? 0, factory.cells.length)
    for (let step = 0; step < count; step++) {
      if (!cellMatches(channel.cells?.[step], factory.cells[step] ?? emptyCell())) return false
    }
    return true
  })
}

function isAutoSeedClip(beats: BeatRack, clip: PatternClip): boolean {
  if (clip.placed || clip.scene != null) return false
  if (Math.abs(clip.offsetBeats || 0) > 1e-6) return false
  if (Math.abs(clip.startBeat) > 1e-6 || Math.abs(clip.lengthBeats - 16 * STEP_BEAT) > 1e-6) return false
  const pattern = beats.patterns.find((item) => item.id === clip.patternId)
  return !!pattern && isFactoryPattern(pattern)
}

/**
 * Drop the one arrangement clip normalizeBeats used to insert with a new rack.
 * A placed flag, any pattern edit, a move, a trim, a session slot, or a second
 * copy at the same spot all stay. The rack itself is never removed.
 */
export function settlePatternClips(beats: BeatRack, clips: PatternClip[]): PatternClip[] {
  const seeds = clips.filter((clip) => isAutoSeedClip(beats, clip))
  const dropId = seeds.length === 1 ? seeds[0].id : null
  const kept: PatternClip[] = []
  for (const clip of clips) {
    if (clip.id === dropId) continue
    if (!clip.placed) clip.placed = true
    kept.push(clip)
  }
  return kept
}

/** Pattern beats heard by one arrangement clip, after a left-edge trim. */
export function patternPlayRange(clip: PatternClip): { from: number; to: number } {
  const from = Math.max(0, clip.offsetBeats || 0)
  return { from, to: from + Math.max(0, clip.lengthBeats) }
}

/** Lane a pattern clip should draw on. A midi lane under the pointer wins. Otherwise null, and Place creates Drums. */
export function patternHostId(tracks: { id: string; type: string }[], laneId: string | null | undefined): string | null {
  if (!laneId) return null
  const track = tracks.find((item) => item.id === laneId)
  return track?.type === 'midi' ? track.id : null
}

/**
 * Arrangement clips always belong to a track that exists.
 * A missing or stale id uses Drums when that track is already there, otherwise the first instrument track.
 */
export function bindPatternClips(clips: PatternClip[], tracks: { id: string; type: string; name: string }[]): PatternClip[] {
  const live = new Set(tracks.map((track) => track.id))
  const home = tracks.find((track) => track.type === 'midi' && track.name === 'Drums')?.id
    ?? tracks.find((track) => track.type === 'midi')?.id
  if (!home) return clips
  for (const clip of clips) {
    if (clip.scene != null) continue
    if (!clip.trackId || !live.has(clip.trackId)) clip.trackId = home
  }
  return clips
}

function takeId(id: string | undefined, seen: Set<string>, prefix: string) {
  if (id && !seen.has(id)) {
    seen.add(id)
    return id
  }
  let next = uid(prefix)
  while (seen.has(next)) next = uid(prefix)
  seen.add(next)
  return next
}

/** Copy every step so a shared cell object cannot light the whole row. */
export function isolatedCells(cells: StepCell[] | undefined): StepCell[] {
  return Array.from({ length: 64 }, (_, index) => ({ ...emptyCell(), ...cells?.[index] }))
}

function repairPattern(pattern: BeatPattern, patternIds: Set<string>): BeatPattern {
  pattern.steps = clampStepCount(pattern.steps || 16)
  pattern.swing = clampSwing(pattern.swing || 0)
  pattern.id = takeId(pattern.id, patternIds, 'pat')
  const seenRow = new Set<StepChannel>()
  const rowIds = new Set<string>()
  pattern.channels = pattern.channels.map((channel) => {
    const shared = seenRow.has(channel)
    seenRow.add(channel)
    const next: StepChannel = shared
      ? { ...channel, cells: (channel.cells ?? []).map((cell) => ({ ...cell })) }
      : channel
    next.steps = clampStepCount(next.steps || pattern.steps)
    next.cells = isolatedCells(next.cells)
    next.swing = next.swing == null ? null : clampSwing(next.swing)
    next.id = takeId(shared ? undefined : next.id, rowIds, 'row')
    return next
  })
  return pattern
}

/** Give duplicated patterns, rows, and clips their own ids and step objects. */
export function normalizeBeats(beats: BeatRack | undefined, clips: PatternClip[] | undefined): { beats: BeatRack; patternClips: PatternClip[] } {
  if (!beats?.patterns?.length) {
    const pattern = starterPattern()
    return {
      beats: { activeId: pattern.id, patterns: [pattern] },
      patternClips: [],
    }
  }
  const seenPattern = new Set<BeatPattern>()
  const patternIds = new Set<string>()
  beats.patterns = beats.patterns.map((pattern) => {
    if (seenPattern.has(pattern)) return repairPattern(clonePattern(pattern, pattern.name), patternIds)
    seenPattern.add(pattern)
    return repairPattern(pattern, patternIds)
  })
  if (!beats.patterns.some((pattern) => pattern.id === beats.activeId)) beats.activeId = beats.patterns[0].id
  return { beats, patternClips: settlePatternClips(beats, separatePatternClips(clips ?? [])) }
}

function separatePatternClips(clips: PatternClip[]): PatternClip[] {
  const seenRef = new Set<PatternClip>()
  const seenId = new Set<string>()
  return clips.map((clip) => {
    const shared = seenRef.has(clip)
    seenRef.add(clip)
    const id = takeId(shared ? undefined : clip.id, seenId, 'pcl')
    if (!shared && id === clip.id) return clip
    return { ...clip, id }
  })
}

function separateNotes(notes: MidiNote[] | undefined): MidiNote[] | undefined {
  if (!notes) return notes
  const seen = new Set<string>()
  let changed = false
  const next = notes.map((note) => {
    if (note?.id && !seen.has(note.id)) {
      seen.add(note.id)
      return note
    }
    changed = true
    const id = uid('note')
    seen.add(id)
    return { ...note, id }
  })
  return changed ? next : notes
}

/** Arrangement and session clips each get their own id. A pasted alias does not stay glued to the original. */
export function repairArrangementIdentities(project: Project) {
  const audioIds = new Set<string>()
  const midiIds = new Set<string>()
  const audioRefs = new Set<AudioClip>()
  const midiRefs = new Set<MidiClip>()
  for (const track of project.tracks) {
    track.clips = track.clips.map((clip) => {
      const shared = audioRefs.has(clip)
      audioRefs.add(clip)
      const id = takeId(shared ? undefined : clip.id, audioIds, 'clip')
      if (!shared && id === clip.id) return clip
      return {
        ...clip,
        id,
        stretch: clip.stretch
          ? { ...clip.stretch, markers: clip.stretch.markers.map((marker) => ({ ...marker })) }
          : undefined,
      }
    })
    track.midiClips = track.midiClips.map((clip) => {
      const shared = midiRefs.has(clip)
      midiRefs.add(clip)
      const notes = separateNotes(clip.notes)
      const id = takeId(shared ? undefined : clip.id, midiIds, 'midi')
      if (!shared && id === clip.id && notes === clip.notes) return clip
      return { ...clip, id, notes: notes ?? [] }
    })
  }
}

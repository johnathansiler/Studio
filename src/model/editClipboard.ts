import { projectBeatSample, projectSampleBeat } from './tempoMap'
import { activeGridBeats, ceilToGrid, grownClipEnd, snapBeatToGrid, snapEditBeat, type SnapProject } from './snapGrid'
import { emptyCell, STEP_BEAT, stepIndexAt, type BeatPattern, type PatternClip, type StepCell } from './steps'
import { uid, type AudioClip, type MidiClip, type MidiNote, type Project, type Track } from './types'

export type EditCommand = 'copy' | 'cut' | 'paste' | 'duplicate'

export interface PasteOffer {
  visible: boolean
  ready: boolean
  reason: string
}

export interface ArrangeSelection {
  audioIds: readonly string[]
  midiIds: readonly string[]
  patternIds: readonly string[]
}

export interface ArrangePiece {
  kind: 'audio' | 'midi' | 'pattern'
  trackId: string
  startBeat: number
  endBeat: number
  audio?: AudioClip
  midi?: MidiClip
  pattern?: PatternClip
}

/** Deep clip copies. Audio buffer ids are kept so the sample data stays shared. */
export interface ArrangeBoard {
  pieces: ArrangePiece[]
}

export interface NoteBoard {
  /** Starts are beats after the earliest selected note. Nested fields are cloned. */
  notes: MidiNote[]
  origin: number
  span: number
}

export interface StepHit {
  channelId: string
  offset: number
  cell: StepCell
}

export interface StepBoard {
  hits: StepHit[]
  span: number
}

export interface PlacedIds {
  audioIds: string[]
  midiIds: string[]
  patternIds: string[]
}

const EMPTY: PasteOffer = { visible: false, ready: false, reason: '' }

/** Ctrl/Cmd+C, X, V, and D. Shift, Alt, and a held repeat stay with other commands. */
export function editShortcut(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }): EditCommand | null {
  if (event.repeat || event.altKey || event.shiftKey) return null
  if (!(event.metaKey || event.ctrlKey)) return null
  const key = event.key.toLowerCase()
  if (key === 'c') return 'copy'
  if (key === 'x') return 'cut'
  if (key === 'v') return 'paste'
  if (key === 'd') return 'duplicate'
  return null
}

function laneOf(kind: ArrangePiece['kind']): 'audio' | 'midi' {
  return kind === 'audio' ? 'audio' : 'midi'
}

function cloneAudio(clip: AudioClip, duplicate: boolean): AudioClip {
  const copy = structuredClone(clip)
  copy.id = uid('clip')
  if (duplicate) copy.name = `${clip.name} copy`
  if (copy.stretch) {
    for (const marker of copy.stretch.markers) marker.id = uid('warp')
  }
  if (copy.wave) {
    for (const region of copy.wave.regions) region.id = uid('reg')
  }
  if (copy.folder) {
    const lanes = new Map<string, string>()
    for (const lane of copy.folder.lanes) {
      const next = uid('take')
      lanes.set(lane.id, next)
      lane.id = next
    }
    const comps = new Map<string, string>()
    for (const comp of copy.folder.comps) {
      const next = uid('comp')
      comps.set(comp.id, next)
      comp.id = next
      for (const segment of comp.segments) segment.laneId = lanes.get(segment.laneId) ?? segment.laneId
    }
    copy.folder.activeCompId = comps.get(copy.folder.activeCompId) ?? copy.folder.activeCompId
  }
  return copy
}

function cloneMidi(clip: MidiClip, duplicate: boolean): MidiClip {
  const copy = structuredClone(clip)
  copy.id = uid('midi')
  if (duplicate) copy.name = `${clip.name} copy`
  for (const note of copy.notes) note.id = uid('note')
  if (copy.takes) {
    for (const take of copy.takes) {
      take.id = uid('take')
      for (const note of take.notes) note.id = uid('note')
    }
  }
  return copy
}

function clonePattern(clip: PatternClip): PatternClip {
  const copy = structuredClone(clip)
  copy.id = uid('pcl')
  copy.placed = true
  return copy
}

export function captureArrange(project: Project, selection: ArrangeSelection): ArrangeBoard | null {
  const audioIds = new Set(selection.audioIds)
  const midiIds = new Set(selection.midiIds)
  const patternIds = new Set(selection.patternIds)
  const pieces: ArrangePiece[] = []
  project.tracks.forEach((track, trackIndex) => {
    void trackIndex
    for (const clip of track.clips) {
      if (!audioIds.has(clip.id) || clip.slotOnly) continue
      const startBeat = projectSampleBeat(project, clip.startSample)
      const endBeat = projectSampleBeat(project, clip.startSample + clip.durationSamples)
      pieces.push({ kind: 'audio', trackId: track.id, startBeat, endBeat, audio: structuredClone(clip) })
    }
    for (const clip of track.midiClips) {
      if (!midiIds.has(clip.id) || clip.slotOnly || clip.scene != null) continue
      pieces.push({
        kind: 'midi',
        trackId: track.id,
        startBeat: clip.startBeat,
        endBeat: clip.startBeat + clip.durationBeats,
        midi: structuredClone(clip),
      })
    }
  })
  for (const clip of project.patternClips ?? []) {
    if (!patternIds.has(clip.id) || clip.scene != null) continue
    pieces.push({
      kind: 'pattern',
      trackId: clip.trackId || '',
      startBeat: clip.startBeat,
      endBeat: clip.startBeat + clip.lengthBeats,
      pattern: structuredClone(clip),
    })
  }
  return pieces.length ? { pieces } : null
}

function pieceLane(piece: ArrangePiece): 'audio' | 'midi' {
  return laneOf(piece.kind)
}

/** One track of one kind pastes onto the selected track. Mixed tracks stay on the originals. */
export function arrangePasteTarget(project: Project, board: ArrangeBoard, selectedTrackId: string | null): { mode: 'selected'; track: Track } | { mode: 'original' } | { mode: 'blocked'; reason: string } {
  const tracks = new Set(board.pieces.map((piece) => piece.trackId))
  const lanes = new Set(board.pieces.map(pieceLane))
  if (tracks.size > 1 || lanes.size > 1) return { mode: 'original' }
  const lane = pieceLane(board.pieces[0])
  const selected = project.tracks.find((track) => track.id === selectedTrackId) ?? null
  if (selected && selected.type === lane) return { mode: 'selected', track: selected }
  if (selected && selected.type !== lane) {
    return {
      mode: 'blocked',
      reason: lane === 'audio' ? 'Select an audio track to paste this clip.' : 'Select an instrument track to paste this clip.',
    }
  }
  const original = project.tracks.find((track) => track.id === board.pieces[0].trackId)
  if (original && original.type === lane) return { mode: 'selected', track: original }
  return { mode: 'blocked', reason: lane === 'audio' ? 'Select an audio track to paste this clip.' : 'Select an instrument track to paste this clip.' }
}

export function clipPasteOffer(project: Project, board: ArrangeBoard | null, selectedTrackId: string | null): PasteOffer {
  if (!board?.pieces.length) return EMPTY
  const target = arrangePasteTarget(project, board, selectedTrackId)
  if (target.mode === 'blocked') return { visible: true, ready: false, reason: target.reason }
  if (target.mode === 'original') {
    const missing = board.pieces.some((piece) => piece.kind !== 'pattern' && !project.tracks.some((track) => track.id === piece.trackId))
    if (missing && board.pieces.every((piece) => piece.kind !== 'pattern' && !project.tracks.some((track) => track.id === piece.trackId))) {
      return { visible: true, ready: false, reason: 'Those tracks are gone, so there is nowhere to paste.' }
    }
  }
  return { visible: true, ready: true, reason: '' }
}

function pushPiece(project: Project, piece: ArrangePiece, track: Track | null, startBeat: number, duplicate: boolean, placed: PlacedIds, startSample?: number) {
  const beat = Math.max(0, startBeat)
  if (piece.kind === 'audio' && piece.audio) {
    if (!track || track.type !== 'audio') return
    const copy = cloneAudio(piece.audio, duplicate)
    copy.startSample = Math.max(0, Math.round(startSample ?? projectBeatSample(project, beat)))
    track.clips.push(copy)
    placed.audioIds.push(copy.id)
    return
  }
  if (piece.kind === 'midi' && piece.midi) {
    if (!track || track.type !== 'midi') return
    const copy = cloneMidi(piece.midi, duplicate)
    copy.startBeat = beat
    track.midiClips.push(copy)
    placed.midiIds.push(copy.id)
    return
  }
  if (piece.kind === 'pattern' && piece.pattern) {
    const host = track && track.type === 'midi' ? track : project.tracks.find((item) => item.id === piece.trackId && item.type === 'midi')
    if (!host) return
    const copy = clonePattern(piece.pattern)
    copy.startBeat = beat
    copy.trackId = host.id
    if (!project.patternClips) project.patternClips = []
    project.patternClips.push(copy)
    placed.patternIds.push(copy.id)
  }
}

export function applyArrangePaste(project: Project, board: ArrangeBoard, selectedTrackId: string | null, playheadSample: number): { ok: true; placed: PlacedIds } | { ok: false; reason: string } {
  const offer = clipPasteOffer(project, board, selectedTrackId)
  if (!offer.ready) return { ok: false, reason: offer.reason || 'Copy a clip first.' }
  const target = arrangePasteTarget(project, board, selectedTrackId)
  const origin = Math.min(...board.pieces.map((piece) => piece.startBeat))
  const anchor = snapEditBeat(projectSampleBeat(project, Math.max(0, playheadSample)), project)
  const placed: PlacedIds = { audioIds: [], midiIds: [], patternIds: [] }
  for (const piece of board.pieces) {
    const start = anchor + (piece.startBeat - origin)
    if (target.mode === 'selected') pushPiece(project, piece, target.track, start, false, placed)
    else {
      const track = project.tracks.find((item) => item.id === piece.trackId) ?? null
      pushPiece(project, piece, track, start, false, placed)
    }
  }
  if (!placed.audioIds.length && !placed.midiIds.length && !placed.patternIds.length) {
    return { ok: false, reason: 'Those tracks are gone, so there is nowhere to paste.' }
  }
  return { ok: true, placed }
}

export function applyArrangeDuplicate(project: Project, selection: ArrangeSelection): PlacedIds | null {
  const board = captureArrange(project, selection)
  if (!board) return null
  const origin = Math.min(...board.pieces.map((piece) => piece.startBeat))
  const end = Math.max(...board.pieces.map((piece) => piece.endBeat))
  const span = Math.max(end - origin, 1e-6)
  const audioOnly = board.pieces.every((piece) => piece.kind === 'audio' && piece.audio)
  const sampleSpan = audioOnly
    ? Math.max(...board.pieces.map((piece) => piece.audio!.startSample + piece.audio!.durationSamples))
      - Math.min(...board.pieces.map((piece) => piece.audio!.startSample))
    : null
  const placed: PlacedIds = { audioIds: [], midiIds: [], patternIds: [] }
  for (const piece of board.pieces) {
    const track = project.tracks.find((item) => item.id === piece.trackId) ?? null
    const sample = sampleSpan != null && piece.audio ? piece.audio.startSample + sampleSpan : undefined
    pushPiece(project, piece, track, piece.startBeat + span, true, placed, sample)
  }
  if (!placed.audioIds.length && !placed.midiIds.length && !placed.patternIds.length) return null
  return placed
}

export function captureNotes(notes: readonly MidiNote[], ids: readonly string[]): NoteBoard | null {
  const wanted = new Set(ids)
  const picked = notes.filter((note) => wanted.has(note.id))
  if (!picked.length) return null
  const origin = Math.min(...picked.map((note) => note.startBeat))
  const end = Math.max(...picked.map((note) => note.startBeat + note.durationBeats))
  return {
    origin,
    span: Math.max(0, end - origin),
    notes: picked.map((note) => {
      const copy = structuredClone(note)
      copy.startBeat = note.startBeat - origin
      return copy
    }),
  }
}

export function materializeNotes(board: NoteBoard, atBeat: number, grid: number): MidiNote[] {
  const anchor = snapBeatToGrid(Math.max(0, atBeat), grid)
  return board.notes.map((note) => {
    const copy = structuredClone(note)
    copy.id = uid('note')
    copy.startBeat = Math.max(0, anchor + note.startBeat)
    return copy
  })
}

export function applyNotePaste(clip: MidiClip, board: NoteBoard, atBeat: number, project: SnapProject): string[] {
  const copies = materializeNotes(board, atBeat, activeGridBeats(project))
  clip.notes.push(...copies)
  const end = copies.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  clip.durationBeats = grownClipEnd(clip.durationBeats, end, project)
  return copies.map((note) => note.id)
}

export function applyNoteDuplicate(clip: MidiClip, ids: readonly string[], project: SnapProject): string[] | null {
  const board = captureNotes(clip.notes, ids)
  if (!board) return null
  const grid = activeGridBeats(project)
  const shift = Math.max(board.span, grid > 0 ? grid : 1 / 16)
  const at = grid > 0 ? ceilToGrid(board.origin + shift, grid) : board.origin + shift
  const copies = materializeNotes(board, at, 0)
  clip.notes.push(...copies)
  const end = copies.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
  clip.durationBeats = grownClipEnd(clip.durationBeats, end, project)
  return copies.map((note) => note.id)
}

export function notePasteOffer(board: NoteBoard | null, clip: boolean): PasteOffer {
  if (!board?.notes.length) return EMPTY
  if (!clip) return { visible: true, ready: false, reason: 'Open a MIDI clip to paste these notes.' }
  return { visible: true, ready: true, reason: '' }
}

/**
 * Playhead when it sits in the clip and on screen. Otherwise the start of the
 * visible bar. The result is snapped to the current grid.
 */
export function notePasteBeat(input: {
  playheadLocal: number | null
  visibleStart: number
  visibleEnd: number
  barBeats: number
  grid: number
}): number {
  const head = input.playheadLocal
  const inView = head != null && head >= input.visibleStart - 1e-4 && head <= input.visibleEnd + 1e-4
  const width = Math.max(1e-6, input.barBeats)
  const bar = Math.floor(Math.max(0, input.visibleStart) / width) * width
  const raw = inView && head != null ? head : bar
  return snapBeatToGrid(Math.max(0, raw), input.grid)
}

export function captureSteps(pattern: BeatPattern, selected: readonly { channelId: string; index: number }[]): StepBoard | null {
  const hits: StepHit[] = []
  let min = Number.POSITIVE_INFINITY
  let max = -1
  for (const step of selected) {
    const channel = pattern.channels.find((row) => row.id === step.channelId)
    const cell = channel?.cells[step.index]
    if (!channel || !cell) continue
    min = Math.min(min, step.index)
    max = Math.max(max, step.index)
  }
  if (!Number.isFinite(min) || max < 0) return null
  for (const step of selected) {
    const channel = pattern.channels.find((row) => row.id === step.channelId)
    const cell = channel?.cells[step.index]
    if (!channel || !cell) continue
    hits.push({ channelId: channel.id, offset: step.index - min, cell: structuredClone(cell) })
  }
  return { hits, span: max - min + 1 }
}

function writeCell(channel: { cells: StepCell[] }, index: number, next: StepCell) {
  const cell = channel.cells[index]
  if (!cell) return
  const shared = channel.cells.some((other, at) => at !== index && other === cell)
  if (!shared) {
    channel.cells[index] = next
    return
  }
  channel.cells = channel.cells.map((item, at) => (item === cell ? (at === index ? next : { ...item }) : item))
}

export function clearSteps(pattern: BeatPattern, selected: readonly { channelId: string; index: number }[]) {
  for (const step of selected) {
    const channel = pattern.channels.find((row) => row.id === step.channelId)
    if (!channel) continue
    writeCell(channel, step.index, emptyCell())
  }
}

/** True when at least one copied step lands inside its channel. */
export function stepPasteFits(pattern: BeatPattern, board: StepBoard, at: number): boolean {
  const start = Math.max(0, Math.round(at))
  for (const hit of board.hits) {
    const channel = pattern.channels.find((row) => row.id === hit.channelId)
    if (!channel) continue
    const count = channel.steps || pattern.steps
    const index = start + hit.offset
    if (index >= 0 && index < count && index < channel.cells.length) return true
  }
  return false
}

export function applyStepPaste(pattern: BeatPattern, board: StepBoard, at: number): { channelId: string; index: number }[] {
  const landed: { channelId: string; index: number }[] = []
  const start = Math.max(0, Math.round(at))
  for (const hit of board.hits) {
    const channel = pattern.channels.find((row) => row.id === hit.channelId)
    if (!channel) continue
    const count = channel.steps || pattern.steps
    const index = start + hit.offset
    if (index < 0 || index >= count || index >= channel.cells.length) continue
    writeCell(channel, index, structuredClone(hit.cell))
    landed.push({ channelId: channel.id, index })
  }
  return landed
}

export function applyStepDuplicate(pattern: BeatPattern, selected: readonly { channelId: string; index: number }[]): { channelId: string; index: number }[] | null {
  const board = captureSteps(pattern, selected)
  if (!board) return null
  const min = Math.min(...selected.map((step) => step.index))
  const landed = applyStepPaste(pattern, board, min + board.span)
  return landed.length ? landed : null
}

export function stepPasteOffer(board: StepBoard | null, pattern: boolean): PasteOffer {
  if (!board?.hits.length) return EMPTY
  if (!pattern) return { visible: true, ready: false, reason: 'Open a pattern to paste these steps.' }
  return { visible: true, ready: true, reason: '' }
}

/**
 * Step under the playhead. The beat folds into the pattern the way the rack
 * line does, then snaps, so bar 2 lands on the same step as bar 1.
 */
export function stepPasteIndex(playheadBeat: number, steps: number, project: SnapProject): number {
  const count = Math.max(1, steps)
  const length = Math.max(STEP_BEAT, count * STEP_BEAT)
  const fold = (beat: number) => ((beat % length) + length) % length
  const snapped = snapEditBeat(fold(Math.max(0, playheadBeat)), project)
  return stepIndexAt(fold(snapped), count)
}

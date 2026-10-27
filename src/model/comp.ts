import type { AudioClip, CompSegment, MidiNote, MidiTake, RecordSettings, SavedComp, TakeFolder, TakeLane } from './types'
import { samplesPerBar } from './time'
import type { TimeSignature } from './time'

export function folderSpan(folder: TakeFolder): { start: number; end: number } {
  let start = Infinity
  let end = 0
  for (const lane of folder.lanes) {
    start = Math.min(start, lane.startSample)
    end = Math.max(end, lane.startSample + lane.durationSamples)
  }
  if (!Number.isFinite(start)) return { start: 0, end: 0 }
  return { start, end }
}

export function createFolder(lane: TakeLane, crossfadeSamples = 256): TakeFolder {
  const comp: SavedComp = {
    id: `${lane.id}_comp`,
    name: 'Comp 1',
    segments: [{ laneId: lane.id, startSample: lane.startSample, endSample: lane.startSample + lane.durationSamples }],
  }
  return { lanes: [lane], comps: [comp], activeCompId: comp.id, crossfadeSamples }
}

export function activeComp(folder: TakeFolder): SavedComp {
  return folder.comps.find((comp) => comp.id === folder.activeCompId) || folder.comps[0]
}

function mergeTouching(segments: CompSegment[]): CompSegment[] {
  const sorted = segments
    .filter((segment) => segment.endSample - segment.startSample > 0)
    .map((segment) => ({ ...segment }))
    .sort((a, b) => a.startSample - b.startSample || a.endSample - b.endSample)
  const merged: CompSegment[] = []
  for (const segment of sorted) {
    const last = merged[merged.length - 1]
    if (last && last.laneId === segment.laneId && segment.startSample <= last.endSample) {
      last.endSample = Math.max(last.endSample, segment.endSample)
    } else merged.push(segment)
  }
  return merged
}

function withActive(folder: TakeFolder, segments: CompSegment[]): TakeFolder {
  const next = mergeTouching(segments)
  return {
    ...folder,
    comps: folder.comps.map((comp) => (comp.id === folder.activeCompId ? { ...comp, segments: next } : comp)),
  }
}

/** Add a pass. Existing comps stay put; audio outside their coverage belongs to the new lane. */
export function addLane(folder: TakeFolder, lane: TakeLane): TakeFolder {
  const lanes = [...folder.lanes, lane]
  const laneEnd = lane.startSample + lane.durationSamples
  const comps = folder.comps.map((comp) => {
    const covered = mergeTouching(comp.segments)
    let cursor = lane.startSample
    const extra: CompSegment[] = []
    const overlapping = covered
      .filter((segment) => segment.endSample > lane.startSample && segment.startSample < laneEnd)
      .sort((a, b) => a.startSample - b.startSample)
    for (const segment of overlapping) {
      if (segment.startSample > cursor) extra.push({ laneId: lane.id, startSample: cursor, endSample: Math.min(segment.startSample, laneEnd) })
      cursor = Math.max(cursor, segment.endSample)
    }
    if (cursor < laneEnd) extra.push({ laneId: lane.id, startSample: cursor, endSample: laneEnd })
    return { ...comp, segments: mergeTouching([...comp.segments, ...extra]) }
  })
  return { ...folder, lanes, comps }
}

/** Replace the active comp between the two samples with one lane. */
export function swipeComp(folder: TakeFolder, laneId: string, from: number, to: number): TakeFolder {
  if (!folder.lanes.some((lane) => lane.id === laneId)) return folder
  const start = Math.min(from, to)
  const end = Math.max(from, to)
  if (end - start < 1) return folder
  const kept: CompSegment[] = []
  for (const segment of activeComp(folder).segments) {
    if (segment.endSample <= start || segment.startSample >= end) {
      kept.push(segment)
      continue
    }
    if (segment.startSample < start) kept.push({ ...segment, endSample: start })
    if (segment.endSample > end) kept.push({ ...segment, startSample: end })
  }
  kept.push({ laneId, startSample: start, endSample: end })
  return withActive(folder, kept)
}

export function saveComp(folder: TakeFolder, name: string, id: string): TakeFolder {
  const current = activeComp(folder)
  const saved: SavedComp = { id, name, segments: current.segments.map((segment) => ({ ...segment })) }
  return { ...folder, comps: [...folder.comps, saved], activeCompId: id }
}

export function recallComp(folder: TakeFolder, id: string): TakeFolder {
  if (!folder.comps.some((comp) => comp.id === id)) return folder
  return { ...folder, activeCompId: id }
}

export interface CompPiece {
  bufferId: string
  startSample: number
  offsetSamples: number
  durationSamples: number
  fadeInSamples: number
  fadeOutSamples: number
  laneId: string
}

/** Active comp as playback slices. Boundaries between lanes overlap by the folder crossfade. */
export function compPieces(folder: TakeFolder, edgeFadeIn = 64, edgeFadeOut = 128): CompPiece[] {
  const segments = mergeTouching(activeComp(folder).segments)
  const fade = Math.max(0, folder.crossfadeSamples)
  return segments.flatMap((segment, index) => {
    const lane = folder.lanes.find((item) => item.id === segment.laneId)
    if (!lane) return []
    const previous = segments[index - 1]
    const next = segments[index + 1]
    const joinBefore = Boolean(previous && previous.laneId !== segment.laneId)
    const joinAfter = Boolean(next && next.laneId !== segment.laneId)
    const lead = joinBefore ? Math.floor(fade / 2) : 0
    const tail = joinAfter ? Math.floor(fade / 2) : 0
    let start = segment.startSample - lead
    let end = segment.endSample + tail
    let offset = lane.offsetSamples + (start - lane.startSample)
    if (offset < 0) {
      start -= offset
      offset = 0
    }
    const laneEnd = lane.startSample + lane.durationSamples
    if (end > laneEnd + (lane.offsetSamples - offset)) {
      // Keep the slice inside the lane's recorded audio.
      const available = lane.durationSamples - (offset - lane.offsetSamples)
      end = Math.min(end, start + Math.max(0, available))
    }
    const duration = end - start
    if (duration < 1) return []
    return [{
      bufferId: lane.bufferId,
      startSample: start,
      offsetSamples: offset,
      durationSamples: duration,
      fadeInSamples: joinBefore ? fade : edgeFadeIn,
      fadeOutSamples: joinAfter ? fade : edgeFadeOut,
      laneId: lane.id,
    }]
  })
}

export function folderClip(id: string, name: string, folder: TakeFolder, gain = 1): AudioClip {
  const span = folderSpan(folder)
  const first = folder.lanes[0]
  return {
    id,
    name,
    bufferId: first?.bufferId || '',
    startSample: span.start,
    offsetSamples: 0,
    durationSamples: Math.max(1, span.end - span.start),
    fadeInSamples: 64,
    fadeOutSamples: 128,
    gain,
    source: first?.source || 'local',
    peerId: first?.peerId,
    folder,
  }
}

/** Flatten keeps each comp slice as its own clip. */
export function flattenPieces(parent: AudioClip): AudioClip[] {
  if (!parent.folder) return [{ ...parent }]
  return compPieces(parent.folder, parent.fadeInSamples, parent.fadeOutSamples).map((piece, index) => ({
    ...parent,
    id: `${parent.id}_flat_${index}`,
    name: `${parent.name} ${index + 1}`,
    folder: undefined,
    bufferId: piece.bufferId,
    startSample: piece.startSample,
    offsetSamples: piece.offsetSamples,
    durationSamples: piece.durationSamples,
    fadeInSamples: piece.fadeInSamples,
    fadeOutSamples: piece.fadeOutSamples,
  }))
}

function laneSample(lane: TakeLane, audio: Float32Array[] | undefined, channel: number, timeline: number): number {
  if (!audio) return 0
  const data = audio[channel]
  if (!data) return 0
  const index = lane.offsetSamples + (timeline - lane.startSample)
  const i = Math.floor(index)
  if (i < 0 || i >= data.length) return 0
  const frac = index - i
  const next = i + 1 < data.length ? data[i + 1] : data[i]
  return data[i] * (1 - frac) + next * frac
}

/** Mix the active comp into new channel buffers, with linear crossfades at lane changes. */
export function renderComp(folder: TakeFolder, audio: Map<string, Float32Array[]>): Float32Array[] {
  const span = folderSpan(folder)
  const length = Math.max(1, span.end - span.start)
  const pieces = compPieces(folder, 0, 0)
  let channels = 1
  for (const lane of folder.lanes) channels = Math.max(channels, audio.get(lane.bufferId)?.length || 1)
  const mixed = Array.from({ length: channels }, () => new Float32Array(length))
  for (const piece of pieces) {
    const lane = folder.lanes.find((item) => item.id === piece.laneId)
    if (!lane) continue
    const buffers = audio.get(piece.bufferId)
    for (let i = 0; i < piece.durationSamples; i++) {
      const timeline = piece.startSample + i
      const at = timeline - span.start
      if (at < 0 || at >= length) continue
      let gain = 1
      if (piece.fadeInSamples > 0 && i < piece.fadeInSamples) gain *= i / piece.fadeInSamples
      const fadeOutAt = piece.durationSamples - piece.fadeOutSamples
      if (piece.fadeOutSamples > 0 && i > fadeOutAt) gain *= Math.max(0, (piece.durationSamples - i) / piece.fadeOutSamples)
      for (let channel = 0; channel < channels; channel++) {
        mixed[channel][at] += laneSample(lane, buffers, channel, timeline) * gain
      }
    }
  }
  return mixed
}

export interface CaptureSlice {
  startSample: number
  durationSamples: number
  captureOffset: number
}

/** Align a capture, keep the punch window, then split cycle passes onto the loop. */
export function sliceCapture(opts: {
  captureStart: number
  captureLength: number
  compensation: number
  punchFrom?: number
  punchTo?: number
  loopStart?: number
  loopEnd?: number
}): CaptureSlice[] {
  let start = opts.captureStart - Math.max(0, opts.compensation)
  let offset = 0
  let length = opts.captureLength
  if (start < 0) {
    offset += -start
    length += start
    start = 0
  }
  if (length <= 0) return []
  if (opts.punchFrom != null && opts.punchTo != null && opts.punchTo > opts.punchFrom) {
    const from = Math.max(start, opts.punchFrom)
    const to = Math.min(start + length, opts.punchTo)
    if (to - from < 1) return []
    offset += from - start
    length = to - from
    start = from
  }
  const loop = opts.loopEnd != null && opts.loopStart != null ? opts.loopEnd - opts.loopStart : 0
  if (loop <= 1 || opts.loopStart == null) {
    return [{ startSample: Math.round(start), durationSamples: Math.round(length), captureOffset: Math.round(offset) }]
  }
  const slices: CaptureSlice[] = []
  let done = 0
  while (done < length - 0.5) {
    const timeline = start + done
    if (timeline < opts.loopStart) {
      const room = Math.min(opts.loopStart - timeline, length - done)
      slices.push({ startSample: Math.round(timeline), durationSamples: Math.round(room), captureOffset: Math.round(offset + done) })
      done += room
      continue
    }
    const phase = (timeline - opts.loopStart) % loop
    const room = Math.min(loop - phase, length - done)
    slices.push({
      startSample: Math.round(opts.loopStart + phase),
      durationSamples: Math.max(1, Math.round(room)),
      captureOffset: Math.round(offset + done),
    })
    done += room
  }
  return slices.filter((slice) => slice.durationSamples > 0)
}

export function rollSamples(amount: number, unit: 'bars' | 'seconds', sampleRate: number, tempo: number, signature: TimeSignature): number {
  const safe = Math.max(0, amount)
  if (unit === 'seconds') return Math.round(safe * sampleRate)
  return Math.round(safe * samplesPerBar(sampleRate, tempo, signature))
}

export function punchWindow(settings: RecordSettings, sampleRate: number, tempo: number, signature: TimeSignature) {
  const pre = settings.quick ? 0 : rollSamples(settings.preRoll, settings.rollUnit, sampleRate, tempo, signature)
  const post = settings.quick ? 0 : rollSamples(settings.postRoll, settings.rollUnit, sampleRate, tempo, signature)
  const recordFrom = Math.max(0, Math.round(settings.punchIn))
  const recordTo = Math.max(recordFrom + 1, Math.round(settings.punchOut))
  return {
    playFrom: Math.max(0, recordFrom - pre),
    recordFrom,
    recordTo,
    stopAt: recordTo + post,
  }
}

export function quickPunch(settings: RecordSettings, playhead: number, sampleRate: number, tempo: number, signature: TimeSignature, recording: boolean): RecordSettings {
  const bar = Math.max(1, Math.round(samplesPerBar(sampleRate, tempo, signature)))
  if (!recording) {
    return {
      ...settings,
      punchEnabled: true,
      quick: true,
      punchIn: Math.max(0, Math.round(playhead)),
      punchOut: Math.max(0, Math.round(playhead)) + bar * 2,
    }
  }
  return {
    ...settings,
    punchEnabled: true,
    quick: true,
    punchOut: Math.max(Math.round(playhead), Math.round(settings.punchIn) + 64),
  }
}

/** Samples to shift a recording earlier so it lines up with what the player heard. */
export function recordOffsetSamples(baseLatency: number, outputLatency: number, sampleRate: number): number {
  const seconds = Math.max(0, baseLatency) + Math.max(0, outputLatency)
  return Math.round(seconds * sampleRate)
}

export function inputChannel(input: string): number | null {
  if (input === 'mic') return null
  const match = /^mic:(\d+)$/.exec(input)
  if (!match) return null
  return Number(match[1])
}

export function mediaChannelCount(inputs: string[]): number {
  let count = 1
  for (const input of inputs) {
    const channel = inputChannel(input)
    if (channel != null) count = Math.max(count, channel + 1)
    else if (input === 'mic') count = Math.max(count, 1)
  }
  return count
}

export function channelConstraints(count: number): MediaTrackConstraints {
  return {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: Math.max(1, count) },
  }
}

export function applyMidiPass(existing: MidiNote[], incoming: MidiNote[], takes: MidiTake[], mode: 'merge' | 'takes', name: string, id: string) {
  const copy = (notes: MidiNote[]) => notes.map((note) => ({ ...note }))
  if (mode === 'merge') {
    const notes = [...existing, ...copy(incoming)]
    const take: MidiTake = { id, name, notes: copy(incoming) }
    return { notes, takes: [...takes, take], activeTakeId: id }
  }
  const archived: MidiTake | null = existing.length ? { id: `${id}_prev`, name: 'Previous', notes: copy(existing) } : null
  const already = archived ? takes.some((take) => sameNotes(take.notes, archived.notes)) : true
  const kept = archived && !already ? [...takes, archived] : [...takes]
  const take: MidiTake = { id, name, notes: copy(incoming) }
  return { notes: copy(incoming), takes: [...kept, take], activeTakeId: id }
}

function sameNotes(a: MidiNote[], b: MidiNote[]): boolean {
  if (a.length !== b.length) return false
  return a.every((note, index) => note.pitch === b[index].pitch && note.startBeat === b[index].startBeat && note.durationBeats === b[index].durationBeats && note.velocity === b[index].velocity)
}

export function recallMidiTake(takes: MidiTake[], id: string): MidiNote[] | null {
  const take = takes.find((item) => item.id === id)
  return take ? take.notes.map((note) => ({ ...note })) : null
}

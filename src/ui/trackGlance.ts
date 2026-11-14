import { insertLabel } from './insertLabel'
import { formatPan } from '../model/mixLaw'
import { NOTE_NAMES, scaleById } from '../model/scale'
import { lengthReadout, positionReadout } from '../model/snapGrid'
import { projectSampleBeat } from '../model/tempoMap'
import { gainToDb, quartersPerBar } from '../model/time'
import type { PatternClip } from '../model/steps'
import type { AudioClip, MidiClip, PluginInstance, Project, Track } from '../model/types'
import { formatTempo } from '../model/tap'
import { trackKindLabel } from './trackKind'

const SOURCE_IDS = new Set(['sampler', 'synth', 'scaler', 'steps', 'pads', 'drums', 'drum-machine'])

const INSTRUMENT_WORDS: Record<string, string> = {
  synth: 'Synth',
  sampler: 'Sampler',
  '808': '808',
  'drum-machine': 'Beat Machine',
  library: 'Library',
  scaler: 'Scaler',
  pads: 'Beat Machine',
}

export interface GlanceClip {
  name: string
  length: string
  start: string
}

export interface TrackGlance {
  empty: boolean
  id: string
  name: string
  type: string
  source: string
  volume: string
  pan: string
  mute: boolean
  solo: boolean
  arm: boolean
  inserts: string
  clip: GlanceClip | null
  playhead: string
  bpm: string
  key: string
  color: string
}

type BufferBook = { get(id: string): { name: string } | undefined }

export function trackGlance(input: {
  project: Project
  track: Track | null
  buffers?: BufferBook
  selectedClipId?: string | null
  selectedMidiClipId?: string | null
  selectedPatternClipId?: string | null
  playheadSample?: number
}): TrackGlance {
  const project = input.project
  const bar = quartersPerBar(project.timeSignature)
  const playBeat = projectSampleBeat(project, Math.max(0, input.playheadSample ?? 0))
  const shared = {
    playhead: positionReadout(playBeat, bar),
    bpm: formatTempo(project.tempo),
    key: keyOf(project),
  }
  const track = input.track
  if (!track) {
    return {
      empty: true,
      id: '',
      name: '',
      type: '',
      source: '',
      volume: '',
      pan: '',
      mute: false,
      solo: false,
      arm: false,
      inserts: '',
      clip: null,
      color: '',
      ...shared,
    }
  }
  const plugins = track.plugins ?? []
  const sourcePlugin = plugins.find((plugin) => SOURCE_IDS.has(plugin.pluginId))
  return {
    empty: false,
    id: track.id,
    name: track.name,
    type: trackKindLabel(track),
    source: sourceOf(track, sourcePlugin, input.buffers),
    volume: gainToDb(track.volume),
    pan: formatPan(track.pan),
    mute: track.mute,
    solo: track.solo,
    arm: track.armed,
    inserts: insertsOf(track, sourcePlugin),
    clip: clipOf(project, track, bar, input),
    color: track.color,
    ...shared,
  }
}

function keyOf(project: Project) {
  const scale = scaleById(project.scale?.scale)
  const root = NOTE_NAMES[((project.scale?.root ?? 0) % 12 + 12) % 12]
  return `${root} ${scale?.name ?? ''}`.trim()
}

function sourceOf(track: Track, plugin: PluginInstance | undefined, buffers?: BufferBook) {
  if (plugin?.pluginId === 'sampler') {
    const id = plugin.sampler?.bufferId
    const named = id ? buffers?.get(id)?.name : ''
    if (named) return named
  }
  if (plugin) return insertLabel(plugin.pluginId, plugin)
  if (track.library?.name) return track.library.name
  if (track.instrument && track.instrument !== 'none') return INSTRUMENT_WORDS[track.instrument] ?? track.instrument
  if (track.scaler) return 'Scaler'
  if (track.padKit) return 'Beat Machine'
  const clip = track.clips.find((item) => !item.slotOnly)
  if (clip?.name) return clip.name
  if (track.type === 'audio') return 'No sample'
  if (track.type === 'midi') return 'No instrument'
  return '—'
}

function insertsOf(track: Track, source: PluginInstance | undefined) {
  const names = [
    ...track.inserts.map((insert) => insert.type),
    ...track.plugins.filter((plugin) => plugin !== source).map((plugin) => insertLabel(plugin.pluginId, plugin)),
  ].filter(Boolean)
  return names.length ? names.join(', ') : '—'
}

function clipOf(
  project: Project,
  track: Track,
  bar: number,
  input: { selectedClipId?: string | null; selectedMidiClipId?: string | null; selectedPatternClipId?: string | null },
): GlanceClip | null {
  const audio = track.clips.find((clip) => clip.id === input.selectedClipId)
  if (audio) return audioClip(project, audio, bar)
  const midi = track.midiClips.find((clip) => clip.id === input.selectedMidiClipId)
  if (midi) return midiClip(midi, bar)
  const pattern = (project.patternClips ?? []).find((clip) => clip.id === input.selectedPatternClipId && clip.trackId === track.id)
  if (pattern) return patternClip(project, pattern, bar)
  return null
}

function audioClip(project: Project, clip: AudioClip, bar: number): GlanceClip {
  const start = projectSampleBeat(project, clip.startSample)
  const end = projectSampleBeat(project, clip.startSample + clip.durationSamples)
  return { name: clip.name, length: lengthReadout(start, end, bar), start: positionReadout(start, bar) }
}

function midiClip(clip: MidiClip, bar: number): GlanceClip {
  return {
    name: clip.name,
    length: lengthReadout(clip.startBeat, clip.startBeat + clip.durationBeats, bar),
    start: positionReadout(clip.startBeat, bar),
  }
}

function patternClip(project: Project, clip: PatternClip, bar: number): GlanceClip {
  const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
  return {
    name: pattern?.name || 'Pattern',
    length: lengthReadout(clip.startBeat, clip.startBeat + clip.lengthBeats, bar),
    start: positionReadout(clip.startBeat, bar),
  }
}

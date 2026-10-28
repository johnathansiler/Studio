import { MASTERING_IDS } from '../audio/master/assistant'
import { scheduleStretchCommit, stretchCacheKey } from '../audio/stretch/commit'
import { createPlugin, normalizeProject, presetParams } from '../audio/plugins/catalog'
import {
  detectRoot,
  emptyLooper,
  emptySampler,
  fadeChannel,
  makeZone,
  mixTakes,
  nextBar,
  normalizeChannel,
  reverseChannel,
  sliceBeats,
  sliceEven,
  sliceTransients,
  slicesToNotes,
  snapZero,
  syncedLoopSamples,
  tempoFromLoop,
  trimSilence,
  type LoopTake,
} from '../audio/sample/engine'
import { defaultStretch, inspectClip, renderClipChannels, sourceSamplesOf, stretchEdge, timelineSamples } from '../audio/stretch/engine'
import { findCycle, MASTER } from '../audio/routing'
import type { SamplerProgram } from '../audio/multisample/types'
import { insertIndex, tracksFor, type AddTrackSpec } from '../model/addTrack'
import { addLane, applyMidiPass, createFolder, flattenPieces, folderClip, folderSpan, quickPunch as quickPunchSettings, recallComp, recallMidiTake, renderComp, saveComp, swipeComp } from '../model/comp'
import { splitAudioClip, trimAudioClip, moveAudioClip, clampFade, moveMidiNote, resizeMidiNote } from '../model/clips'
import { splitMidiClip, stretchMidiClip, trimMidiClip } from '../model/edit'
import { activeTool, setActiveTool, type ArrangeTool } from './tools'
import { demoMidiNotes } from '../model/demo'
import {
  clipById,
  dueFollow,
  followTarget,
  quantizeSample,
  retrigger,
  sceneClip,
  sceneIndex,
  SESSION_SCENES,
  type SessionClock,
  type TransportSlot,
} from '../model/launch'
import type { RollTool } from '../model/paint'
import { defaultRoll } from '../model/paint'
import { progressionById, romanLine, starterParts } from '../model/progressions'
import {
  defaultQuantize,
  detectTransients,
  extractGroove,
  normalizeQuantize,
  quantizeAudioStart,
  quantizeAudioWarp,
  quantizeChannel,
  quantizeMidi,
  type QuantizeSettings,
} from '../model/quantize'
import { cloneRack, defaults, DEVICE_PARAMS, FACTORY_PRESETS, makeDevice, normalizeProjectRack, normalizeTrackRack, type DeviceKind } from '../model/rack'
import { normalizeScale, patternNotes, snapPitch, voiceChord, type PlayNote, type ScaleId, type ScaleState } from '../model/scale'
import {
  clonePattern,
  fillEvery,
  humanizeCells,
  randomizeCells,
  renderPattern,
  shiftCells,
  type StepCell,
} from '../model/steps'
import { createEmptyProject, defaultInsert, defaultRecord, makeTrack, uid, TRACK_COLORS } from '../model/types'
import type { AudioAsset, AudioClip, ClipStretch, FollowAction, InsertType, LaunchMode, LaunchQuant, MidiClip, MidiNote, PluginInstance, Project, RecordSettings, TakeLane, Track } from '../model/types'
import { beatsToSamples, quartersPerBar, samplesToBeats, snapSample } from '../model/time'
import { linearResample } from '../model/wav'
import { renderDrum, DRUM_PADS } from '../model/drums'
import {
  chainSong,
  chopSample,
  chopsToPads,
  doubleLength,
  eraseWhilePlaying,
  kitPreset,
  normalizePadKit,
  ratchetBeats,
  recordTake,
  type PadProgram,
  type SequenceNote,
} from '../model/padMachine'

export type WorkspaceView = 'arrange' | 'mix' | 'session' | 'beats'

export interface Toast {
  id: string
  text: string
  tone?: 'info' | 'warn' | 'good'
}

type Listener = () => void

interface QuantizeResult {
  notes: { trackId: string; clipId: string; notes: MidiNote[] }[]
  channels: { id: string; cells: StepCell[] }[]
  audio: { trackId: string; clipId: string; clip: AudioClip }[]
}

export class ProjectStore {
  project: Project
  buffers = new Map<string, AudioAsset>()
  selectedTrackId: string | null
  selectedClipId: string | null
  selectedClipIds: string[] = []
  selectedMidiClipId: string | null
  selectedMidiClipIds: string[] = []
  selectedNoteId: string | null
  selectedNoteIds: string[] = []
  view: WorkspaceView = 'arrange'
  launched: Record<string, string | null> = {}
  launchAt: Record<string, number> = {}
  launchGen: Record<string, number> = {}
  /** Armed empty slot for the next recording. */
  sessionSlot: { trackId: string; scene: number } | null = null
  sessionEdit: { trackId: string; scene: number } | null = null
  captureLog: { trackId: string; clipId: string; sample: number }[] = []
  pendingTransport: Record<string, unknown> | null = null
  transportMode: 'arrangement' | 'session' = 'arrangement'
  private followed: Record<string, true> = {}
  /** Guests mirror the host arrangement and cannot edit it. */
  remoteFollow = false
  rackTrackId: string | null = null
  rackFlip = false
  rackDetail = false
  /** Letter keys play notes while this is on, so tap-tempo stays off T. */
  keyboardMidi = false
  private tempoGroup = false
  toasts: Toast[] = []
  version = 0
  rowClipboard: StepCell[] | null = null
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()
  private takeUndo: { trackId: string; clipId: string; notes: MidiNote[]; durationBeats: number } | null = null
  private drafted = false

  /** Open plugin sheet. Not saved with the project. */
  pluginFocus: { trackId: string; pluginId: string } | null = null
  /** Stem sheet target. Not saved. */
  stemTrackId: string | null = null
  stemClipId: string | null = null
  stemPaused = false
  stemStatus: { phase: 'download' | 'separate'; ratio: number; line: string } | null = null
  quantizeOpen = false
  quantizeDraft: QuantizeSettings = defaultQuantize()
  quantizePreview: QuantizeResult | null = null
  private takeOpen = false
  private takeNotes: { trackId: string; clipId: string; noteId: string }[] = []
  /** Clip settings. Not saved. */
  clipSheet = false
  private bypassed: { id: string; enabled: boolean }[] | null = null

  constructor(project = createEmptyProject(), buffers?: Map<string, AudioAsset>) {
    this.project = normalizeProjectRack(normalizeProject(project))
    if (buffers) this.buffers = buffers
    this.selectedTrackId = project.tracks[0]?.id ?? null
    this.selectedClipId = null
    this.selectedMidiClipId = null
    this.selectedNoteId = null
    this.selectedNoteIds = []
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.version += 1
    for (const fn of this.listeners) fn()
  }

  private snapshot() {
    this.past.push(JSON.stringify(this.project))
    if (this.past.length > 80) this.past.shift()
    this.future = []
  }

  private mutate(fn: () => void) {
    if (this.remoteFollow) return
    this.quantizePreview = null
    this.drafted = false
    this.snapshot()
    fn()
    this.emit()
  }

  /** One undo step for a drag. The first call snapshots; later calls only edit. */
  draft(fn: () => void) {
    if (this.remoteFollow) return
    if (!this.drafted) {
      this.snapshot()
      this.drafted = true
    }
    fn()
    this.emit()
  }

  endDraft() {
    this.drafted = false
  }

  undo() {
    if (this.remoteFollow) return
    this.tempoGroup = false
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(JSON.stringify(this.project))
    this.project = JSON.parse(prev) as Project
    this.quantizePreview = null
    this.emit()
  }

  redo() {
    if (this.remoteFollow) return
    this.tempoGroup = false
    const next = this.future.pop()
    if (!next) return
    this.past.push(JSON.stringify(this.project))
    this.project = JSON.parse(next) as Project
    this.quantizePreview = null
    this.emit()
  }

  toast(text: string, tone: Toast['tone'] = 'info') {
    const id = uid('toast')
    this.toasts = [...this.toasts, { id, text, tone }]
    this.emit()
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id)
      this.emit()
    }, 4200)
  }

  setView(view: WorkspaceView) {
    this.view = view
    this.emit()
  }

  setTransportMode(mode: 'arrangement' | 'session') {
    this.transportMode = mode
    this.emit()
  }

  selectTrack(id: string | null) {
    this.selectedTrackId = id
    this.emit()
  }

  selectClip(trackId: string, clipId: string | null, midi = false, openSheet = true, additive = false) {
    this.selectedTrackId = trackId
    if (midi) {
      this.selectedClipId = null
      this.selectedClipIds = []
      if (!clipId) {
        this.selectedMidiClipId = null
        this.selectedMidiClipIds = []
      } else if (additive) {
        const has = this.selectedMidiClipIds.includes(clipId)
        this.selectedMidiClipIds = has ? this.selectedMidiClipIds.filter((id) => id !== clipId) : [...this.selectedMidiClipIds, clipId]
        this.selectedMidiClipId = this.selectedMidiClipIds.at(-1) ?? null
      } else {
        this.selectedMidiClipId = clipId
        this.selectedMidiClipIds = [clipId]
      }
      this.selectedNoteId = null
      this.selectedNoteIds = []
    } else {
      this.selectedMidiClipId = null
      this.selectedMidiClipIds = []
      if (!clipId) {
        this.selectedClipId = null
        this.selectedClipIds = []
      } else if (additive) {
        const has = this.selectedClipIds.includes(clipId)
        this.selectedClipIds = has ? this.selectedClipIds.filter((id) => id !== clipId) : [...this.selectedClipIds, clipId]
        this.selectedClipId = this.selectedClipIds.at(-1) ?? null
      } else {
        this.selectedClipId = clipId
        this.selectedClipIds = [clipId]
      }
      this.selectedNoteId = null
      this.selectedNoteIds = []
      if (openSheet) {
        this.stemTrackId = null
        this.stemClipId = null
      }
      this.clipSheet = Boolean(openSheet && clipId)
    }
    this.emit()
  }

  selectRegion(audioIds: string[], midiIds: string[], trackId: string | null, additive = false) {
    this.selectedClipIds = additive ? uniqueIds([...this.selectedClipIds, ...audioIds]) : audioIds
    this.selectedMidiClipIds = additive ? uniqueIds([...this.selectedMidiClipIds, ...midiIds]) : midiIds
    this.selectedClipId = this.selectedClipIds.at(-1) ?? null
    this.selectedMidiClipId = this.selectedMidiClipIds.at(-1) ?? null
    if (trackId) this.selectedTrackId = trackId
    this.clipSheet = false
    this.emit()
  }

  selectNotes(ids: string[], additive = false) {
    this.selectedNoteIds = additive ? uniqueIds([...this.selectedNoteIds, ...ids]) : ids
    this.selectedNoteId = this.selectedNoteIds.at(-1) ?? null
    this.emit()
  }

  openStems(trackId: string, clipId: string) {
    this.selectedTrackId = trackId
    this.selectedClipId = clipId
    this.stemTrackId = trackId
    this.stemClipId = clipId
    this.emit()
  }

  closeStems() {
    this.stemClipId = null
    this.stemTrackId = null
    this.stemStatus = null
    this.stemPaused = false
    this.emit()
  }

  setStemStatus(status: ProjectStore['stemStatus']) {
    this.stemStatus = status
    this.emit()
  }

  setStemPaused(paused: boolean) {
    this.stemPaused = paused
    this.emit()
  }

  closeClipSheet() {
    this.clipSheet = false
    this.emit()
  }

  selectNote(id: string | null, additive = false) {
    if (!id) {
      this.selectedNoteId = null
      this.selectedNoteIds = []
    } else if (additive) {
      const has = this.selectedNoteIds.includes(id)
      this.selectedNoteIds = has ? this.selectedNoteIds.filter((note) => note !== id) : [...this.selectedNoteIds, id]
      this.selectedNoteId = this.selectedNoteIds.at(-1) ?? null
    } else {
      this.selectedNoteId = id
      this.selectedNoteIds = [id]
    }
    this.emit()
  }

  scaleState() {
    return normalizeScale(this.project.scale)
  }

  setScale(patch: Partial<ScaleState>) {
    this.mutate(() => {
      const next = normalizeScale({ ...this.scaleState(), ...patch })
      const turningOn = !this.scaleState().snap && next.snap
      this.project.scale = next
      if (turningOn) this.quantizeSelected()
    })
  }

  private quantizeSelected() {
    const scale = this.scaleState()
    if (!this.selectedNoteIds.length || !this.selectedMidiClipId) return
    for (const track of this.project.tracks) {
      const clip = track.midiClips.find((item) => item.id === this.selectedMidiClipId)
      if (!clip) continue
      for (const note of clip.notes) {
        if (this.selectedNoteIds.includes(note.id)) note.pitch = snapPitch(note.pitch, scale.root, scale.scale)
      }
    }
  }

  renameProject(name: string) {
    this.mutate(() => {
      this.project.name = name
    })
  }

  /** Active arrangement tool. Shared with the piano roll through `src/state/tools.ts`. */
  get tool(): ArrangeTool {
    return activeTool()
  }

  setTool(tool: ArrangeTool | 'pointer' | 'stretch') {
    const next: ArrangeTool = tool === 'pointer' ? 'select' : tool === 'stretch' ? 'trim' : tool
    setActiveTool(next)
    this.emit()
  }

  setTempo(tempo: number, group = false) {
    const value = clamp(Math.round(tempo * 10) / 10, 30, 300)
    if (group && this.tempoGroup) {
      if (this.remoteFollow || this.project.tempo === value) return
      this.project.tempo = value
      this.retimeFollow()
      this.emit()
      return
    }
    this.mutate(() => {
      this.project.tempo = value
      this.retimeFollow()
    })
    this.tempoGroup = group
  }

  endTempoGroup() {
    this.tempoGroup = false
  }

  private retimeFollow() {
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        if (!clip.stretch?.followTempo) continue
        clip.durationSamples = timelineSamples(clip, this.project)
      }
    }
  }

  setTimeSignature(numerator: number, denominator: number) {
    this.mutate(() => {
      this.project.timeSignature = { numerator, denominator }
    })
  }

  setLoop(enabled: boolean, start?: number, end?: number) {
    this.mutate(() => {
      this.project.loopEnabled = enabled
      if (start != null) this.project.loopStartSample = Math.max(0, Math.round(start))
      if (end != null) this.project.loopEndSample = Math.max(this.project.loopStartSample + 1, Math.round(end))
    })
  }

  toggle(flag: 'metronomeEnabled' | 'countIn' | 'snap' | 'loopEnabled') {
    this.mutate(() => {
      this.project[flag] = !this.project[flag]
    })
  }

  setMasterVolume(volume: number) {
    this.mutate(() => {
      this.project.masterVolume = clamp(volume, 0, 1.25)
    })
  }

  addTracks(spec: AddTrackSpec) {
    const ids: string[] = []
    this.mutate(() => {
      const made = tracksFor(spec, this.project.tracks)
      for (const track of made) if (track.type === 'midi') normalizeTrackRack(track)
      if (spec.kind === 'midi' && spec.instrument === 'library' && made[0]) this.rackTrackId = made[0].id
      const at = insertIndex(this.project.tracks, this.selectedTrackId)
      this.project.tracks.splice(at, 0, ...made)
      this.selectedTrackId = made[0]?.id ?? this.selectedTrackId
      ids.push(...made.map((track) => track.id))
    })
    return ids
  }

  /** Install a multi-sample program on a library instrument track. */
  setLibrary(trackId: string, program: SamplerProgram | null) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      track.instrument = 'library'
      track.library = program ?? undefined
      if (!track.rack?.devices?.length) normalizeTrackRack(track)
    })
  }

  /** Same as setLibrary, and keep imported wavs in the project so they save. */
  adoptLibrary(trackId: string, program: SamplerProgram, assets: { id: string; name: string; sampleRate: number; channels: Float32Array[] }[]) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      track.instrument = 'library'
      track.library = program
      for (const asset of assets) this.buffers.set(asset.id, asset)
      if (!track.rack?.devices?.length) normalizeTrackRack(track)
    })
  }

  setLibraryMic(trackId: string, micId: string, gain: number, mute?: boolean) {
    this.mutate(() => {
      const mic = this.track(trackId)?.library?.mics.find((item) => item.id === micId)
      if (!mic) return
      mic.gain = Math.max(0, Math.min(1, gain))
      if (mute != null) mic.mute = mute
    })
  }

  addTrack(type: Track['type']) {
    if (type === 'group') {
      this.mutate(() => {
        const index = this.project.tracks.length
        const track = makeTrack({
          name: `Group ${index + 1}`,
          type,
          color: TRACK_COLORS[index % TRACK_COLORS.length],
        })
        this.project.tracks.splice(insertIndex(this.project.tracks, this.selectedTrackId), 0, track)
        this.selectedTrackId = track.id
      })
      return
    }
    this.addTracks({
      kind: type === 'audio' ? 'audio' : type === 'bus' ? 'bus' : 'midi',
      count: 1,
      instrument: 'none',
      input: 'mic',
      channels: 1,
      armed: false,
    })
  }

  /** Open a MIDI track in the piano. An empty track gets a 4-bar clip at the playhead. */
  preparePianoClip(trackId: string, beat: number, clipId?: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const bar = Math.max(1, quartersPerBar(this.project.timeSignature))
      const start = Math.max(0, Math.floor(Math.max(0, beat) / bar) * bar)
      let clip = clipId ? track.midiClips.find((item) => item.id === clipId) : undefined
      if (!clip && track.midiClips.length) {
        clip = track.midiClips.find((item) => beat >= item.startBeat && beat < item.startBeat + item.durationBeats) ?? track.midiClips[0]
      }
      if (!clip) {
        clip = { id: uid('midi'), name: 'Keys', startBeat: start, durationBeats: bar * 4, notes: [] }
        track.midiClips.push(clip)
      }
      this.selectedTrackId = trackId
      this.selectedMidiClipId = clip.id
      this.selectedClipId = null
      this.selectedNoteId = null
      this.selectedNoteIds = []
    })
  }

  removeTrack(id: string) {
    this.mutate(() => {
      this.project.tracks = this.project.tracks.filter((t) => t.id !== id)
      if (this.selectedTrackId === id) this.selectedTrackId = this.project.tracks[0]?.id ?? null
    })
  }

  updateTrack(id: string, patch: Partial<Track>) {
    if ((patch.output !== undefined || patch.groupId !== undefined) && this.routeLoops(id, patch)) return
    this.mutate(() => {
      const track = this.track(id)
      if (!track) return
      Object.assign(track, patch)
    })
  }

  focusPlugin(trackId: string | null, pluginId: string | null = null) {
    this.pluginFocus = trackId && pluginId ? { trackId, pluginId } : null
    this.emit()
  }

  replaceMasterChain(plugins: PluginInstance[]) {
    this.mutate(() => {
      const mastering = new Set<string>(MASTERING_IDS)
      const meter = this.project.masterPlugins.find((plugin) => plugin.pluginId === 'meter') ?? createPlugin('meter')
      const kept = this.project.masterPlugins.filter((plugin) => plugin.pluginId !== 'meter' && !mastering.has(plugin.pluginId))
      this.project.masterPlugins = [...plugins, ...kept, meter]
    })
  }

  /** Bypass the mastering chain so a loudness-matched dry signal can be compared. */
  setMasterBypass(on: boolean) {
    this.mutate(() => {
      const mastering = new Set<string>(MASTERING_IDS)
      if (on) {
        this.bypassed = this.project.masterPlugins.map((plugin) => ({ id: plugin.id, enabled: plugin.enabled }))
        for (const plugin of this.project.masterPlugins) {
          if (mastering.has(plugin.pluginId) || plugin.pluginId === 'limiter') plugin.enabled = false
        }
      } else if (this.bypassed) {
        for (const snap of this.bypassed) {
          const plugin = this.project.masterPlugins.find((item) => item.id === snap.id)
          if (plugin) plugin.enabled = snap.enabled
        }
        this.bypassed = null
      }
    })
  }

  addPlugin(trackId: string | 'master', pluginId: string, preset?: string) {
    this.mutate(() => {
      const list = this.pluginList(trackId)
      if (!list) return
      list.push(createPlugin(pluginId, preset))
    })
  }

  updatePlugin(trackId: string | 'master', pluginId: string, patch: Partial<PluginInstance>) {
    this.mutate(() => {
      const plugin = this.pluginList(trackId)?.find((item) => item.id === pluginId)
      if (!plugin) return
      if (patch.enabled != null) plugin.enabled = patch.enabled
      if (patch.wet != null) plugin.wet = Math.min(1, Math.max(0, patch.wet))
      if (patch.sidechain != null) plugin.sidechain = patch.sidechain
      if (patch.params) plugin.params = { ...plugin.params, ...patch.params }
      if (patch.sampler) plugin.sampler = patch.sampler
      if (patch.looper) plugin.looper = patch.looper
    })
  }

  setSampleBuffer(trackId: string | 'master', pluginId: string, bufferId: string) {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      if (!plugin?.sampler) return
      plugin.sampler.bufferId = bufferId
      const channel = this.buffers.get(bufferId)?.channels[0]
      if (channel) plugin.sampler.root = detectRoot(channel, this.buffers.get(bufferId)?.sampleRate || this.project.sampleRate)
    })
  }

  editSample(trackId: string | 'master', pluginId: string, op: 'norm' | 'reverse' | 'trim' | 'fade' | 'snap') {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      const sampler = plugin?.sampler
      if (!plugin || !sampler?.bufferId) return
      const asset = this.buffers.get(sampler.bufferId)
      const channel = asset?.channels[0]
      if (!asset || !channel) return
      const rate = asset.sampleRate
      let next = channel
      if (op === 'norm') next = normalizeChannel(channel)
      else if (op === 'reverse') next = reverseChannel(channel)
      else if (op === 'trim') next = trimSilence(channel)
      else if (op === 'fade') next = fadeChannel(channel, Math.round(sampler.fadeIn * channel.length), Math.round((sampler.fadeOut || 0.01) * channel.length))
      else {
        const start = snapZero(channel, Math.round(sampler.start * channel.length))
        const end = snapZero(channel, Math.round(sampler.end * channel.length))
        sampler.start = start / channel.length
        sampler.end = Math.max(sampler.start + 2 / channel.length, end / channel.length)
        sampler.loopStart = snapZero(channel, Math.round(sampler.loopStart * channel.length)) / channel.length
        sampler.loopEnd = snapZero(channel, Math.round(sampler.loopEnd * channel.length)) / channel.length
        return
      }
      const id = uid('smp')
      this.buffers.set(id, { id, name: asset.name, sampleRate: rate, channels: [next] })
      sampler.bufferId = id
      sampler.slices = []
    })
  }

  chopSample(trackId: string | 'master', pluginId: string, mode: 'transient' | 'grid' | 'beat') {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      const sampler = plugin?.sampler
      if (!plugin || !sampler?.bufferId) return
      const asset = this.buffers.get(sampler.bufferId)
      const channel = asset?.channels[0]
      if (!channel) return
      const rate = asset?.sampleRate || this.project.sampleRate
      const spanStart = Math.floor(sampler.start * channel.length)
      const spanEnd = Math.max(spanStart + 2, Math.floor(sampler.end * channel.length))
      const region = channel.subarray(spanStart, Math.min(channel.length, spanEnd))
      const cuts = mode === 'transient'
        ? sliceTransients(region, rate, plugin.params.sensitivity ?? 0.45)
        : mode === 'beat'
          ? sliceBeats(region.length, rate, this.project.tempo, 1)
          : sliceEven(region.length, 16)
      sampler.slices = cuts.slice(0, 16).map((cut, index) => makeZone(uid('zn'), sampler.bufferId, spanStart + cut.start, spanStart + cut.end, channel.length, index))
    })
  }

  exportSlices(trackId: string | 'master', pluginId: string) {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      const count = plugin?.sampler?.slices.length ?? 0
      if (!count) return
      const notes = slicesToNotes(count).map((note) => ({ ...note, id: uid('note') }))
      const host = this.project.tracks.find((track) => track.type === 'midi') ?? (trackId === 'master' ? null : this.track(trackId))
      if (!host) return
      host.midiClips.push({
        id: uid('midi'),
        name: 'Slices',
        startBeat: 0,
        durationBeats: Math.max(1, notes.length * 0.25),
        notes,
      })
    })
  }

  armLooper(trackId: string | 'master', pluginId: string, transport: number, beat: number) {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      if (!plugin) return
      const looper = plugin.looper ?? emptyLooper()
      const beats = this.project.timeSignature.numerator
      looper.transport = transport
      looper.startBeat = transport >= 2 ? nextBar(beat, beats) : looper.startBeat
      if (looper.sync) looper.lengthSamples = syncedLoopSamples(looper.bars, this.project.tempo, this.project.sampleRate, beats)
      plugin.looper = looper
      plugin.params = { ...plugin.params, transport }
    })
  }

  addLooperLayer(trackId: string | 'master', pluginId: string, channel: Float32Array) {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      if (!plugin) return
      const looper = plugin.looper ?? emptyLooper()
      const id = uid('loop')
      this.buffers.set(id, { id, name: 'Loop', sampleRate: this.project.sampleRate, channels: [Float32Array.from(channel)] })
      looper.layers = [...looper.layers, { id: uid('lyr'), bufferId: id, gain: 1, mute: false, reverse: false, speed: plugin.params.speed || 1 }]
      looper.undone = []
      looper.lengthSamples = channel.length
      if (!looper.sync) this.project.tempo = Math.round(tempoFromLoop(channel.length, this.project.sampleRate, this.project.timeSignature.numerator) * 10) / 10
      plugin.looper = looper
    })
  }

  undoLooper(trackId: string | 'master', pluginId: string) {
    this.mutate(() => {
      const looper = this.instrument(trackId, pluginId)?.looper
      if (!looper?.layers.length) return
      const last = looper.layers[looper.layers.length - 1]
      looper.layers = looper.layers.slice(0, -1)
      looper.undone = [...looper.undone, last]
    })
  }

  redoLooper(trackId: string | 'master', pluginId: string) {
    this.mutate(() => {
      const looper = this.instrument(trackId, pluginId)?.looper
      if (!looper?.undone.length) return
      const last = looper.undone[looper.undone.length - 1]
      looper.undone = looper.undone.slice(0, -1)
      looper.layers = [...looper.layers, last]
    })
  }

  clearLooper(trackId: string | 'master', pluginId: string) {
    this.mutate(() => {
      const looper = this.instrument(trackId, pluginId)?.looper
      if (!looper) return
      looper.undone = [...looper.undone, ...looper.layers]
      looper.layers = []
      looper.lengthSamples = 0
      looper.transport = 0
    })
  }

  bounceLooper(trackId: string, pluginId: string, startSample: number) {
    this.mutate(() => {
      const plugin = this.instrument(trackId, pluginId)
      const looper = plugin?.looper
      const track = this.track(trackId)
      if (!looper || !track) return
      const takes: LoopTake[] = []
      for (const layer of looper.layers) {
        const samples = this.buffers.get(layer.bufferId)?.channels[0]
        if (samples) takes.push({ samples, gain: layer.gain, mute: layer.mute, reverse: layer.reverse, speed: layer.speed || 1 })
      }
      const length = looper.lengthSamples || takes[0]?.samples.length || 0
      if (!length) return
      const mixed = mixTakes({ length, takes, undone: [], feedback: looper.feedback })
      const id = uid('bounce')
      this.buffers.set(id, { id, name: 'Loop bounce', sampleRate: this.project.sampleRate, channels: [mixed] })
      track.clips.push({
        id: uid('clip'),
        name: 'Loop',
        bufferId: id,
        startSample,
        offsetSamples: 0,
        durationSamples: mixed.length,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 1,
        source: 'local',
      })
    })
  }

  removePlugin(trackId: string | 'master', pluginId: string) {
    this.mutate(() => {
      const list = this.pluginList(trackId)
      if (!list) return
      const index = list.findIndex((item) => item.id === pluginId)
      if (index >= 0) list.splice(index, 1)
      if (this.pluginFocus?.pluginId === pluginId) this.pluginFocus = null
    })
  }

  movePlugin(trackId: string | 'master', pluginId: string, direction: -1 | 1) {
    this.mutate(() => {
      const list = this.pluginList(trackId)
      if (!list) return
      const index = list.findIndex((item) => item.id === pluginId)
      const next = index + direction
      if (index < 0 || next < 0 || next >= list.length) return
      const [item] = list.splice(index, 1)
      list.splice(next, 0, item)
    })
  }

  addSend(trackId: string, busId: string, preFader = false) {
    const existing = this.track(trackId)
    const sends = [...(existing?.sends ?? []), { id: 'new', busId, gain: 0.25, preFader, enabled: true }]
    if (this.routeLoops(trackId, { sends })) return
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.sends.some((send) => send.busId === busId)) return
      track.sends.push({ id: uid('send'), busId, gain: 0.25, preFader, enabled: true })
    })
  }

  updateSend(trackId: string, sendId: string, patch: Partial<{ gain: number; preFader: boolean; enabled: boolean }>) {
    this.mutate(() => {
      const send = this.track(trackId)?.sends.find((item) => item.id === sendId)
      if (!send) return
      Object.assign(send, patch)
    })
  }

  removeSend(trackId: string, sendId: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (track) track.sends = track.sends.filter((send) => send.id !== sendId)
    })
  }

  applyPluginPreset(trackId: string | 'master', pluginId: string, name: string) {
    this.mutate(() => {
      const plugin = this.pluginList(trackId)?.find((item) => item.id === pluginId)
      if (!plugin) return
      const params = presetParams(plugin.pluginId, name, this.project.presets)
      if (params) plugin.params = params
    })
  }

  savePluginPreset(pluginId: string, name: string, params: Record<string, number>) {
    this.mutate(() => {
      const existing = this.project.presets.find((item) => item.pluginId === pluginId && item.name === name)
      if (existing) existing.params = { ...params }
      else this.project.presets.push({ id: uid('preset'), pluginId, name, params: { ...params } })
    })
  }

  addAutomationPoint(pluginId: string, param: string, beat: number, value: number) {
    this.mutate(() => {
      let lane = this.project.automation.find((item) => item.pluginId === pluginId && item.param === param)
      if (!lane) {
        lane = { id: uid('auto'), pluginId, param, points: [] }
        this.project.automation.push(lane)
      }
      const point = lane.points.find((item) => Math.abs(item.beat - beat) < 0.01)
      if (point) point.value = value
      else lane.points.push({ beat, value })
    })
  }

  addVocalChain(trackId: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      for (const [pluginId, preset] of [
        ['gate', 'Vocal'],
        ['eq', 'Vocal'],
        ['deesser', 'Vocal'],
        ['compressor', 'Vocal'],
        ['tune', 'Alto/Tenor'],
        ['saturator', 'Tape'],
      ] as const) {
        track.plugins.push(createPlugin(pluginId, preset))
      }
      const delay = this.ensureBus('Delay', 'delay', 'Ping-pong')
      const reverb = this.ensureBus('Reverb', 'reverb', 'Hall')
      if (!track.sends.some((send) => send.busId === delay.id)) {
        track.sends.push({ id: uid('send'), busId: delay.id, gain: 0.22, preFader: false, enabled: true })
      }
      if (!track.sends.some((send) => send.busId === reverb.id)) {
        track.sends.push({ id: uid('send'), busId: reverb.id, gain: 0.18, preFader: false, enabled: true })
      }
    })
  }

  private ensureBus(name: string, pluginId: string, preset: string) {
    const existing = this.project.tracks.find((track) => (track.type === 'bus' || track.type === 'group') && track.name === name)
    if (existing) return existing
    const track = makeTrack({
      name,
      type: 'bus',
      color: TRACK_COLORS[this.project.tracks.length % TRACK_COLORS.length],
      input: 'none',
    })
    const plugin = createPlugin(pluginId, preset)
    plugin.params.mix = 1
    track.plugins.push(plugin)
    this.project.tracks.push(track)
    return track
  }

  private pluginList(trackId: string | 'master') {
    if (trackId === 'master') return this.project.masterPlugins
    return this.track(trackId)?.plugins
  }

  private instrument(trackId: string | 'master', pluginId: string) {
    const plugin = this.pluginList(trackId)?.find((item) => item.id === pluginId)
    if (!plugin) return null
    if (plugin.pluginId === 'sampler') plugin.sampler = plugin.sampler ?? emptySampler()
    if (plugin.pluginId === 'looper') plugin.looper = plugin.looper ?? emptyLooper()
    return plugin
  }

  private routeLoops(trackId: string, patch: Partial<Track>) {
    const points = this.project.tracks.map((track) => {
      const next = track.id === trackId ? { ...track, ...patch, sends: patch.sends ?? track.sends } : track
      return {
        id: next.id,
        dest: next.groupId || next.output || MASTER,
        sends: (next.sends ?? []).filter((send) => send.enabled).map((send) => send.busId),
        latency: 0,
      }
    })
    return findCycle(points) != null
  }

  addInsert(trackId: string | 'master', type: InsertType) {
    this.mutate(() => {
      const list = trackId === 'master' ? this.project.masterInserts : this.track(trackId)?.inserts
      if (!list || list.length >= 4) return
      list.push(defaultInsert(type))
    })
  }

  updateInsert(trackId: string | 'master', insertId: string, patch: { enabled?: boolean; params?: Record<string, number> }) {
    this.mutate(() => {
      const list = trackId === 'master' ? this.project.masterInserts : this.track(trackId)?.inserts
      const insert = list?.find((i) => i.id === insertId)
      if (!insert) return
      if (patch.enabled != null) insert.enabled = patch.enabled
      if (patch.params) insert.params = { ...insert.params, ...patch.params }
    })
  }

  removeInsert(trackId: string | 'master', insertId: string) {
    this.mutate(() => {
      if (trackId === 'master') {
        this.project.masterInserts = this.project.masterInserts.filter((i) => i.id !== insertId)
      } else {
        const track = this.track(trackId)
        if (track) track.inserts = track.inserts.filter((i) => i.id !== insertId)
      }
    })
  }

  addAsset(asset: AudioAsset) {
    this.buffers.set(asset.id, asset)
    this.emit()
  }

  addAudioClip(trackId: string, clip: AudioClip) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'audio') return
      track.clips.push(clip)
      this.selectedTrackId = trackId
      this.selectedClipId = clip.id
    })
  }

  updateAudioClip(trackId: string, clipId: string, clip: AudioClip) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const index = track.clips.findIndex((c) => c.id === clipId)
      if (index >= 0) track.clips[index] = clip
    })
  }

  deleteSelectedClip() {
    this.mutate(() => {
      const audio = new Set(this.selectedClipIds.length ? this.selectedClipIds : this.selectedClipId ? [this.selectedClipId] : [])
      if (audio.size) {
        for (const track of this.project.tracks) track.clips = track.clips.filter((clip) => !audio.has(clip.id))
        this.selectedClipId = null
        this.selectedClipIds = []
        return
      }
      if (this.selectedNoteIds.length && this.selectedMidiClipId) {
        const notes = new Set(this.selectedNoteIds)
        for (const track of this.project.tracks) {
          const clip = track.midiClips.find((item) => item.id === this.selectedMidiClipId)
          if (clip) clip.notes = clip.notes.filter((note) => !notes.has(note.id))
        }
        this.selectedNoteId = null
        this.selectedNoteIds = []
        return
      }
      const midi = new Set(this.selectedMidiClipIds.length ? this.selectedMidiClipIds : this.selectedMidiClipId ? [this.selectedMidiClipId] : [])
      if (!midi.size) return
      for (const track of this.project.tracks) track.midiClips = track.midiClips.filter((clip) => !midi.has(clip.id))
      this.selectedMidiClipId = null
      this.selectedMidiClipIds = []
    })
  }

  splitSelected(atSample: number) {
    if (!this.selectedClipId) return
    this.mutate(() => {
      for (const track of this.project.tracks) {
        const index = track.clips.findIndex((c) => c.id === this.selectedClipId)
        if (index < 0) continue
        const parts = splitAudioClip(track.clips[index], atSample)
        if (!parts) return
        track.clips.splice(index, 1, parts[0], parts[1])
        this.selectedClipId = parts[1].id
      }
    })
  }

  moveClip(trackId: string, clipId: string, startSample: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track?.clips.find((c) => c.id === clipId)
      if (clip) Object.assign(clip, moveAudioClip(clip, startSample))
    })
  }

  stretchClip(trackId: string, clipId: string, edge: 'start' | 'end', sample: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      Object.assign(clip, stretchEdge(clip, edge, sample))
      this.commitClip(clip)
    })
  }

  setClipStretch(trackId: string, clipId: string, patch: Partial<ClipStretch>) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const base = clip.stretch ?? defaultStretch(clip.durationSamples)
      clip.stretch = { ...base, ...patch, markers: patch.markers ?? base.markers }
      if (clip.stretch.followTempo) {
        if (!clip.stretch.sourceBpm) clip.stretch.sourceBpm = this.detectClipBpm(clip)
        clip.durationSamples = timelineSamples(clip, this.project)
      }
      this.commitClip(clip)
    })
  }

  setStretchRatio(trackId: string, clipId: string, percent: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const base = clip.stretch ?? defaultStretch(clip.durationSamples)
      const source = Math.max(1, base.sourceSamples || clip.durationSamples)
      const duration = Math.max(64, Math.round(source * (clamp(percent, 12.5, 800) / 100)))
      const scale = clip.durationSamples > 0 ? duration / clip.durationSamples : 1
      clip.durationSamples = duration
      clip.stretch = {
        ...base,
        sourceSamples: source,
        followTempo: false,
        markers: base.markers.map((marker) => ({ ...marker, target: marker.target * scale })),
      }
      this.commitClip(clip)
    })
  }

  addWarpMarker(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const base = clip.stretch ?? defaultStretch(clip.durationSamples)
      const source = Math.round(sourceSamplesOf(clip) / 2)
      const beats = (source / Math.max(1, base.sourceSamples)) * (clip.durationSamples / this.project.sampleRate) * (this.project.tempo / 60)
      clip.stretch = { ...base, markers: [...base.markers, { id: uid('warp'), source, target: beats }] }
      this.commitClip(clip)
    })
  }

  moveWarpMarker(trackId: string, clipId: string, markerId: string, patch: { source?: number; target?: number }) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      const stretch = clip?.stretch
      if (!clip || !stretch) return
      stretch.markers = stretch.markers.map((marker) => (marker.id === markerId ? { ...marker, ...patch } : marker))
      this.commitClip(clip)
    })
  }

  removeWarpMarker(trackId: string, clipId: string, markerId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip?.stretch) return
      clip.stretch.markers = clip.stretch.markers.filter((marker) => marker.id !== markerId)
      this.commitClip(clip)
    })
  }

  autoWarpMarkers(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const asset = this.buffers.get(clip.bufferId)
      const channel = asset?.channels[0]
      if (!channel) return
      const source = sourceSamplesOf(clip)
      const found = inspectClip(channel.subarray(clip.offsetSamples, clip.offsetSamples + source), asset?.sampleRate ?? this.project.sampleRate, this.project.tempo)
      const base = clip.stretch ?? defaultStretch(source)
      clip.stretch = { ...base, sourceSamples: source, sourceBpm: found.sourceBpm, markers: found.markers }
      this.commitClip(clip)
    })
  }

  /** Start the offline render as soon as the edit lands. Playback can use the preview until it finishes. */
  private commitClip(clip: AudioClip) {
    const asset = this.buffers.get(clip.bufferId)
    if (!asset?.channels.length || !clip.stretch) return
    const source = sourceSamplesOf(clip)
    const sliced = asset.channels.map((channel) => Float32Array.from(channel.subarray(clip.offsetSamples, Math.min(channel.length, clip.offsetSamples + source))))
    const frozen: AudioClip = {
      ...clip,
      stretch: { ...clip.stretch, markers: clip.stretch.markers.map((marker) => ({ ...marker })) },
    }
    const project = this.project
    const key = stretchCacheKey(frozen, project)
    scheduleStretchCommit(
      key,
      () => renderClipChannels(sliced, frozen, project, 'hq'),
      () => renderClipChannels(sliced, frozen, project, 'preview'),
    )
  }

  private detectClipBpm(clip: AudioClip) {
    const asset = this.buffers.get(clip.bufferId)
    const channel = asset?.channels[0]
    if (!channel) return clip.stretch?.sourceBpm ?? null
    const source = sourceSamplesOf(clip)
    return inspectClip(channel.subarray(clip.offsetSamples, clip.offsetSamples + source), asset?.sampleRate ?? this.project.sampleRate, this.project.tempo).sourceBpm
  }

  trimClip(trackId: string, clipId: string, edge: 'start' | 'end', sample: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track?.clips.find((c) => c.id === clipId)
      if (!clip) return
      const asset = this.buffers.get(clip.bufferId)
      const length = asset?.channels[0].length ?? clip.offsetSamples + clip.durationSamples
      const next = trimAudioClip(clip, edge, sample, length)
      Object.assign(clip, next)
    })
  }

  placeAudioClips(moves: { trackId: string; clipId: string; startSample: number }[]) {
    this.mutate(() => {
      for (const move of moves) {
        const clip = this.track(move.trackId)?.clips.find((item) => item.id === move.clipId)
        if (!clip) continue
        const start = snapSample(move.startSample, this.project.sampleRate, this.project.tempo, this.project.snap)
        Object.assign(clip, moveAudioClip(clip, start))
      }
    })
  }

  placeMidiClips(moves: { trackId: string; clipId: string; startBeat: number }[]) {
    this.mutate(() => {
      for (const move of moves) {
        const clip = this.track(move.trackId)?.midiClips.find((item) => item.id === move.clipId)
        if (!clip) continue
        clip.startBeat = this.project.snap ? Math.max(0, Math.round(move.startBeat)) : Math.max(0, move.startBeat)
      }
    })
  }

  placeNotes(trackId: string, clipId: string, moves: { id: string; startBeat: number; pitch: number; durationBeats: number }[]) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const grid = this.project.roll?.grid || 0.25
      for (const move of moves) {
        const note = clip.notes.find((item) => item.id === move.id)
        if (!note) continue
        const beat = this.project.snap && grid > 0 ? Math.max(0, Math.round(move.startBeat / grid) * grid) : Math.max(0, move.startBeat)
        Object.assign(note, moveMidiNote(note, beat, move.pitch))
        Object.assign(note, resizeMidiNote(note, move.durationBeats))
      }
    })
  }

  resizeMidiClip(trackId: string, clipId: string, edge: 'start' | 'end', beat: number, stretch = false) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const next = stretch ? stretchMidiClip(clip, edge, beat) : trimMidiClip(clip, edge, beat)
      clip.startBeat = next.startBeat
      clip.durationBeats = next.durationBeats
      clip.notes = next.notes
    })
  }

  splitAt(trackId: string, clipId: string, atSample: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const index = track.clips.findIndex((clip) => clip.id === clipId)
      if (index >= 0) {
        const parts = splitAudioClip(track.clips[index], atSample)
        if (!parts) return
        track.clips.splice(index, 1, parts[0], parts[1])
        this.selectedClipId = parts[1].id
        this.selectedClipIds = [parts[1].id]
        return
      }
      const midiIndex = track.midiClips.findIndex((clip) => clip.id === clipId)
      if (midiIndex < 0) return
      const beat = samplesToBeats(atSample, this.project.sampleRate, this.project.tempo)
      const parts = splitMidiClip(track.midiClips[midiIndex], beat)
      if (!parts) return
      track.midiClips.splice(midiIndex, 1, parts[0], parts[1])
      this.selectedMidiClipId = parts[1].id
      this.selectedMidiClipIds = [parts[1].id]
    })
  }

  drawRegion(trackId: string, startSample: number, endSample: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const rate = this.project.sampleRate
      const tempo = this.project.tempo
      const a = snapSample(Math.min(startSample, endSample), rate, tempo, this.project.snap)
      let b = snapSample(Math.max(startSample, endSample), rate, tempo, this.project.snap)
      const quarter = beatsToSamples(1, rate, tempo)
      if (b - a < quarter / 4) b = a + quarter
      this.selectedTrackId = trackId
      if (track.type === 'midi') {
        const clip: MidiClip = {
          id: uid('midi'),
          name: 'MIDI',
          startBeat: samplesToBeats(a, rate, tempo),
          durationBeats: Math.max(0.25, samplesToBeats(b - a, rate, tempo)),
          notes: [],
        }
        track.midiClips.push(clip)
        this.selectedMidiClipId = clip.id
        this.selectedMidiClipIds = [clip.id]
        this.selectedClipId = null
        this.selectedClipIds = []
        return
      }
      if (track.type !== 'audio') return
      const duration = Math.max(1, Math.round(b - a))
      const bufferId = uid('buf')
      this.buffers.set(bufferId, { id: bufferId, name: 'Clip', sampleRate: rate, channels: [new Float32Array(duration)] })
      const clip: AudioClip = {
        id: uid('clip'),
        name: 'Clip',
        bufferId,
        startSample: a,
        offsetSamples: 0,
        durationSamples: duration,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 0.8,
        source: 'local',
      }
      track.clips.push(clip)
      this.selectedClipId = clip.id
      this.selectedClipIds = [clip.id]
      this.selectedMidiClipId = null
      this.selectedMidiClipIds = []
    })
  }

  duplicateSelection() {
    this.mutate(() => {
      if (this.selectedNoteIds.length && this.selectedMidiClipId) {
        const ids = new Set(this.selectedNoteIds)
        for (const track of this.project.tracks) {
          const clip = track.midiClips.find((item) => item.id === this.selectedMidiClipId)
          if (!clip) continue
          const copies = clip.notes.filter((note) => ids.has(note.id)).map((note) => ({ ...note, id: uid('note'), startBeat: note.startBeat + 1 }))
          clip.notes.push(...copies)
          this.selectedNoteIds = copies.map((note) => note.id)
          this.selectedNoteId = this.selectedNoteIds.at(-1) ?? null
        }
        return
      }
      const audioIds = new Set(this.selectedClipIds)
      const midiIds = new Set(this.selectedMidiClipIds)
      const nextAudio: string[] = []
      const nextMidi: string[] = []
      for (const track of this.project.tracks) {
        for (const clip of [...track.clips]) {
          if (!audioIds.has(clip.id)) continue
          const copy: AudioClip = {
            ...clip,
            id: uid('clip'),
            name: `${clip.name} copy`,
            startSample: clip.startSample + clip.durationSamples,
            stretch: clip.stretch ? { ...clip.stretch, markers: clip.stretch.markers.map((marker) => ({ ...marker })) } : undefined,
          }
          track.clips.push(copy)
          nextAudio.push(copy.id)
        }
        for (const clip of [...track.midiClips]) {
          if (!midiIds.has(clip.id)) continue
          const copy: MidiClip = {
            ...clip,
            id: uid('midi'),
            name: `${clip.name} copy`,
            startBeat: clip.startBeat + clip.durationBeats,
            notes: clip.notes.map((note) => ({ ...note, id: uid('note') })),
          }
          track.midiClips.push(copy)
          nextMidi.push(copy.id)
        }
      }
      if (nextAudio.length) {
        this.selectedClipIds = nextAudio
        this.selectedClipId = nextAudio.at(-1) ?? null
      }
      if (nextMidi.length) {
        this.selectedMidiClipIds = nextMidi
        this.selectedMidiClipId = nextMidi.at(-1) ?? null
      }
    })
  }

  setFade(trackId: string, clipId: string, edge: 'in' | 'out', samples: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((c) => c.id === clipId)
      if (clip) Object.assign(clip, clampFade(clip, edge, samples))
    })
  }

  addMidiClip(trackId: string, startBeat: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const clip: MidiClip = {
        id: uid('midi'),
        name: 'Keys',
        startBeat,
        durationBeats: 4,
        notes: [],
      }
      track.midiClips.push(clip)
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = trackId
    })
  }

  addPerformedNotes(trackId: string, clipId: string, notes: Omit<MidiNote, 'id'>[], mode: 'overdub' | 'replace' = 'overdub', fixedBeats = 0) {
    if (!notes.length) return
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const fixed = fixedBeats > 0 ? fixedBeats : 0
      const incoming = notes.map((note) => {
        const start = fixed ? ((note.startBeat % fixed) + fixed) % fixed : note.startBeat
        return { ...note, id: uid('note'), startBeat: start, velocity: Math.max(0.05, Math.min(1, note.velocity)) }
      })
      if (mode === 'replace') {
        const start = Math.min(...incoming.map((note) => note.startBeat))
        const end = Math.max(...incoming.map((note) => note.startBeat + note.durationBeats))
        clip.notes = recordTake(clip.notes, incoming, 'replace', start, end)
      } else {
        clip.notes.push(...incoming)
      }
      if (fixed) clip.durationBeats = fixed
      else {
        let end = clip.durationBeats
        for (const note of incoming) end = Math.max(end, note.startBeat + note.durationBeats)
        clip.durationBeats = Math.max(clip.durationBeats, end)
      }
    })
  }

  setClipLength(trackId: string, clipId: string, beats: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      clip.durationBeats = Math.max(0.25, beats)
      clip.notes = clip.notes.filter((note) => note.startBeat < clip.durationBeats)
    })
  }

  toggleDrumStep(trackId: string, clipId: string, pitch: number, step: number, ratchet = 1) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const beat = step / 4
      const existing = clip.notes.filter((note) => note.pitch === pitch && note.startBeat >= beat - 0.02 && note.startBeat < beat + 0.23)
      if (existing.length) {
        const ids = new Set(existing.map((note) => note.id))
        clip.notes = clip.notes.filter((note) => !ids.has(note.id))
        return
      }
      for (const mark of ratchetBeats(beat, 0.25, ratchet)) {
        clip.notes.push({ id: uid('note'), pitch, startBeat: mark, durationBeats: Math.min(0.2, 0.25 / Math.max(1, ratchet)), velocity: 0.9 })
      }
      clip.durationBeats = Math.max(clip.durationBeats, (step + 1) / 4)
    })
  }

  setStep(trackId: string, clipId: string, pitch: number, step: number, patch: Partial<MidiNote> & { lock?: { param: string; value: number } }): void
  setStep(channelId: string, index: number, on: boolean): void
  setStep(
    a: string,
    b: string | number,
    c: number | boolean,
    step?: number,
    patch?: Partial<MidiNote> & { lock?: { param: string; value: number } },
  ) {
    if (typeof b === 'number' && typeof c === 'boolean') {
      const channelId = a
      const index = b
      const on = c
      this.draft(() => {
        const pattern = this.activePattern()
        const channel = pattern?.channels.find((row) => row.id === channelId)
        const cell = channel?.cells[index]
        if (!cell) return
        cell.on = on
      })
      return
    }
    const trackId = a
    const clipId = b as string
    const pitch = c as number
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip || step == null || !patch) return
      const beat = step / 4
      const note = clip.notes.find((item) => item.pitch === pitch && Math.abs(item.startBeat - (item.nudge || 0) - beat) < 0.02)
      if (!note) return
      if (patch.velocity != null) note.velocity = patch.velocity
      if (patch.durationBeats != null) note.durationBeats = patch.durationBeats
      if (patch.probability != null) note.probability = patch.probability
      if (patch.condition != null) note.condition = patch.condition
      if (patch.velocityLo != null) note.velocityLo = patch.velocityLo
      if (patch.velocityHi != null) note.velocityHi = patch.velocityHi
      if (patch.nudge != null) {
        note.nudge = patch.nudge
        note.startBeat = beat + patch.nudge
      }
      if (patch.lock) note.locks = { ...note.locks, [patch.lock.param]: patch.lock.value }
    })
  }

  padProgram(): PadProgram {
    return normalizePadKit(this.project.padKit)
  }

  patchKit(patch: Partial<PadProgram>) {
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      this.project.padKit = normalizePadKit({ ...kit, ...patch, banks: kit.banks })
    })
  }

  updatePad(bank: number, index: number, patch: Partial<PadProgram['banks'][number][number]>) {
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      Object.assign(kit.banks[bank][index], patch)
      this.project.padKit = kit
    })
  }

  applyKit(id: 'room' | 'tight') {
    const preset = kitPreset(id)
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      for (const pad of kit.banks[0]) {
        pad.tune = preset.tune
        pad.decay = preset.decay
        pad.attack = preset.attack
      }
      kit.name = preset.name
      this.project.padKit = kit
    })
  }

  assignResident(bank: number, index: number, pitch: number) {
    const known = DRUM_PADS.find((pad) => pad.pitch === pitch)
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      const pad = kit.banks[bank][index]
      pad.pitch = pitch
      pad.name = known?.name ?? `Pad ${index + 1}`
      pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0 }]
      this.project.padKit = kit
    })
  }

  assignPadSample(bank: number, index: number, samples: Float32Array, sampleRate: number, name: string) {
    const id = uid('smp')
    this.buffers.set(id, { id, name, sampleRate, channels: [samples] })
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      const pad = kit.banks[bank][index]
      pad.name = name
      pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: id }]
      this.project.padKit = kit
    })
  }

  chopPad(bank: number, index: number, mode: 'transient' | 'regions' | 'bpm', asProgram: boolean, opts?: { regions?: number; bpm?: number }) {
    const kit = normalizePadKit(this.project.padKit)
    const pad = kit.banks[bank][index]
    const asset = pad.layers[0]?.bufferId ? this.buffers.get(pad.layers[0].bufferId) : undefined
    const known = DRUM_PADS.find((item) => item.pitch === pad.pitch)
    const samples = asset?.channels[0] ?? renderDrum(known?.kind ?? 'perc', this.project.sampleRate, pad.pitch)
    const sampleRate = asset?.sampleRate ?? this.project.sampleRate
    const pieces = chopsToPads(chopSample(samples, sampleRate, mode, opts), pad.name)
    const targetBank = asProgram ? (bank + 1) % 8 : bank
    this.mutate(() => {
      const next = normalizePadKit(this.project.padKit)
      for (const piece of pieces) {
        const slice = samples.slice(piece.start, piece.end)
        const id = uid('smp')
        this.buffers.set(id, { id, name: piece.name, sampleRate, channels: [slice] })
        const dest = next.banks[targetBank][piece.pad]
        dest.name = piece.name
        dest.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: id }]
      }
      if (asProgram) next.activeBank = targetBank
      this.project.padKit = next
    })
  }

  flattenPad(bank: number, index: number) {
    const kit = normalizePadKit(this.project.padKit)
    const pad = kit.banks[bank][index]
    const asset = pad.layers[0]?.bufferId ? this.buffers.get(pad.layers[0].bufferId) : undefined
    const known = DRUM_PADS.find((item) => item.pitch === pad.pitch)
    const samples = asset?.channels[0] ?? renderDrum(known?.kind ?? 'perc', this.project.sampleRate, pad.pitch)
    const sampleRate = asset?.sampleRate ?? this.project.sampleRate
    const id = uid('smp')
    this.buffers.set(id, { id, name: pad.name, sampleRate, channels: [new Float32Array(samples)] })
    this.mutate(() => {
      const track = makeTrack({
        name: pad.name,
        type: 'audio',
        color: TRACK_COLORS[this.project.tracks.length % TRACK_COLORS.length],
        output: pad.busId || null,
      })
      track.clips.push({
        id: uid('clip'),
        name: pad.name,
        bufferId: id,
        startSample: 0,
        offsetSamples: 0,
        durationSamples: samples.length,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: pad.level,
        source: 'local',
      })
      this.project.tracks.push(track)
      this.selectedTrackId = track.id
      this.selectedClipId = track.clips[0].id
    })
  }

  routePad(bank: number, index: number) {
    this.mutate(() => {
      let bus = this.project.tracks.find((track) => track.type === 'bus')
      if (!bus) {
        bus = makeTrack({ name: 'Pad bus', type: 'bus', color: TRACK_COLORS[4] })
        this.project.tracks.push(bus)
      }
      const kit = normalizePadKit(this.project.padKit)
      kit.banks[bank][index].busId = bus.id
      const midi = this.project.tracks.find((track) => track.type === 'midi')
      if (midi && !midi.sends.some((send) => send.busId === bus!.id)) {
        midi.sends.push({ id: uid('send'), busId: bus.id, gain: kit.banks[bank][index].send || 0.4, preFader: false, enabled: true })
      }
      this.project.padKit = kit
    })
  }

  erasePadNotes(trackId: string, clipId: string, pitch: number, fromBeat: number, toBeat: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      clip.notes = eraseWhilePlaying(clip.notes, pitch, fromBeat, toBeat)
    })
  }

  doubleClip(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const next = doubleLength(clip.notes, clip.durationBeats)
      const half = clip.notes.length
      clip.notes = next.notes.map((note, index) => (index < half ? note : { ...note, id: uid('note') }))
      clip.durationBeats = next.lengthBeats
    })
  }

  armTakeUndo(trackId: string, clipId: string) {
    const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
    if (!clip) return
    this.takeUndo = {
      trackId,
      clipId,
      durationBeats: clip.durationBeats,
      notes: clip.notes.map((note) => ({ ...note, locks: note.locks ? { ...note.locks } : undefined })),
    }
  }

  undoTake() {
    const shot = this.takeUndo
    if (!shot) return
    this.mutate(() => {
      const clip = this.track(shot.trackId)?.midiClips.find((item) => item.id === shot.clipId)
      if (!clip) return
      clip.notes = shot.notes.map((note) => ({ ...note }))
      clip.durationBeats = shot.durationBeats
    })
  }

  rememberSequence(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const kit = normalizePadKit(this.project.padKit)
      const notes: SequenceNote[] = clip.notes.map((note) => ({
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: note.durationBeats,
        velocity: note.velocity,
        probability: note.probability,
        condition: note.condition,
        nudge: note.nudge,
        locks: note.locks ? { ...note.locks } : undefined,
      }))
      const existing = kit.sequences.find((sequence) => sequence.id === clip.id)
      if (existing) {
        existing.notes = notes
        existing.lengthBeats = clip.durationBeats
        existing.name = clip.name
      } else {
        kit.sequences.push({ id: clip.id, name: clip.name, lengthBeats: clip.durationBeats, notes })
      }
      this.project.padKit = kit
    })
  }

  addSongSlot(sequenceId: string, repeats = 1) {
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      kit.song.push({ sequenceId, repeats })
      this.project.padKit = kit
    })
  }

  commitSong(trackId: string) {
    this.mutate(() => {
      const kit = normalizePadKit(this.project.padKit)
      const spans = chainSong(kit.song, kit.sequences.map((sequence) => ({ id: sequence.id, lengthBeats: sequence.lengthBeats })))
      const notes: MidiNote[] = []
      for (const span of spans) {
        const sequence = kit.sequences.find((item) => item.id === span.id)
        if (!sequence) continue
        for (const note of sequence.notes) {
          if (note.startBeat >= sequence.lengthBeats) continue
          notes.push({ ...note, id: uid('note'), startBeat: span.start + note.startBeat })
        }
      }
      const track = this.track(trackId)
      if (!track) return
      let clip = track.midiClips.find((item) => item.name === 'Song')
      if (!clip) {
        clip = { id: uid('midi'), name: 'Song', startBeat: 0, durationBeats: spans.at(-1)?.end ?? 4, notes }
        track.midiClips.push(clip)
      } else {
        clip.notes = notes
        clip.durationBeats = spans.at(-1)?.end ?? clip.durationBeats
      }
      this.selectedMidiClipId = clip.id
      this.project.padKit = kit
    })
  }

  toggleTrack(id: string, flag: 'mute' | 'solo') {
    this.mutate(() => {
      const track = this.track(id)
      if (track) track[flag] = !track[flag]
    })
  }

  addNote(trackId: string, clipId: string, note: Omit<MidiNote, 'id'>) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((c) => c.id === clipId)
      if (!clip) return
      const scale = this.scaleState()
      const pitch = scale.snap ? snapPitch(note.pitch, scale.root, scale.scale) : note.pitch
      const next = this.inputNote(clip, { ...note, pitch, id: uid('note') })
      clip.notes.push(next)
      this.selectedNoteId = next.id
      this.selectedNoteIds = [next.id]
    })
  }

  updateNote(trackId: string, clipId: string, noteId: string, patch: Partial<MidiNote>) {
    this.mutate(() => {
      const note = this.track(trackId)?.midiClips.find((c) => c.id === clipId)?.notes.find((n) => n.id === noteId)
      if (!note) return
      const scale = this.scaleState()
      const pitch = patch.pitch == null ? note.pitch : scale.snap ? snapPitch(patch.pitch, scale.root, scale.scale) : patch.pitch
      if (patch.startBeat != null || patch.pitch != null) {
        Object.assign(note, moveMidiNote(note, patch.startBeat ?? note.startBeat, pitch))
      }
      if (patch.durationBeats != null) Object.assign(note, resizeMidiNote(note, patch.durationBeats))
      if (patch.velocity != null) note.velocity = patch.velocity
      if ('slide' in patch) note.slide = !!patch.slide
    })
  }

  insertPerformance(trackId: string, clipId: string | null, timelineBeat: number, pitches: number[]) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const scale = normalizeScale(this.project.scale)
      const voiced = voiceChord(pitches, {
        inversion: scale.inversion,
        spread: scale.spread,
        drop2: scale.drop2,
        octave: scale.octave,
        voiceLead: scale.voiceLead,
        previous: scale.lastVoicing,
      })
      const performed = patternNotes(voiced, {
        arp: scale.arp,
        rate: scale.rate,
        gate: scale.gate,
        octaves: scale.octaves,
        rhythm: scale.rhythm,
        timing: scale.timing,
        velocity: scale.velocity,
        spanBeats: Math.max(1, this.project.timeSignature.numerator),
      })
      this.writePerformed(track, clipId, Math.max(0, timelineBeat), performed, voiced, scale)
    })
  }

  private writePerformed(track: Track, clipId: string | null, timelineBeat: number, performed: PlayNote[], voiced: number[], scale: ScaleState) {
    let clip = clipId ? track.midiClips.find((item) => item.id === clipId) : undefined
    if (!clip) {
      clip = {
        id: uid('midi'),
        name: 'Chords',
        startBeat: timelineBeat,
        durationBeats: Math.max(1, this.project.timeSignature.numerator),
        notes: [],
      }
      track.midiClips.push(clip)
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = track.id
    }
    const rel = Math.max(0, timelineBeat - clip.startBeat)
    let end = clip.durationBeats
    const ids: string[] = []
    for (const note of performed) {
      const next = this.inputNote(clip, { ...note, id: uid('note'), startBeat: rel + note.startBeat })
      clip.notes.push(next)
      ids.push(next.id)
      end = Math.max(end, next.startBeat + next.durationBeats)
    }
    clip.durationBeats = Math.max(clip.durationBeats, Math.ceil(end * 4) / 4)
    this.selectedNoteIds = ids
    this.selectedNoteId = ids.at(-1) ?? null
    this.project.scale = { ...scale, lastVoicing: voiced }
  }

  /** Drop an idea onto the chord track plus editable bass and drums in that genre. */
  insertIdea(id: string, beat = 0) {
    const progression = progressionById(id)
    if (!progression) return
    const scale = this.scaleState()
    const parts = starterParts(progression, scale.root)
    this.mutate(() => {
      const chords = this.ensureMidi('Chords', '#e0b15a')
      const bass = this.ensureMidi('Bass', '#79b8d4')
      const drums = this.ensureMidi('Drums', '#c58be0')
      const line = romanLine(progression.chords)
      this.replaceClip(chords, beat, parts.chords, line)
      this.replaceClip(bass, beat, parts.bass, `${progression.name} bass`)
      this.replaceClip(drums, beat, parts.drums, `${progression.name} drums`)
      const next = this.scaleState()
      this.project.scale = { ...next, idea: id }
      this.project.tempo = progression.tempo
      this.selectedTrackId = chords.id
    })
  }

  toggleFavorite(id: string) {
    this.mutate(() => {
      const scale = this.scaleState()
      const favorites = scale.favorites.includes(id) ? scale.favorites.filter((item) => item !== id) : [...scale.favorites, id]
      this.project.scale = { ...scale, favorites }
    })
  }

  private ensureMidi(name: string, color: string) {
    const existing = this.project.tracks.find((track) => track.type === 'midi' && track.name === name)
    if (existing) return existing
    const track = makeTrack({ name, type: 'midi', color, input: 'none' })
    this.project.tracks.push(track)
    return track
  }

  private replaceClip(track: Track, beat: number, notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[], name: string) {
    const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 4)
    const clip: MidiClip = {
      id: uid('midi'),
      name,
      startBeat: beat,
      durationBeats: Math.max(4, Math.ceil(end)),
      notes: notes.map((note) => ({ ...note, id: uid('note'), startBeat: note.startBeat })),
    }
    track.midiClips = [clip]
    this.selectedMidiClipId = clip.id
  }

  launch(trackId: string, clipId: string | null, nowSample = 0) {
    if (this.remoteFollow) return
    const track = this.track(trackId)
    const clip = track && clipId ? clipById(track, clipId) : null
    if (clipId && !clip) return
    const mode = clip?.mode ?? 'toggle'
    const same = !!clipId && this.launched[trackId] === clipId
    const busy = !!this.launched[trackId]
    const decision = !clipId ? 'stop' : retrigger(mode, mode === 'toggle' ? same : busy, !!clip?.legato)
    if (decision === 'hold') return
    const quant = clip?.quant ?? this.project.launchQuant ?? '1bar'
    const at = quantizeSample(nowSample, quant, this.project.sampleRate, this.project.tempo, this.project.timeSignature)
    const launched = { ...this.launched }
    const launchAt = { ...this.launchAt }
    const launchGen = { ...this.launchGen }
    if (decision === 'stop') {
      launched[trackId] = null
      delete launchAt[trackId]
    } else if (clipId) {
      launchGen[trackId] = (launchGen[trackId] || 0) + 1
      launched[trackId] = clipId
      launchAt[trackId] = at
      this.captureLog = [...this.captureLog, { trackId, clipId, sample: at }]
    }
    this.launched = launched
    this.launchAt = launchAt
    this.launchGen = launchGen
    this.transportMode = 'session'
    if (track && clip) this.sessionEdit = { trackId, scene: sceneIndex(track, clip.id) }
    this.pendingTransport = {
      action: 'launch',
      trackId,
      clipId: decision === 'stop' ? null : clipId,
      timelineSample: decision === 'stop' ? nowSample : at,
      gen: launchGen,
    }
    this.emit()
  }

  launchScene(scene: number, nowSample = 0) {
    if (this.remoteFollow) return
    const quant = this.project.launchQuant ?? '1bar'
    const at = quantizeSample(nowSample, quant, this.project.sampleRate, this.project.tempo, this.project.timeSignature)
    const launched = { ...this.launched }
    const launchAt = { ...this.launchAt }
    const launchGen = { ...this.launchGen }
    const slots: TransportSlot[] = []
    for (const track of this.project.tracks) {
      const clip = sceneClip(track, scene)
      if (!clip) {
        launched[track.id] = null
        delete launchAt[track.id]
        slots.push({ trackId: track.id, clipId: null })
        continue
      }
      const same = launched[track.id] === clip.id
      const decision = retrigger(clip.mode ?? 'toggle', same, !!clip.legato)
      if (decision === 'hold') {
        slots.push({ trackId: track.id, clipId: launched[track.id] ?? null, timelineSample: launchAt[track.id] })
        continue
      }
      if (decision === 'stop') {
        launched[track.id] = null
        delete launchAt[track.id]
        slots.push({ trackId: track.id, clipId: null })
        continue
      }
      launchGen[track.id] = (launchGen[track.id] || 0) + 1
      launched[track.id] = clip.id
      launchAt[track.id] = at
      this.captureLog = [...this.captureLog, { trackId: track.id, clipId: clip.id, sample: at }]
      slots.push({ trackId: track.id, clipId: clip.id, timelineSample: at })
    }
    this.launched = launched
    this.launchAt = launchAt
    this.launchGen = launchGen
    this.transportMode = 'session'
    this.view = 'session'
    this.pendingTransport = { action: 'scene', scene, timelineSample: at, slots, gen: launchGen }
    this.emit()
  }

  /** Advance follow actions that have reached their boundary. One step per call. */
  tickFollow(nowSample: number) {
    if (this.remoteFollow || this.transportMode !== 'session') return
    const launched = { ...this.launched }
    const launchAt = { ...this.launchAt }
    const launchGen = { ...this.launchGen }
    let changed = false
    for (const [trackId, clipId] of Object.entries(this.launched)) {
      if (!clipId) continue
      const track = this.track(trackId)
      const clip = track ? clipById(track, clipId) : null
      if (!track || !clip || !clip.follow || clip.follow === 'none') continue
      const start = this.launchAt[trackId] ?? 0
      const key = `${trackId}:${clipId}:${start}`
      if (this.followed[key]) continue
      const beats = clip.followBeats ?? quartersPerBar(this.project.timeSignature)
      if (!dueFollow(start, beats, nowSample, this.project.sampleRate, this.project.tempo)) continue
      this.followed = { ...this.followed, [key]: true }
      const scene = sceneIndex(track, clipId)
      const target = followTarget(clip.follow, scene, SESSION_SCENES)
      changed = true
      if (target === 'stop' || target == null) {
        launched[trackId] = null
        delete launchAt[trackId]
        continue
      }
      const next = sceneClip(track, target)
      if (!next) {
        launched[trackId] = null
        delete launchAt[trackId]
        continue
      }
      const boundary = Math.round(start + beatsToSamples(beats, this.project.sampleRate, this.project.tempo))
      launchGen[trackId] = (launchGen[trackId] || 0) + 1
      launched[trackId] = next.id
      launchAt[trackId] = boundary
      this.captureLog = [...this.captureLog, { trackId, clipId: next.id, sample: boundary }]
    }
    if (!changed) return
    this.launched = launched
    this.launchAt = launchAt
    this.launchGen = launchGen
    const slots: TransportSlot[] = this.project.tracks.map((track) => ({
      trackId: track.id,
      clipId: launched[track.id] ?? null,
      timelineSample: launchAt[track.id],
    }))
    this.pendingTransport = { action: 'scene', timelineSample: nowSample, slots, gen: launchGen }
    this.emit()
  }

  stopSession() {
    if (this.remoteFollow) return
    this.launched = {}
    this.launchAt = {}
    this.transportMode = 'session'
    this.pendingTransport = { action: 'stop-clips' }
    this.emit()
  }

  armArrangement() {
    this.launched = {}
    this.launchAt = {}
    this.transportMode = 'arrangement'
    this.pendingTransport = { action: 'back' }
    this.emit()
  }

  replace(project: Project, buffers?: Map<string, AudioAsset>) {
    this.mutate(() => {
      this.project = project
      if (buffers) this.buffers = buffers
    })
  }

  enterSession() {
    if (this.remoteFollow) return
    this.transportMode = 'session'
    this.view = 'session'
    this.emit()
  }

  backToArrangement() {
    if (this.remoteFollow) return
    this.launched = {}
    this.launchAt = {}
    this.transportMode = 'arrangement'
    this.view = 'arrange'
    this.pendingTransport = { action: 'back' }
    this.emit()
  }

  replaceSession(next: SessionClock) {
    this.launched = { ...next.launched }
    this.launchAt = { ...next.at }
    this.launchGen = { ...next.gen }
    this.transportMode = next.mode
    if (next.mode === 'session') this.view = 'session'
    if (next.mode === 'arrangement') this.view = 'arrange'
    this.pendingTransport = null
    this.emit()
  }

  takePendingTransport() {
    const pending = this.pendingTransport
    this.pendingTransport = null
    return pending
  }

  armSlot(trackId: string, scene: number) {
    this.sessionSlot = { trackId, scene }
    this.sessionEdit = { trackId, scene }
    const track = this.track(trackId)
    const clip = track ? sceneClip(track, scene) : null
    this.selectedTrackId = trackId
    if (clip && track?.type === 'midi') {
      this.selectedMidiClipId = clip.id
      this.selectedClipId = null
    } else if (clip) {
      this.selectedClipId = clip.id
      this.selectedMidiClipId = null
    }
    this.emit()
  }

  setLaunchQuant(quant: LaunchQuant) {
    this.mutate(() => {
      this.project.launchQuant = quant
    })
  }

  setRecordBars(bars: number) {
    this.mutate(() => {
      this.project.recordBars = Math.max(0, Math.round(bars))
    })
  }

  setClipLaunch(
    trackId: string,
    clipId: string,
    patch: Partial<{ quant: LaunchQuant; mode: LaunchMode; loop: boolean; legato: boolean; follow: FollowAction; followBeats: number; warp: boolean }>,
  ) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track ? clipById(track, clipId) : null
      if (!clip) return
      Object.assign(clip, patch)
    })
  }

  prepareMidiSlot(trackId: string, scene: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      this.ensureSlots(track, scene)
      const existingId = track.midiSlots?.[scene]
      let clip = existingId ? track.midiClips.find((item) => item.id === existingId) : undefined
      if (!clip) {
        const bars = this.project.recordBars ?? 0
        const beats = bars > 0 ? bars * quartersPerBar(this.project.timeSignature) : 4
        clip = {
          id: uid('midi'),
          name: 'Clip',
          startBeat: 0,
          durationBeats: beats,
          notes: [],
          slotOnly: true,
          loop: true,
        }
        track.midiClips.push(clip)
        track.midiSlots![scene] = clip.id
      }
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = trackId
      this.sessionEdit = { trackId, scene }
    })
  }

  placeInSlot(trackId: string, scene: number, clip: AudioClip) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'audio') return
      this.ensureSlots(track, scene)
      track.clips.push(clip)
      track.audioSlots![scene] = clip.id
      this.selectedClipId = clip.id
      this.selectedTrackId = trackId
      this.sessionSlot = null
    })
  }

  captureToArrangement() {
    if (this.remoteFollow || !this.captureLog.length) return
    const events = this.captureLog
    this.captureLog = []
    this.mutate(() => {
      for (const event of events) {
        const track = this.track(event.trackId)
        if (!track) continue
        const audio = track.clips.find((clip) => clip.id === event.clipId)
        if (audio) {
          track.clips.push({
            ...audio,
            id: uid('clip'),
            name: audio.name,
            startSample: Math.max(0, Math.round(event.sample)),
            slotOnly: false,
          })
        }
        const midi = track.midiClips.find((clip) => clip.id === event.clipId)
        if (midi) {
          track.midiClips.push({
            ...midi,
            id: uid('midi'),
            name: midi.name,
            startBeat: samplesToBeats(event.sample, this.project.sampleRate, this.project.tempo),
            slotOnly: false,
            notes: midi.notes.map((note) => ({ ...note, id: uid('note') })),
          })
        }
      }
    })
  }

  private ensureSlots(track: Track, scene: number) {
    const scenes = Math.max(SESSION_SCENES, scene + 1)
    if (track.type === 'audio') {
      if (!track.audioSlots) track.audioSlots = Array.from({ length: scenes }, (_, index) => track.clips[index]?.id ?? null)
      while (track.audioSlots.length < scenes) track.audioSlots.push(null)
      return
    }
    if (!track.midiSlots) track.midiSlots = Array.from({ length: scenes }, (_, index) => track.midiClips[index]?.id ?? null)
    while (track.midiSlots.length < scenes) track.midiSlots.push(null)
  }

  loadProject(project: Project, buffers: Map<string, AudioAsset>) {
    this.past = []
    this.future = []
    this.project = normalizeProjectRack(normalizeProject(project))
    this.buffers = buffers
    this.selectedTrackId = project.tracks[0]?.id ?? null
    this.selectedClipId = null
    this.selectedMidiClipId = null
    this.selectedNoteId = null
    this.selectedNoteIds = []
    this.emit()
  }

  track(id: string) {
    return this.project.tracks.find((t) => t.id === id)
  }

  retargetSampleRate(rate: number) {
    if (this.project.sampleRate === rate) return
    const ratio = rate / this.project.sampleRate
    for (const asset of this.buffers.values()) {
      asset.channels = asset.channels.map((channel) => linearResample(channel, asset.sampleRate, rate))
      asset.sampleRate = rate
    }
    const scale = (value: number) => Math.max(0, Math.round(value * ratio))
    this.project.sampleRate = rate
    this.project.loopStartSample = scale(this.project.loopStartSample)
    this.project.loopEndSample = Math.max(scale(this.project.loopEndSample), 1)
    for (const track of this.project.tracks) {
      for (const clip of track.clips) {
        clip.startSample = scale(clip.startSample)
        clip.offsetSamples = scale(clip.offsetSamples)
        clip.durationSamples = Math.max(1, scale(clip.durationSamples))
        clip.fadeInSamples = scale(clip.fadeInSamples)
        clip.fadeOutSamples = scale(clip.fadeOutSamples)
        if (clip.stretch) {
          clip.stretch = {
            ...clip.stretch,
            sourceSamples: Math.max(1, scale(clip.stretch.sourceSamples)),
            markers: clip.stretch.markers.map((marker) => ({ ...marker, source: scale(marker.source) })),
          }
        }
      }
    }
    this.emit()
  }

  removeClips(predicate: (clip: AudioClip) => boolean) {
    this.mutate(() => {
      for (const track of this.project.tracks) track.clips = track.clips.filter((clip) => !predicate(clip))
    })
  }

  ensureRemoteTrack(peerId: string, name: string) {
    const input = `remote:${peerId}`
    if (this.project.tracks.some((track) => track.input === input)) return
    this.addTrack('audio')
    const id = this.selectedTrackId
    if (!id) return
    this.updateTrack(id, { name, input, armed: true, monitor: true })
  }

  placeStems(trackId: string, clipId: string, stems: { name: string; color: string; channels: Float32Array[] }[], intoSampler: boolean) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track?.clips.find((item) => item.id === clipId)
      if (!track || !clip) return
      track.mute = true
      const index = this.project.tracks.findIndex((item) => item.id === trackId)
      const created: Track[] = []
      for (const stem of stems) {
        const id = uid('buf')
        this.buffers.set(id, { id, name: stem.name, sampleRate: this.project.sampleRate, channels: stem.channels })
        if (intoSampler) {
          const midi = makeTrack({ name: stem.name, type: 'midi', color: stem.color, input: 'none' })
          const plugin = createPlugin('sampler')
          if (plugin.sampler) {
            plugin.sampler.bufferId = id
            const channel = stem.channels[0]
            if (channel) plugin.sampler.root = detectRoot(channel, this.project.sampleRate)
          }
          midi.plugins = [plugin]
          created.push(midi)
        } else {
          const audio = makeTrack({ name: stem.name, type: 'audio', color: stem.color, input: 'none' })
          audio.clips.push({
            id: uid('clip'),
            name: stem.name,
            bufferId: id,
            startSample: clip.startSample,
            offsetSamples: 0,
            durationSamples: clip.durationSamples,
            fadeInSamples: 0,
            fadeOutSamples: 0,
            gain: clip.gain,
            source: 'local',
          })
          created.push(audio)
        }
      }
      this.project.tracks.splice(Math.max(0, index + 1), 0, ...created)
    })
  }

  openRack(trackId: string) {
    this.rackTrackId = this.rackTrackId === trackId ? null : trackId
    this.rackFlip = false
    this.rackDetail = false
    this.emit()
  }

  flipRack() {
    this.rackFlip = !this.rackFlip
    this.emit()
  }

  toggleRackDetail() {
    this.rackDetail = !this.rackDetail
    this.emit()
  }

  togglePresetFavorite(kind: string, name: string) {
    if (!name) return
    this.mutate(() => {
      const key = `${kind}:${name}`
      const list = this.project.presetFavorites ?? []
      this.project.presetFavorites = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
    })
  }

  mutateDevice(trackId: string, deviceId: string, rng: () => number = Math.random) {
    this.mutate(() => {
      const device = this.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
      if (!device) return
      for (const item of DEVICE_PARAMS[device.kind]) {
        if (/^m\d/.test(item.id)) continue
        const span = item.max - item.min
        const current = device.params[item.id] ?? item.default
        const next = current + (rng() * 2 - 1) * span * 0.15
        device.params[item.id] = Math.min(item.max, Math.max(item.min, next))
      }
    })
  }

  addDevice(trackId: string, kind: DeviceKind) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (rack) rack.devices.push(makeDevice(kind))
    })
  }

  removeDevice(trackId: string, deviceId: string) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (!rack || rack.devices.length < 2) return
      rack.devices = rack.devices.filter((device) => device.id !== deviceId)
      rack.cables = rack.cables.filter((cable) => cable.from !== deviceId && cable.to !== deviceId)
    })
  }

  moveDevice(trackId: string, deviceId: string, direction: -1 | 1) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (!rack) return
      const index = rack.devices.findIndex((device) => device.id === deviceId)
      const next = index + direction
      if (index < 0 || next < 0 || next >= rack.devices.length) return
      const [item] = rack.devices.splice(index, 1)
      rack.devices.splice(next, 0, item)
    })
  }

  setDeviceParam(trackId: string, deviceId: string, param: string, value: number) {
    this.mutate(() => {
      const device = this.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
      if (device) device.params[param] = value
    })
  }

  applyDevicePreset(trackId: string, deviceId: string, name: string) {
    this.mutate(() => {
      const device = this.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
      if (!device) return
      const factory = FACTORY_PRESETS[device.kind].find((item) => item.name === name)
      const user = this.project.devicePresets.find((item) => item.kind === device.kind && item.name === name)
      const params = factory?.params ?? user?.params
      if (params) device.params = { ...defaults(device.kind), ...params }
    })
  }

  saveDevicePreset(kind: DeviceKind, name: string, params: Record<string, number>) {
    this.mutate(() => {
      const existing = this.project.devicePresets.find((item) => item.kind === kind && item.name === name)
      if (existing) existing.params = { ...params }
      else this.project.devicePresets.push({ id: uid('preset'), kind, name, params: { ...params } })
    })
  }

  addCable(trackId: string, from: string, fromPort: string, to: string, toPort: string) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (!rack || from === to) return
      rack.cables.push({ id: uid('cable'), from, fromPort, to, toPort, amount: 0.5 })
    })
  }

  removeCable(trackId: string, cableId: string) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (rack) rack.cables = rack.cables.filter((cable) => cable.id !== cableId)
    })
  }

  saveRackPatch(trackId: string, name: string) {
    this.mutate(() => {
      const rack = this.track(trackId)?.rack
      if (!rack) return
      const patch = { id: uid('patch'), name, rack: cloneRack(rack) }
      const existing = this.project.rackPatches.find((item) => item.name === name)
      if (existing) existing.rack = patch.rack
      else this.project.rackPatches.push(patch)
    })
  }

  loadRackPatch(trackId: string, name: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      const patch = this.project.rackPatches.find((item) => item.name === name)
      if (track && patch) track.rack = cloneRack(patch.rack)
    })
  }

  addZone(trackId: string, deviceId: string, bufferId: string) {
    this.mutate(() => {
      const device = this.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
      if (!device) return
      const root = 60 + device.zones.length * 12
      device.zones.push({ id: uid('zone'), bufferId, root, lo: root - 6, hi: root + 5, loopStart: 0, loopEnd: 1, tune: 0 })
    })
  }

  toggleStep(trackId: string, deviceId: string, step: number, pad: number) {
    this.mutate(() => {
      const device = this.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
      if (!device) return
      const bit = 1 << pad
      device.pattern[step] = (device.pattern[step] || 0) ^ bit
    })
  }

  addRackPoint(deviceId: string, param: string, beat: number, value: number) {
    this.mutate(() => {
      let lane = this.project.rackAutomation.find((item) => item.deviceId === deviceId && item.param === param)
      if (!lane) {
        lane = { id: uid('auto'), deviceId, param, points: [] }
        this.project.rackAutomation.push(lane)
      }
      const point = lane.points.find((item) => Math.abs(item.beat - beat) < 0.02)
      if (point) point.value = value
      else lane.points.push({ beat, value })
    })
  }

  findClip(clipId: string) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId)
      if (clip) return { track, clip }
    }
    return null
  }

  activePattern() {
    const beats = this.project.beats
    return beats?.patterns.find((pattern) => pattern.id === beats.activeId) ?? beats?.patterns[0] ?? null
  }

  selectPattern(id: string) {
    this.mutate(() => {
      if (this.project.beats?.patterns.some((pattern) => pattern.id === id)) this.project.beats.activeId = id
    })
  }

  renamePattern(name: string) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (pattern && name.trim()) pattern.name = name.trim()
    })
  }

  recolorPattern(color: string) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (pattern) pattern.color = color
    })
  }

  cloneActivePattern() {
    this.mutate(() => {
      const beats = this.project.beats
      const pattern = this.activePattern()
      if (!beats || !pattern) return
      const copy = clonePattern(pattern, `${pattern.name} copy`)
      beats.patterns.push(copy)
      beats.activeId = copy.id
    })
  }

  setPatternSteps(steps: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (pattern) pattern.steps = Math.max(1, Math.min(64, Math.round(steps)))
    })
  }

  setPatternSwing(swing: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (pattern) pattern.swing = Math.max(0, Math.min(0.9, swing))
    })
  }

  editChannel(channelId: string, fn: (cells: StepCell[], count: number) => StepCell[] | void, draft = false) {
    const run = (body: () => void) => (draft ? this.draft(body) : this.mutate(body))
    run(() => {
      const pattern = this.activePattern()
      const channel = pattern?.channels.find((row) => row.id === channelId)
      if (!pattern || !channel) return
      const count = channel.steps || pattern.steps
      const next = fn(channel.cells, count)
      if (next) channel.cells = next
    })
  }

  editStep(channelId: string, index: number, patch: Partial<Pick<StepCell, 'velocity' | 'pan' | 'pitch' | 'fine' | 'gate'>>) {
    this.mutate(() => {
      const cell = this.activePattern()?.channels.find((row) => row.id === channelId)?.cells[index]
      if (!cell) return
      if (patch.velocity != null) cell.velocity = Math.max(0.05, Math.min(1, patch.velocity))
      if (patch.pan != null) cell.pan = Math.max(-1, Math.min(1, patch.pan))
      if (patch.pitch != null) cell.pitch = Math.max(-48, Math.min(48, Math.round(patch.pitch)))
      if (patch.fine != null) cell.fine = Math.max(-100, Math.min(100, patch.fine))
      if (patch.gate != null) cell.gate = Math.max(0.05, Math.min(1, patch.gate))
    })
  }

  setChannel(channelId: string, patch: Partial<{ volume: number; pan: number; mute: boolean; solo: boolean; output: string | null; steps: number; swing: number | null; name: string }>) {
    this.mutate(() => {
      const channel = this.activePattern()?.channels.find((row) => row.id === channelId)
      if (!channel) return
      Object.assign(channel, patch)
      if (patch.steps != null) channel.steps = Math.max(1, Math.min(64, Math.round(patch.steps)))
    })
  }

  fillChannel(every: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (!pattern) return
      for (const channel of pattern.channels) {
        const count = channel.steps || pattern.steps
        channel.cells = fillEvery(channel.cells, every, count)
      }
    })
  }

  randomizePattern(rng?: () => number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (!pattern) return
      for (const channel of pattern.channels) channel.cells = randomizeCells(channel.cells, channel.steps || pattern.steps, rng)
    })
  }

  humanizePattern(rng?: () => number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (!pattern) return
      for (const channel of pattern.channels) channel.cells = humanizeCells(channel.cells, channel.steps || pattern.steps, 0.45, rng)
    })
  }

  shiftPattern(direction: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (!pattern) return
      for (const channel of pattern.channels) channel.cells = shiftCells(channel.cells, channel.steps || pattern.steps, direction)
    })
  }

  copyRow(channelId: string) {
    const channel = this.activePattern()?.channels.find((row) => row.id === channelId)
    if (!channel) return
    const count = channel.steps || this.activePattern()?.steps || 16
    this.rowClipboard = channel.cells.slice(0, count).map((cell) => ({ ...cell }))
    this.emit()
  }

  pasteRow(channelId: string) {
    if (!this.rowClipboard) return
    const clip = this.rowClipboard
    this.editChannel(channelId, (cells, count) => cells.map((cell, index) => (index < count && clip[index] ? { ...clip[index] } : cell)))
  }

  placePattern(startBeat: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      if (!pattern || !this.project.patternClips) return
      this.project.patternClips.push({
        id: uid('pcl'),
        patternId: pattern.id,
        startBeat: Math.max(0, startBeat),
        lengthBeats: (pattern.steps * 0.25),
        scene: null,
      })
    })
  }

  placePatternScene(scene: number) {
    this.mutate(() => {
      const pattern = this.activePattern()
      const track = this.project.tracks.find((item) => item.type === 'midi')
      if (!pattern || !track) return
      const length = pattern.steps * 0.25
      const existing = track.midiClips.find((clip) => clip.patternId === pattern.id && clip.scene === scene)
      if (existing) {
        this.selectedMidiClipId = existing.id
        return
      }
      const clip: MidiClip = {
        id: uid('midi'),
        name: pattern.name,
        startBeat: 0,
        durationBeats: length,
        notes: [],
        patternId: pattern.id,
        scene,
      }
      track.midiClips.push(clip)
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = track.id
    })
  }

  openChannelRoll(channelId: string) {
    this.mutate(() => {
      const pattern = this.activePattern()
      const channel = pattern?.channels.find((row) => row.id === channelId)
      const track = this.project.tracks.find((item) => item.type === 'midi')
      if (!pattern || !channel || !track) return
      let clip = track.midiClips.find((item) => item.channelId === channelId && item.scene == null)
      if (!clip) {
        const hits = renderPattern({ ...pattern, channels: [{ ...channel, mute: false, solo: false }] }, 0, pattern.steps * 0.25)
        clip = {
          id: uid('midi'),
          name: channel.name,
          startBeat: 0,
          durationBeats: Math.max(1, pattern.steps * 0.25),
          channelId,
          notes: hits.map((hit) => ({
            id: uid('note'),
            pitch: hit.pitch,
            startBeat: hit.startBeat,
            durationBeats: hit.durationBeats,
            velocity: hit.velocity,
            pan: hit.pan,
            fine: hit.fine,
          })),
        }
        track.midiClips.push(clip)
      }
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = track.id
      this.view = 'beats'
    })
  }

  setRoll(patch: Partial<{ tool: RollTool; grid: number; length: number; velocity: number }>) {
    this.mutate(() => {
      this.project.roll = { ...defaultRoll(), ...this.project.roll, ...patch }
    })
  }

  setRollTool(tool: RollTool) {
    const memory = this.project.roll ?? defaultRoll()
    if (memory.tool === tool) return
    this.project.roll = { ...memory, tool }
    this.emit()
  }

  replaceNotes(trackId: string, clipId: string, notes: MidiNote[]) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      clip.notes = notes
      const memory = this.project.roll ?? defaultRoll()
      const last = notes[notes.length - 1]
      if (last) this.project.roll = { ...memory, length: last.durationBeats, velocity: last.velocity }
    })
  }

  mutateAutomation(id: string, pluginId: string, points: { beat: number; value: number }[]) {
    this.mutate(() => {
      let lane = this.project.automation.find((item) => item.id === id)
      if (!lane) {
        lane = { id, pluginId, param: 'expression', points: [] }
        this.project.automation.push(lane)
      }
      lane.points = points
    })
  }

  rememberPen(length: number, velocity: number) {
    const memory = this.project.roll ?? defaultRoll()
    this.project.roll = { ...memory, length, velocity }
  }

  quantizeSettings() {
    return this.quantizeOpen ? this.quantizeDraft : normalizeQuantize(this.project.quantize)
  }

  beginTake() {
    this.takeOpen = true
    this.takeNotes = []
  }

  endTake() {
    const pending = this.takeNotes
    this.takeOpen = false
    this.takeNotes = []
    const settings = normalizeQuantize(this.project.quantize)
    if (settings.record !== 'after' || !pending.length) return
    this.mutate(() => {
      for (const item of pending) {
        const clip = this.track(item.trackId)?.midiClips.find((entry) => entry.id === item.clipId)
        if (!clip) continue
        clip.notes = quantizeMidi(clip.notes, settings, this.quantizeContext([item.noteId]))
      }
    })
  }

  addRecordedAudio(trackId: string, clip: AudioClip) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'audio') return
      const settings = normalizeQuantize(this.project.quantize)
      const asset = this.buffers.get(clip.bufferId)
      const channel = asset?.channels[0]
      let next = clip
      if (channel && settings.record === 'live') next = quantizeAudioStart(clip, channel, asset.sampleRate, this.project.tempo, settings)
      if (channel && settings.record === 'after') next = quantizeAudioWarp(clip, channel, asset.sampleRate, this.project.tempo, settings)
      track.clips.push(next)
      this.selectedTrackId = trackId
      this.selectedClipId = next.id
    })
  }

  openQuantize() {
    this.quantizeDraft = normalizeQuantize(this.project.quantize)
    this.quantizeOpen = true
    this.quantizePreview = this.computeQuantize(this.quantizeDraft)
    this.emit()
  }

  closeQuantize() {
    this.project.quantize = this.quantizeDraft
    this.quantizePreview = null
    this.quantizeOpen = false
    this.emit()
  }

  setQuantizeDraft(patch: Partial<QuantizeSettings>) {
    this.quantizeDraft = normalizeQuantize({ ...this.quantizeDraft, ...patch })
    if (this.quantizeOpen) this.quantizePreview = this.computeQuantize(this.quantizeDraft)
    this.emit()
  }

  quickQuantize() {
    const settings = normalizeQuantize(this.project.quantize)
    const result = this.computeQuantize(settings)
    this.mutate(() => {
      this.project.quantize = settings
      this.writeQuantize(result)
    })
  }

  commitQuantize() {
    const settings = this.quantizeDraft
    const result = this.computeQuantize(settings)
    this.mutate(() => {
      this.project.quantize = settings
      this.writeQuantize(result)
    })
    this.quantizeOpen = false
  }

  saveQuantizePreset(name: string) {
    const label = name.trim()
    if (!label) return
    this.mutate(() => {
      const settings = normalizeQuantize(this.quantizeOpen ? this.quantizeDraft : this.project.quantize)
      const presets = (this.project.quantizePresets ?? []).filter((preset) => preset.name !== label)
      presets.push({ id: uid('q'), name: label, settings })
      this.project.quantizePresets = presets
      this.project.quantize = settings
    })
  }

  loadQuantizePreset(id: string) {
    const preset = this.project.quantizePresets?.find((item) => item.id === id)
    if (!preset) return
    this.quantizeDraft = normalizeQuantize(preset.settings)
    this.quantizeOpen = true
    this.quantizePreview = this.computeQuantize(this.quantizeDraft)
    this.emit()
  }

  extractQuantizeGroove() {
    const settings = this.quantizeSettings()
    const beats = this.grooveSources(settings)
    if (!beats.length) return
    this.setQuantizeDraft({ groove: extractGroove(beats), swing: 0 })
  }

  private inputNote(clip: MidiClip, note: MidiNote) {
    const settings = normalizeQuantize(this.project.quantize)
    if (!this.takeOpen || settings.record === 'off') return note
    if (settings.record === 'after') {
      this.takeNotes.push({ trackId: this.trackOfClip(clip.id) ?? '', clipId: clip.id, noteId: note.id })
      return note
    }
    return quantizeMidi([note], settings, this.quantizeContext())[0] ?? note
  }

  private trackOfClip(clipId: string) {
    return this.project.tracks.find((track) => track.midiClips.some((clip) => clip.id === clipId))?.id ?? null
  }

  private quantizeContext(only?: string[]) {
    const scale = this.scaleState()
    return { tempo: this.project.tempo, root: scale.root, scale: scale.scale as ScaleId, only }
  }

  private grooveSources(settings: QuantizeSettings) {
    const beats: number[] = []
    for (const item of this.collectNotes(settings.scope)) {
      for (const note of item.clip.notes) beats.push(item.clip.startBeat + note.startBeat)
    }
    if (beats.length) return beats
    for (const item of this.collectAudio(settings.scope)) {
      const channel = this.buffers.get(item.clip.bufferId)?.channels[0]
      if (!channel) continue
      const rate = this.buffers.get(item.clip.bufferId)?.sampleRate || this.project.sampleRate
      const slice = channel.subarray(item.clip.offsetSamples, item.clip.offsetSamples + item.clip.durationSamples)
      for (const hit of detectTransients(slice, rate, settings.threshold)) {
        beats.push((item.clip.startSample + hit) / this.project.sampleRate * (this.project.tempo / 60))
      }
    }
    const pattern = this.activePattern()
    if (!beats.length && pattern && (settings.scope === 'pattern' || this.view === 'beats')) {
      for (const channel of pattern.channels) {
        const count = channel.steps || pattern.steps
        for (let index = 0; index < count; index++) {
          const cell = channel.cells[index]
          if (cell?.on) beats.push(index * 0.25 + (cell.nudge || 0))
        }
      }
    }
    return beats
  }

  private computeQuantize(settings: QuantizeSettings): QuantizeResult {
    const scale = this.quantizeContext()
    const result: QuantizeResult = { notes: [], channels: [], audio: [] }
    if (settings.scope === 'pattern' || (settings.scope === 'selection' && this.view === 'beats' && !this.selectedNoteIds.length)) {
      const pattern = this.activePattern()
      if (pattern) {
        for (const channel of pattern.channels) result.channels.push({ id: channel.id, cells: quantizeChannel(channel, settings, scale) })
      }
      if (settings.scope === 'pattern' || this.view === 'beats') return result
    }
    const skipAudio = settings.scope === 'selection' && this.selectedNoteIds.length > 0
    for (const item of this.collectNotes(settings.scope)) {
      const only = settings.scope === 'selection' && this.selectedNoteIds.length ? this.selectedNoteIds : undefined
      result.notes.push({ trackId: item.trackId, clipId: item.clip.id, notes: quantizeMidi(item.clip.notes, settings, { ...scale, only }) })
    }
    for (const item of skipAudio ? [] : this.collectAudio(settings.scope)) {
      const asset = this.buffers.get(item.clip.bufferId)
      const channel = asset?.channels[0]
      if (!channel) continue
      result.audio.push({
        trackId: item.trackId,
        clipId: item.clip.id,
        clip: quantizeAudioWarp(item.clip, channel, asset.sampleRate, this.project.tempo, settings),
      })
    }
    return result
  }

  private collectNotes(scope: QuantizeSettings['scope']) {
    const found: { trackId: string; clip: MidiClip }[] = []
    const tracks = scope === 'track' ? this.project.tracks.filter((track) => track.id === this.selectedTrackId) : this.project.tracks
    for (const track of tracks) {
      for (const clip of track.midiClips) {
        if (clip.scene != null) continue
        if (scope === 'clip' || scope === 'selection') {
          if (clip.id !== this.selectedMidiClipId) continue
        }
        if (!clip.notes.length) continue
        found.push({ trackId: track.id, clip })
      }
    }
    return found
  }

  private collectAudio(scope: QuantizeSettings['scope']) {
    if (scope === 'pattern') return []
    const found: { trackId: string; clip: AudioClip }[] = []
    const tracks = scope === 'track' ? this.project.tracks.filter((track) => track.id === this.selectedTrackId) : this.project.tracks
    for (const track of tracks) {
      for (const clip of track.clips) {
        if ((scope === 'clip' || scope === 'selection') && clip.id !== this.selectedClipId) continue
        found.push({ trackId: track.id, clip })
      }
    }
    return found
  }

  private writeQuantize(result: QuantizeResult) {
    for (const item of result.notes) {
      const clip = this.track(item.trackId)?.midiClips.find((entry) => entry.id === item.clipId)
      if (clip) clip.notes = item.notes
    }
    for (const item of result.audio) {
      const clips = this.track(item.trackId)?.clips
      const index = clips?.findIndex((clip) => clip.id === item.clipId) ?? -1
      if (clips && index >= 0) clips[index] = item.clip
    }
    const pattern = this.activePattern()
    if (!pattern) return
    for (const item of result.channels) {
      const channel = pattern.channels.find((row) => row.id === item.id)
      if (channel) channel.cells = item.cells
    }
  }

  recordSettings(): RecordSettings & { quantizeBeats: number } {
    return { ...(this.project.record || defaultRecord(this.project.loopEndSample)), quantizeBeats: this.project.quantizeBeats ?? 0 }
  }

  setRecord(patch: Partial<RecordSettings> & { quantizeBeats?: number }) {
    this.mutate(() => {
      if (patch.quantizeBeats != null) this.project.quantizeBeats = Math.max(0, patch.quantizeBeats)
      const rest = { ...patch }
      delete rest.quantizeBeats
      if (Object.keys(rest).length) {
        const current = { ...(this.project.record || defaultRecord(this.project.loopEndSample)) }
        this.project.record = { ...current, ...rest }
      }
    })
  }

  quickPunch(playhead: number, recording: boolean) {
    this.mutate(() => {
      const current = { ...(this.project.record || defaultRecord(this.project.loopEndSample)) }
      this.project.record = quickPunchSettings(current, playhead, this.project.sampleRate, this.project.tempo, this.project.timeSignature, recording)
    })
  }

  swipeTake(trackId: string, clipId: string, laneId: string, from: number, to: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip?.folder) return
      clip.folder = swipeComp(clip.folder, laneId, from, to)
    })
  }

  saveTakeComp(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip?.folder) return
      const name = `Comp ${clip.folder.comps.length + 1}`
      clip.folder = saveComp(clip.folder, name, uid('comp'))
    })
  }

  recallTakeComp(trackId: string, clipId: string, compId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip?.folder) return
      clip.folder = recallComp(clip.folder, compId)
    })
  }

  flattenTakes(trackId: string, clipId: string, merge: boolean) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const index = track.clips.findIndex((item) => item.id === clipId)
      const clip = track.clips[index]
      if (!clip?.folder) return
      if (!merge) {
        track.clips.splice(index, 1, ...flattenPieces(clip))
        this.selectedClipId = track.clips[index]?.id ?? null
        return
      }
      const audio = new Map<string, Float32Array[]>()
      for (const lane of clip.folder.lanes) {
        const asset = this.buffers.get(lane.bufferId)
        if (asset) audio.set(lane.bufferId, asset.channels)
      }
      const channels = renderComp(clip.folder, audio)
      const bufferId = uid('buf')
      this.buffers.set(bufferId, { id: bufferId, name: `${clip.name} comp`, sampleRate: this.project.sampleRate, channels })
      const spanStart = clip.folder.lanes.reduce((min, lane) => Math.min(min, lane.startSample), clip.startSample)
      track.clips[index] = {
        ...clip,
        name: `${clip.name} flat`,
        folder: undefined,
        bufferId,
        startSample: spanStart,
        offsetSamples: 0,
        durationSamples: channels[0]?.length || clip.durationSamples,
        source: 'local',
      }
    })
  }

  dropGuideLanes(takeId: string) {
    this.mutate(() => {
      for (const track of this.project.tracks) {
        for (const clip of track.clips) {
          if (!clip.folder) continue
          const removed = new Set(clip.folder.lanes.filter((lane) => lane.source === 'guide' && lane.takeId === takeId).map((lane) => lane.id))
          if (!removed.size) continue
          clip.folder = {
            ...clip.folder,
            lanes: clip.folder.lanes.filter((lane) => !removed.has(lane.id)),
            comps: clip.folder.comps.map((comp) => ({
              ...comp,
              segments: comp.segments.filter((segment) => !removed.has(segment.laneId)),
            })),
          }
        }
        track.clips = track.clips.filter((clip) => !clip.folder || clip.folder.lanes.length > 0)
      }
    })
  }

  addTakeLane(trackId: string, lane: TakeLane, clipId?: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const existing = clipId
        ? track.clips.find((item) => item.id === clipId && item.folder)
        : track.clips.find((item) => item.folder && rangesOverlap(item, lane))
      if (existing?.folder) {
        existing.folder = addLane(existing.folder, lane)
        const span = folderSpan(existing.folder)
        existing.startSample = span.start
        existing.durationSamples = Math.max(1, span.end - span.start)
        existing.bufferId = lane.bufferId
        this.selectedClipId = existing.id
        return
      }
      const clip = folderClip(uid('clip'), lane.name, createFolder(lane), 1)
      track.clips.push(clip)
      this.selectedTrackId = trackId
      this.selectedClipId = clip.id
    })
  }

  commitMidiPass(trackId: string, clipId: string, incoming: MidiNote[]) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const mode = this.recordSettings().midiLoop
      const pass = applyMidiPass(clip.notes, incoming, clip.takes || [], mode, `Take ${(clip.takes?.length || 0) + 1}`, uid('mtake'))
      clip.notes = pass.notes
      clip.takes = pass.takes
      clip.activeTakeId = pass.activeTakeId
    })
  }

  recallMidi(trackId: string, clipId: string, takeId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip?.takes) return
      const notes = recallMidiTake(clip.takes, takeId)
      if (!notes) return
      clip.notes = notes
      clip.activeTakeId = takeId
    })
  }

  /** Two stacked lanes so the comp UI can be shown without a microphone. */
  seedCompPreview() {
    const rate = this.project.sampleRate
    const length = Math.round(rate * 2)
    const tone = (freq: number, gain: number) => {
      const data = new Float32Array(length)
      for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * gain
      return data
    }
    const first = tone(220, 0.2)
    const second = tone(330, 0.2)
    const a = uid('buf')
    const b = uid('buf')
    this.addAsset({ id: a, name: 'Take 1', sampleRate: rate, channels: [first] })
    this.addAsset({ id: b, name: 'Take 2', sampleRate: rate, channels: [second] })
    const track = this.project.tracks.find((item) => item.type === 'audio')
    if (!track) return
    this.mutate(() => {
      track.clips = track.clips.filter((clip) => !clip.folder)
    })
    const lane = (id: string, name: string, bufferId: string): TakeLane => ({
      id,
      name,
      bufferId,
      offsetSamples: 0,
      startSample: 0,
      durationSamples: length,
      source: 'local',
    })
    this.addTakeLane(track.id, lane(uid('lane'), 'Take 1', a))
    this.addTakeLane(track.id, lane(uid('lane'), 'Take 2', b))
    const clip = track.clips.find((item) => item.folder)
    if (clip?.folder) {
      const cut = Math.round(length / 2)
      this.swipeTake(track.id, clip.id, clip.folder.lanes[1].id, cut, length)
      this.setRecord({ loop: true, punchEnabled: true, punchIn: 0, punchOut: length })
    }
  }
}

function rangesOverlap(clip: AudioClip, lane: TakeLane) {
  const laneEnd = lane.startSample + lane.durationSamples
  const clipEnd = clip.startSample + clip.durationSamples
  return lane.startSample < clipEnd && laneEnd > clip.startSample
}

export function seedDemoProject(sampleRate: number, music: Float32Array): { project: Project; buffers: Map<string, AudioAsset> } {
  const project = createEmptyProject(sampleRate, 'Harbor demo')
  project.loopEndSample = Math.round(beatsToSamples(16, sampleRate, project.tempo))
  const musicTrack = project.tracks[1]
  const keys = project.tracks[2]
  const bufferId = uid('buf')
  const buffers = new Map<string, AudioAsset>()
  buffers.set(bufferId, { id: bufferId, name: 'Demo groove', sampleRate, channels: [music] })
  musicTrack.clips.push({
    id: uid('clip'),
    name: 'Demo groove',
    bufferId,
    startSample: 0,
    offsetSamples: 0,
    durationSamples: music.length,
    fadeInSamples: Math.round(sampleRate * 0.01),
    fadeOutSamples: Math.round(sampleRate * 0.05),
    gain: 0.9,
    source: 'demo',
  })
  keys.midiClips.push({
    id: uid('midi'),
    name: 'Chords',
    startBeat: 0,
    durationBeats: 8,
    notes: demoMidiNotes().map((n) => ({ ...n, id: uid('note') })),
  })
  return { project, buffers }
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids)]
}

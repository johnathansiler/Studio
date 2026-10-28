import { MASTERING_IDS } from '../audio/master/assistant'
import { spectralKey, ensureRepair, pushOp, sliceRegion } from '../audio/spectral/edit'
import { learnOffline } from '../audio/spectral/job'
import type { SpectralAction, SpectralRegion } from '../audio/spectral/types'
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
import { isPackAsset, packToAsset } from '../audio/multisample/persist'
import type { SamplePack, SamplerProgram } from '../audio/multisample/types'
import { insertIndex, tracksFor, type AddTrackSpec } from '../model/addTrack'
import { addLane, applyMidiPass, createFolder, flattenPieces, folderClip, folderSpan, quickPunch as quickPunchSettings, recallComp, recallMidiTake, renderComp, saveComp, swipeComp } from '../model/comp'
import { clampFade, moveMidiNote, resizeMidiNote } from '../model/clips'
import { setPath, type ProjectOp, type StampWire } from './ops'
import { ProjectSync } from './sync'
import { activeTool, setActiveTool, type ArrangeTool } from './tools'
import {
  drawPoint,
  ensureLane,
  eraseNear,
  findLane,
  modeOf,
  movePoint,
  specKey,
  writeSegment,
  type AutoSpec,
  type WriteCursor,
} from '../model/automation'
import {
  groupForTrack,
  linkedAudioTargets,
  patchMixer,
  setGroupFlags,
  setTrackGroup,
  shiftLinkedAudio,
  shiftLinkedMidi,
  splitLinkedAudio,
  splitLinkedMidi,
  trimLinkedAudio,
  trimLinkedMidi,
} from '../model/mixGroups'
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
import { stopPlan } from '../model/sessionSlots'
import type { RollTool } from '../model/paint'
import { defaultRoll } from '../model/paint'
import type { GeneratedPart } from '../generators/types'
import { normalizeGenerator } from '../generators/settings'
import { buildSession, normalizePlayer, type PlayerSettings, type SessionDetection, type SessionPart } from '../players'
import { progressionById, romanLine, starterParts } from '../model/progressions'
import { applySuggestion, type Suggestion } from '../unstuck'
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
import { cloneOmni, emptyOmni, type OmniPatch } from '../instruments/patch'
import { cloneRack, defaults, DEVICE_PARAMS, FACTORY_PRESETS, makeDevice, normalizeProjectRack, normalizeTrackRack, type DeviceKind } from '../model/rack'
import { normalizeScale, patternNotes, voiceChord, type PlayNote, type ScaleId, type ScaleState } from '../model/scale'
import { clipFromNotes, recordOnto, rememberVoice } from '../instruments/scaler/clips'
import { freshScaler, normalizeScaler, padPerformance, type ScalerState } from '../instruments/scaler/model'
import { lockedTone, scaleIsMicrotonal, suggestKey } from '../theory/lock'
import {
  clampSwing,
  clonePattern,
  fillEvery,
  humanizeCells,
  randomizeCells,
  renderPattern,
  shiftCells,
  type StepCell,
} from '../model/steps'
import {
  applyMidiChain,
  bindingFromMessage,
  chainContext,
  currentControl,
  defaultFx,
  describeWrite,
  upsertMap,
  type LearnSlot,
  type ParsedMidi,
} from '../model/midiTools'
import { createEmptyProject, defaultInsert, defaultRecord, makeTrack, uid, TRACK_COLORS } from '../model/types'
import type { AudioAsset, AudioClip, AutomationWriteMode, ClipStretch, FollowAction, InsertType, LaunchMode, LaunchQuant, LiveCaptureSettings, MidiClip, MidiEditorPrefs, MidiFx, MidiFxKind, MidiMapEntry, MidiNote, MidiOutSettings, MixGroup, PluginInstance, Project, RecordSettings, SectionKind, TakeLane, Track, TrackInstrument } from '../model/types'
import { createSection, deleteSectionContents, duplicateSectionContents, moveSectionContents, resizeSection as setSectionLength, sectionKind } from '../model/sections'
import { adaptProjectTempo, clipTempo, conformStretchPatch } from '../model/smartTempo'
import { downbeatAt, projectBeatSample, projectSampleBeat, snapSampleToMap, tempoAtSample } from '../model/tempoMap'
import { beatsToSamples, quartersPerBar, samplesToBeats } from '../model/time'
import { linearResample } from '../model/wav'
import { renderDrum, DRUM_PADS } from '../model/drums'
import { isDrumTrack, clampRoll, DRUM_STEP, hitAt } from '../model/drumLanes'
import { clearStep, normalizeMidiEditor, placeStep, tieHeld, type StepTone } from '../model/stepEntry'
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

function samePlayer(name: string, role: SessionPart['role']) {
  if (role === 'drums') return name === 'Drummer' || name.endsWith(' drummer')
  if (role === 'bass') return name.endsWith('bass player')
  return name.endsWith('keys player')
}

const GENERATED_COLOR: Record<GeneratedPart['kind'], string> = {
  chords: '#e0b15a',
  bass: '#79b8d4',
  melody: '#73c48f',
  arp: '#f09a6a',
  rhythm: '#ef6b6b',
  drums: '#c58be0',
}

/** Snap a clip edge to the tempo map. Whole-beat hits drop sample roundoff. */
function snappedClipBeat(project: Project, beat: number) {
  if (!project.snap) return Math.max(0, beat)
  const sample = snapSampleToMap(projectBeatSample(project, beat), project)
  const next = projectSampleBeat(project, sample)
  const grid = Math.round(next)
  if (Math.abs(next - grid) < 1e-3) return Math.max(0, grid)
  return Math.max(0, next)
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
  /** Quantized stop that has not reached its bar yet. The clip keeps playing until then. */
  stopAt: Record<string, number> = {}
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
  /** Open Scaler panel. The plugin state itself is on the track. */
  scalerTrackId: string | null = null
  /** Open layered patch. Not saved; the patch itself is on the track. */
  patchTrackId: string | null = null
  rackFlip = false
  rackDetail = false
  /** Letter keys play notes while this is on, so tap-tempo stays off T. */
  keyboardMidi = false
  /** MIDI tools strip. Not saved. */
  midiToolsOpen = false
  midiLearnActive = false
  midiLearnSlot: LearnSlot | null = null
  private tempoGroup = false
  toasts: Toast[] = []
  version = 0
  rowClipboard: StepCell[] | null = null
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()
  /** Musical journal shared with every view and with the remote session. */
  readonly sync = new ProjectSync()
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
  /** Selected song section. Not saved. */
  sectionId: string | null = null
  /** Selected tempo-map point, by its quarter-note beat. Not saved. */
  tempoPointBeat: number | null = null
  /** Offer after a recording or import whose pulse is not the song tempo. Not saved. */
  smartTempo: { trackId: string; clipId: string; bpm: number } | null = null
  /** Spectral repair sheet. Not saved. */
  spectralTrackId: string | null = null
  spectralClipId: string | null = null
  spectralStatus: string | null = null
  private bypassed: { id: string; enabled: boolean }[] | null = null
  /** Which arrange rows show an automation lane. Not saved. */
  openLanes: Record<string, boolean> = {}
  laneChoice: Record<string, string> = {}
  private touching = false
  private write: WriteCursor | null = null

  constructor(project = createEmptyProject(), buffers?: Map<string, AudioAsset>) {
    this.project = normalizeProjectRack(normalizeProject(project))
    if (buffers) this.buffers = buffers
    this.selectedTrackId = project.tracks[0]?.id ?? null
    this.selectedClipId = null
    this.selectedMidiClipId = null
    this.selectedNoteId = null
    this.selectedNoteIds = []
    this.sync.rebase(this.project)
  }

  subscribe = (fn: Listener) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit() {
    this.version += 1
    if (!this.sync.silence) this.sync.observe(this.project)
    for (const fn of this.listeners) fn()
  }

  /** Remote field ops. History is patched so a later undo keeps them. */
  applyRemoteOps(ops: ProjectOp[]) {
    const { applied, gap } = this.sync.ingest(this.project, ops)
    if (applied.length) {
      this.rewriteHistory(applied)
      this.emit()
    }
    return gap
  }

  /**
   * Reconnect resync. Local stamps that are newer than the checkpoint are returned
   * so the other device can catch up without a second full project.
   */
  mergeRemoteCheckpoint(remote: Project, stamps: StampWire[] | undefined, prefer: 'local' | 'remote', lamport = 0, actor = '', seq = 0) {
    this.sync.silence = true
    const waveforms = remote.waveforms
    const merged = this.sync.merge(this.project, remote, stamps, prefer, lamport, actor, seq)
    this.project = normalizeProjectRack(normalizeProject(merged.project))
    if (waveforms) this.project.waveforms = waveforms
    this.past = []
    this.future = []
    this.sync.adopt(this.project)
    this.sync.silence = false
    this.emit()
    return merged.reply
  }

  private rewriteHistory(ops: ProjectOp[]) {
    const apply = (raw: string) => {
      try {
        const project = JSON.parse(raw) as Project
        for (const op of ops) setPath(project, op.p, op.v)
        return JSON.stringify(project)
      } catch {
        return raw
      }
    }
    this.past = this.past.map(apply)
    this.future = this.future.map(apply)
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

  openSpectral(trackId: string, clipId: string) {
    this.spectralTrackId = trackId
    this.spectralClipId = clipId
    this.selectedTrackId = trackId
    this.selectedClipId = clipId
    this.stemTrackId = null
    this.stemClipId = null
    this.emit()
  }

  closeSpectral() {
    this.spectralTrackId = null
    this.spectralClipId = null
    this.spectralStatus = null
    this.emit()
  }

  setSpectralStatus(status: string | null) {
    if (this.spectralStatus === status) return
    this.spectralStatus = status
    this.emit()
  }

  applySpectralOp(trackId: string, clipId: string, action: SpectralAction, region: SpectralRegion, amount: number, humHz?: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      pushOp(clip, action, region, amount, humHz, uid('sop'))
    })
  }

  learnSpectralNoise(trackId: string, clipId: string, region: SpectralRegion) {
    const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
    if (!clip || this.remoteFollow) return Promise.resolve()
    const origin = clip.spectral?.origin ?? clip.offsetSamples
    const span = clip.spectral?.span || clip.durationSamples
    const source = this.buffers.get(clip.spectral?.sourceBufferId ?? clip.bufferId)
    if (!source) return Promise.resolve()
    const mapped = sliceRegion(clip, region)
    const slice = source.channels.map((channel) => channel.slice(origin, origin + span))
    this.setSpectralStatus('Learning noise…')
    return learnOffline(slice, source.sampleRate, mapped)
      .then((bands) => {
        this.mutate(() => {
          const current = this.track(trackId)?.clips.find((item) => item.id === clipId)
          if (!current) return
          const repair = ensureRepair(current)
          repair.noiseBands = bands
          repair.noiseRate = source.sampleRate
          repair.renderedKey = undefined
        })
      })
      .catch(() => {
        this.toast('Could not learn the noise profile', 'warn')
      })
      .finally(() => this.setSpectralStatus(null))
  }

  removeSpectralOp(trackId: string, clipId: string, opId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      const repair = clip?.spectral
      if (!clip || !repair) return
      repair.ops = repair.ops.filter((op) => op.id !== opId)
      repair.renderedKey = undefined
      if (!repair.ops.length) {
        clip.bufferId = repair.sourceBufferId
        repair.renderId = undefined
      }
    })
  }

  toggleSpectral(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      const repair = clip?.spectral
      if (!clip || !repair) return
      repair.enabled = !repair.enabled
      if (!repair.enabled) clip.bufferId = repair.sourceBufferId
      else if (repair.renderId && repair.renderedKey === spectralKey(repair)) clip.bufferId = repair.renderId
    })
  }

  /** Swap in a finished render without an extra undo step. The source asset stays. */
  installSpectral(trackId: string, clipId: string, channels: Float32Array[], sampleRate: number, key: string) {
    const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
    const repair = clip?.spectral
    if (!clip || !repair || spectralKey(repair) !== key) return
    const id = uid('spec')
    this.buffers.set(id, { id, name: `${clip.name} spectral`, sampleRate, channels })
    const previous = repair.renderId
    repair.renderId = id
    repair.renderedKey = key
    if (repair.enabled) clip.bufferId = id
    this.dropSpectralAsset(previous)
    this.emit()
  }

  private dropSpectralAsset(id?: string) {
    if (!id?.startsWith('spec_')) return
    const hay = `${this.past.join('\n')}\n${this.future.join('\n')}\n${JSON.stringify(this.project)}`
    if (!hay.includes(`"${id}"`)) this.buffers.delete(id)
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

  /** Put Scaler on a MIDI track, or make a new one, and open its panel. */
  insertScaler(trackId?: string | null): string | null {
    const asked = trackId ? this.track(trackId) : undefined
    const selected = this.selectedTrackId ? this.track(this.selectedTrackId) : undefined
    const host = asked?.type === 'midi' ? asked : selected?.type === 'midi' ? selected : undefined
    if (host) {
      this.setTrackInstrument(host.id, 'scaler')
      return host.id
    }
    const ids = this.addTracks({ kind: 'midi', count: 1, instrument: 'scaler', input: 'mic', channels: 1, armed: false })
    return ids[0] ?? null
  }

  setTrackInstrument(trackId: string, instrument: TrackInstrument) {
    const track = this.track(trackId)
    if (!track || track.type !== 'midi') return
    this.mutate(() => {
      const current = this.track(trackId)
      if (!current || current.type !== 'midi') return
      current.instrument = instrument
      if (instrument === 'scaler') current.scaler = current.scaler ? normalizeScaler(current.scaler) : freshScaler(this.project)
    })
    if (instrument === 'scaler') {
      this.rackTrackId = null
      this.scalerTrackId = trackId
      this.emit()
    } else if (this.scalerTrackId === trackId) {
      this.scalerTrackId = null
      this.emit()
    }
  }

  openScaler(trackId: string) {
    const track = this.track(trackId)
    if (!track || track.type !== 'midi') return
    if (track.instrument !== 'scaler') {
      this.setTrackInstrument(trackId, 'scaler')
      return
    }
    this.rackTrackId = null
    this.scalerTrackId = this.scalerTrackId === trackId ? null : trackId
    this.emit()
  }

  setScaler(trackId: string, patch: Partial<ScalerState>) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      track.instrument = 'scaler'
      track.scaler = normalizeScaler({ ...normalizeScaler(track.scaler), ...patch })
    })
  }

  scalerPadNotes(trackId: string, index: number) {
    const track = this.track(trackId)
    if (!track?.scaler) return []
    const span = Math.max(1, this.project.timeSignature?.numerator || 4)
    return padPerformance(normalizeScaler(track.scaler), index, span)?.notes ?? []
  }

  detectScaler(trackId: string) {
    const track = this.track(trackId)
    if (!track || track.type !== 'midi') return false
    const notes = track.midiClips.flatMap((clip) => clip.notes.filter((note) => !note.muted).map((note) => ({
      midi: note.pitch,
      cents: note.fine ?? 0,
      weight: Math.max(0.05, note.durationBeats),
    })))
    if (notes.length < 3) return false
    const found = suggestKey(notes)
    this.setScaler(trackId, { root: found.root, scale: found.scale, library: found.library, snap: true, lastVoicing: [], lastCents: [] })
    return true
  }

  /** Voice-leading memory. Not an undo step, so playing pads does not flood the journal. */
  rememberScalerVoice(trackId: string, midi: number[], cents: number[]) {
    const track = this.track(trackId)
    if (!track) return
    rememberVoice(track, midi, cents)
    this.emit()
  }

  /** Drop a chord onto Arrange as its own MIDI clip. */
  writeScalerClip(trackId: string, notes: { pitch: number; fine?: number; startBeat: number; durationBeats: number; velocity: number }[], startBeat: number, name: string) {
    if (!notes.length) return null
    let clipId: string | null = null
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const clip = clipFromNotes(notes, startBeat, name)
      track.midiClips.push(clip)
      clipId = clip.id
      this.selectedTrackId = track.id
      this.selectedMidiClipId = clip.id
      this.selectedMidiClipIds = [clip.id]
      this.selectedNoteIds = clip.notes.map((note) => note.id)
      this.selectedNoteId = clip.notes.at(-1)?.id ?? null
    })
    return clipId
  }

  /** Record a played pad onto this track's Scaler take. */
  recordScalerChord(trackId: string, notes: { pitch: number; fine?: number; startBeat: number; durationBeats: number; velocity: number }[], startBeat: number) {
    if (!notes.length) return null
    let clipId: string | null = null
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const clip = recordOnto(track, notes, startBeat)
      clipId = clip.id
      this.selectedTrackId = track.id
      this.selectedMidiClipId = clip.id
      this.selectedMidiClipIds = [clip.id]
    })
    return clipId
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
        if (!this.selectedNoteIds.includes(note.id)) continue
        const tone = lockedTone(note.pitch, note.fine ?? 0, scale)
        note.pitch = tone.midi
        if (scale.library || scaleIsMicrotonal(scale)) applyFine(note, tone.cents)
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
    const apply = () => {
      this.project.tempo = value
      const first = this.project.tempoMap?.find((point) => point.beat <= 1e-3)
      if (first) first.bpm = value
      this.retimeFollow()
    }
    if (group && this.tempoGroup) {
      if (this.remoteFollow || this.project.tempo === value) return
      apply()
      this.emit()
      return
    }
    this.mutate(apply)
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
      if (this.project.meterMap) this.project.meterMap = this.project.meterMap.filter((change) => change.beat > 1e-3)
    })
  }

  addTempoPoint(beat: number, bpm = this.project.tempo, ramp = false) {
    const at = Math.max(0, beat)
    const value = clamp(Math.round(bpm * 10) / 10, 30, 300)
    if (at <= 1e-3) {
      this.setTempo(value)
      return
    }
    this.mutate(() => {
      const map = [...(this.project.tempoMap ?? [])]
      const index = map.findIndex((point) => Math.abs(point.beat - at) < 0.04)
      const point = { beat: at, bpm: value, ramp }
      if (index >= 0) map[index] = { ...map[index], ...point }
      else map.push(point)
      map.sort((a, b) => a.beat - b.beat)
      this.project.tempoMap = map
      this.retimeFollow()
    })
    this.tempoPointBeat = at
    this.sectionId = null
    this.emit()
  }

  moveTempoPoint(fromBeat: number, next: { beat?: number; bpm?: number; ramp?: boolean }) {
    this.mutate(() => {
      const map = this.project.tempoMap ?? []
      const point = map.find((item) => Math.abs(item.beat - fromBeat) < 0.04) ?? (fromBeat <= 1e-3 ? map.find((item) => item.beat <= 1e-3) : undefined)
      if (fromBeat <= 1e-3 && next.bpm != null && !point) {
        this.project.tempo = clamp(Math.round(next.bpm * 10) / 10, 30, 300)
        this.retimeFollow()
        return
      }
      if (!point) return
      if (next.bpm != null) point.bpm = clamp(Math.round(next.bpm * 10) / 10, 30, 300)
      if (next.ramp != null) point.ramp = next.ramp
      if (next.beat != null && point.beat > 1e-3) point.beat = Math.max(1e-3, next.beat)
      if (point.beat <= 1e-3) this.project.tempo = point.bpm
      map.sort((a, b) => a.beat - b.beat)
      this.retimeFollow()
    })
    if (next.beat != null) this.tempoPointBeat = next.beat
    this.emit()
  }

  removeTempoPoint(beat: number) {
    if (beat <= 1e-3) return
    this.mutate(() => {
      this.project.tempoMap = (this.project.tempoMap ?? []).filter((point) => Math.abs(point.beat - beat) >= 0.04)
      if (!this.project.tempoMap.length) this.project.tempoMap = undefined
      this.retimeFollow()
    })
    this.tempoPointBeat = null
    this.emit()
  }

  setMeterAt(beat: number, numerator: number, denominator: number) {
    const at = beat <= 0.5 ? 0 : downbeatAt(this.project, beat)
    if (at <= 1e-3) {
      this.setTimeSignature(numerator, denominator)
      return
    }
    this.mutate(() => {
      const map = [...(this.project.meterMap ?? [])].filter((change) => Math.abs(change.beat - at) >= 0.04)
      map.push({ beat: at, numerator, denominator })
      map.sort((a, b) => a.beat - b.beat)
      this.project.meterMap = map
    })
  }

  selectSection(id: string | null) {
    this.sectionId = id
    if (id) this.tempoPointBeat = null
    this.emit()
  }

  selectTempoPoint(beat: number | null) {
    this.tempoPointBeat = beat
    if (beat != null) this.sectionId = null
    this.emit()
  }

  addSection(kind: SectionKind, beat: number) {
    let created: string | null = null
    this.mutate(() => {
      const section = createSection(this.project, beat, kind)
      this.project.sections = [...(this.project.sections ?? []), section]
      created = section.id
    })
    this.sectionId = created
    this.tempoPointBeat = null
    this.emit()
  }

  renameSection(id: string, name: string) {
    this.mutate(() => {
      const section = this.project.sections?.find((item) => item.id === id)
      if (section) section.name = name.slice(0, 48)
    })
  }

  recolorSection(id: string, kind: SectionKind) {
    this.mutate(() => {
      const section = this.project.sections?.find((item) => item.id === id)
      if (!section) return
      const spec = sectionKind(kind)
      const keepName = section.name === sectionKind(section.kind).name || section.name.startsWith(`${sectionKind(section.kind).name} `)
      section.kind = kind
      section.color = spec.color
      if (kind === 'marker') section.durationBeats = 0
      if (keepName) section.name = spec.name
    })
  }

  moveSection(id: string, beat: number) {
    this.mutate(() => {
      moveSectionContents(this.project, id, this.project.snap ? Math.max(0, Math.round(beat)) : Math.max(0, beat))
      this.retimeFollow()
    })
  }

  duplicateSection(id: string) {
    let created: string | null = null
    this.mutate(() => {
      created = duplicateSectionContents(this.project, id)?.id ?? null
      this.retimeFollow()
    })
    if (created) this.sectionId = created
    this.emit()
  }

  deleteSection(id: string) {
    this.mutate(() => {
      deleteSectionContents(this.project, id)
      this.retimeFollow()
    })
    if (this.sectionId === id) this.sectionId = null
    this.emit()
  }

  resizeSection(id: string, durationBeats: number) {
    this.mutate(() => {
      setSectionLength(this.project, id, durationBeats)
    })
  }

  dismissSmartTempo() {
    this.smartTempo = null
    this.emit()
  }

  adaptClipTempo(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const bpm = clipTempo(clip) ?? this.detectClipBpm(clip)
      if (bpm == null) return
      if (!clip.stretch) clip.stretch = { sourceSamples: clip.durationSamples, semitones: 0, cents: 0, mode: 'pro', followTempo: false, sourceBpm: bpm, markers: [] }
      else if (!clip.stretch.sourceBpm) clip.stretch.sourceBpm = bpm
      adaptProjectTempo(this.project, bpm)
      this.retimeFollow()
    })
    this.smartTempo = null
    this.emit()
  }

  conformClipTempo(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const bpm = clipTempo(clip) ?? this.detectClipBpm(clip)
      if (bpm == null) return
      const base = clip.stretch ?? { sourceSamples: clip.durationSamples, semitones: 0, cents: 0, mode: 'pro' as const, followTempo: false, sourceBpm: bpm, markers: [] }
      clip.stretch = { ...base, ...conformStretchPatch(bpm, base.mode), markers: base.markers }
      clip.durationSamples = timelineSamples(clip, this.project)
      this.commitClip(clip)
    })
    this.smartTempo = null
    this.emit()
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
      for (const track of made) {
        if (track.type === 'midi') normalizeTrackRack(track)
        if (track.instrument === 'scaler') track.scaler = freshScaler(this.project)
      }
      if (spec.kind === 'midi' && spec.instrument === 'library' && made[0]) this.rackTrackId = made[0].id
      if (spec.kind === 'midi' && spec.instrument === 'scaler' && made[0]) {
        this.scalerTrackId = made[0].id
        this.rackTrackId = null
      }
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

  /** Same as setLibrary, and keep imported wavs and SoundFont packs in the project so they save. */
  adoptLibrary(trackId: string, program: SamplerProgram, assets: { id: string; name: string; sampleRate: number; channels: Float32Array[] }[], pack?: SamplePack | null) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      track.instrument = 'library'
      track.library = program
      for (const asset of assets) this.buffers.set(asset.id, asset)
      if (pack) this.buffers.set(pack.id, packToAsset(pack))
      if (!track.rack?.devices?.length) normalizeTrackRack(track)
    })
  }

  /** Latch a keyswitch on the library instrument. Other views read it from the project. */
  setLibrarySwitch(trackId: string, note: number | null) {
    this.mutate(() => {
      const program = this.track(trackId)?.library
      if (!program) return
      program.defaultSwitch = note
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
      const mixer: { volume?: number; pan?: number; mute?: boolean; solo?: boolean; soloSafe?: boolean } = {}
      if (patch.volume != null) mixer.volume = patch.volume
      if (patch.pan != null) mixer.pan = patch.pan
      if (patch.mute != null) mixer.mute = patch.mute
      if (patch.solo != null) mixer.solo = patch.solo
      if (patch.soloSafe != null) mixer.soloSafe = patch.soloSafe
      if (Object.keys(mixer).length) patchMixer(this.project, id, mixer)
      const rest: Partial<Track> = { ...patch }
      delete rest.volume
      delete rest.pan
      delete rest.mute
      delete rest.solo
      delete rest.soloSafe
      Object.assign(track, rest)
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

  setAutomationMode(mode: AutomationWriteMode) {
    this.mutate(() => {
      this.project.automationMode = mode
    })
  }

  toggleAutomation(trackId: string) {
    this.openLanes = { ...this.openLanes, [trackId]: !this.openLanes[trackId] }
    this.emit()
  }

  chooseLane(trackId: string, key: string) {
    this.laneChoice = { ...this.laneChoice, [trackId]: key }
    this.emit()
  }

  assignMixGroup(trackId: string, choice: string) {
    this.mutate(() => {
      setTrackGroup(this.project, trackId, choice)
    })
  }

  setMixLink(groupId: string, patch: Partial<Pick<MixGroup, 'faders' | 'mutes' | 'solos' | 'edits' | 'name'>>) {
    this.mutate(() => {
      setGroupFlags(this.project, groupId, patch)
    })
  }

  beginAutomationTouch() {
    this.touching = true
  }

  endAutomationTouch() {
    this.touching = false
  }

  /** Move a mixer or plugin control. Latch and touch write a lane while the transport is rolling. */
  setAutomated(spec: AutoSpec, value: number, playing: boolean, sample: number) {
    const mode = modeOf(this.project)
    if (playing && mode === 'read') return
    const writing = playing && (mode === 'latch' || this.touching)
    const run = writing ? (fn: () => void) => this.draft(fn) : (fn: () => void) => this.mutate(fn)
    run(() => {
      this.applySpec(spec, value)
      if (!writing) {
        this.write = null
        return
      }
      const beat = projectSampleBeat(this.project, sample)
      const key = specKey(spec)
      const previous = this.write?.key === key ? this.write : null
      const fromBeat = previous?.beat ?? beat
      const fromValue = previous?.value ?? value
      this.punchSpec(spec, fromBeat, beat, fromValue, value)
      this.write = { key, beat, value, spec }
    })
  }

  sustainAutomation(sample: number) {
    if (modeOf(this.project) !== 'latch' || !this.write || this.touching) return
    const beat = projectSampleBeat(this.project, sample)
    if (beat <= this.write.beat + 0.02) return
    const cursor = this.write
    this.draft(() => {
      this.punchSpec(cursor.spec, cursor.beat, beat, cursor.value, cursor.value)
      cursor.beat = beat
    })
  }

  finishAutomationLatch() {
    if (!this.write && !this.touching) return
    this.write = null
    this.touching = false
  }

  paintAutomation(spec: AutoSpec, beat: number, value: number, radius = 0.03) {
    this.draft(() => {
      this.setPoints(spec, drawPoint(this.pointsOf(spec), Math.max(0, beat), clamp(value, spec.min, spec.max), radius))
    })
  }

  eraseAutomation(spec: AutoSpec, beat: number, radius: number) {
    this.draft(() => {
      this.setPoints(spec, eraseNear(this.pointsOf(spec), beat, radius))
    })
  }

  moveAutomationPoint(spec: AutoSpec, fromBeat: number, toBeat: number, value: number) {
    this.draft(() => {
      this.setPoints(spec, movePoint(this.pointsOf(spec), fromBeat, Math.max(0, toBeat), clamp(value, spec.min, spec.max)))
    })
  }

  private applySpec(spec: AutoSpec, value: number) {
    const next = clamp(value, spec.min, spec.max)
    if (spec.target === 'volume') patchMixer(this.project, spec.trackId, { volume: next })
    else if (spec.target === 'pan') patchMixer(this.project, spec.trackId, { pan: next })
    else if (spec.target === 'send' && spec.sendId) {
      const send = this.track(spec.trackId)?.sends.find((item) => item.id === spec.sendId)
      if (send) send.gain = next
    } else if (spec.target === 'plugin' && spec.pluginId) {
      const plugin = this.pluginList(spec.trackId)?.find((item) => item.id === spec.pluginId)
      if (plugin) plugin.params = { ...plugin.params, [spec.param]: next }
    } else if (spec.target === 'instrument' && spec.deviceId) {
      const device = this.track(spec.trackId)?.rack?.devices.find((item) => item.id === spec.deviceId)
      if (device) device.params = { ...device.params, [spec.param]: next }
    }
  }

  private pointsOf(spec: AutoSpec) {
    if (spec.target === 'instrument' && spec.deviceId) {
      return this.project.rackAutomation.find((lane) => lane.deviceId === spec.deviceId && lane.param === spec.param)?.points ?? []
    }
    return findLane(this.project, spec)?.points ?? []
  }

  private setPoints(spec: AutoSpec, points: { beat: number; value: number }[]) {
    if (spec.target === 'instrument' && spec.deviceId) {
      let lane = this.project.rackAutomation.find((item) => item.deviceId === spec.deviceId && item.param === spec.param)
      if (!lane) {
        lane = { id: uid('auto'), deviceId: spec.deviceId, param: spec.param, points: [] }
        this.project.rackAutomation.push(lane)
      }
      lane.points = points
      return
    }
    ensureLane(this.project, spec, uid('auto')).points = points
  }

  private punchSpec(spec: AutoSpec, fromBeat: number, toBeat: number, fromValue: number, toValue: number) {
    this.setPoints(spec, writeSegment(this.pointsOf(spec), fromBeat, toBeat, fromValue, toValue))
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
      this.offerSmartTempo(trackId, clip)
    })
  }

  private offerSmartTempo(trackId: string, clip: AudioClip) {
    if (clip.slotOnly || (clip.source !== 'import' && clip.source !== 'local')) return
    const bpm = clip.stretch?.sourceBpm
    if (bpm == null || Math.abs(bpm - this.project.tempo) < 0.5) return
    this.smartTempo = { trackId, clipId: clip.id, bpm }
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
        for (const track of this.project.tracks) {
          for (const clip of track.clips) {
            if (!audio.has(clip.id)) continue
            for (const other of linkedAudioTargets(this.project, track.id, clip)) audio.add(other.id)
          }
        }
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
    const selected = this.selectedClipId
    this.mutate(() => {
      for (const track of this.project.tracks) {
        const id = splitLinkedAudio(this.project, track.id, selected, atSample)
        if (!id) continue
        this.selectedClipId = id
        return
      }
    })
  }

  moveClip(trackId: string, clipId: string, startSample: number) {
    this.mutate(() => {
      shiftLinkedAudio(this.project, trackId, clipId, startSample)
    })
  }

  stretchClip(trackId: string, clipId: string, edge: 'start' | 'end', sample: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.clips.find((item) => item.id === clipId)
      if (!clip) return
      const original = { ...clip }
      const edgeAt = edge === 'start' ? clip.startSample : clip.startSample + clip.durationSamples
      const delta = sample - edgeAt
      Object.assign(clip, stretchEdge(clip, edge, sample))
      this.commitClip(clip)
      if (!delta || !groupForTrack(this.project, trackId)?.edits) return
      for (const other of linkedAudioTargets(this.project, trackId, original)) {
        const next = edge === 'start' ? other.startSample + delta : other.startSample + other.durationSamples + delta
        Object.assign(other, stretchEdge(other, edge, next))
        this.commitClip(other)
      }
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
      const at = snapSampleToMap(sample, this.project)
      const ids = new Set(trimLinkedAudio(this.project, trackId, clipId, edge, at, (clip) => {
        const asset = this.buffers.get(clip.bufferId)
        return asset?.channels[0].length ?? clip.offsetSamples + clip.durationSamples
      }))
      for (const track of this.project.tracks) {
        for (const clip of track.clips) if (ids.has(clip.id)) this.commitClip(clip)
      }
    })
  }

  placeAudioClips(moves: { trackId: string; clipId: string; startSample: number }[]) {
    this.mutate(() => {
      const done = new Set<string>()
      for (const move of moves) {
        if (done.has(move.clipId)) continue
        const clip = this.track(move.trackId)?.clips.find((item) => item.id === move.clipId)
        if (!clip) continue
        const start = snapSampleToMap(move.startSample, this.project)
        for (const id of shiftLinkedAudio(this.project, move.trackId, move.clipId, start)) done.add(id)
      }
    })
  }

  placeMidiClips(moves: { trackId: string; clipId: string; startBeat: number }[]) {
    this.mutate(() => {
      const done = new Set<string>()
      for (const move of moves) {
        if (done.has(move.clipId)) continue
        const start = this.project.snap ? Math.max(0, Math.round(move.startBeat)) : Math.max(0, move.startBeat)
        for (const id of shiftLinkedMidi(this.project, move.trackId, move.clipId, start)) done.add(id)
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
      const nextBeat = snappedClipBeat(this.project, beat)
      trimLinkedMidi(this.project, trackId, clipId, edge, nextBeat, stretch)
    })
  }

  splitAt(trackId: string, clipId: string, atSample: number) {
    this.mutate(() => {
      const audioId = splitLinkedAudio(this.project, trackId, clipId, atSample)
      if (audioId) {
        this.selectedClipId = audioId
        this.selectedClipIds = [audioId]
        return
      }
      const beat = projectSampleBeat(this.project, atSample)
      const midiId = splitLinkedMidi(this.project, trackId, clipId, beat)
      if (!midiId) return
      this.selectedMidiClipId = midiId
      this.selectedMidiClipIds = [midiId]
    })
  }

  drawRegion(trackId: string, startSample: number, endSample: number) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track) return
      const a = snapSampleToMap(Math.min(startSample, endSample), this.project)
      let b = snapSampleToMap(Math.max(startSample, endSample), this.project)
      const quarter = beatsToSamples(1, this.project.sampleRate, tempoAtSample(this.project, a))
      if (b - a < quarter / 4) b = a + quarter
      this.selectedTrackId = trackId
      if (track.type === 'midi') {
        const startBeat = projectSampleBeat(this.project, a)
        const endBeat = projectSampleBeat(this.project, b)
        const clip: MidiClip = {
          id: uid('midi'),
          name: 'MIDI',
          startBeat,
          durationBeats: Math.max(0.25, endBeat - startBeat),
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
      this.buffers.set(bufferId, { id: bufferId, name: 'Clip', sampleRate: this.project.sampleRate, channels: [new Float32Array(duration)] })
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

  addPerformedNotes(trackId: string, clipId: string, notes: Omit<MidiNote, 'id'>[], mode: 'overdub' | 'replace' = 'overdub', fixedBeats = 0, coalesce = false) {
    if (!notes.length) return
    const write = () => {
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
    }
    if (coalesce) this.draft(write)
    else this.mutate(write)
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
      if (!track) return
      patchMixer(this.project, id, { [flag]: !track[flag] })
    })
  }

  addNote(trackId: string, clipId: string, note: Omit<MidiNote, 'id'>) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((c) => c.id === clipId)
      if (!clip) return
      const scale = this.scaleState()
      const drafted: MidiNote = { ...note, id: uid('note') }
      if (scale.snap) {
        const tone = lockedTone(note.pitch, note.fine ?? 0, scale)
        drafted.pitch = tone.midi
        if (scale.library || scaleIsMicrotonal(scale)) applyFine(drafted, tone.cents)
      }
      const next = this.inputNote(clip, drafted)
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
      let pitch = patch.pitch == null ? note.pitch : patch.pitch
      let fine = patch.fine == null ? note.fine : patch.fine
      if (scale.snap && patch.pitch != null) {
        const tone = lockedTone(pitch, fine ?? 0, scale)
        pitch = tone.midi
        if (scale.library || scaleIsMicrotonal(scale)) fine = tone.cents || undefined
      }
      if (patch.startBeat != null || patch.pitch != null) {
        Object.assign(note, moveMidiNote(note, patch.startBeat ?? note.startBeat, pitch))
      }
      if (patch.pitch != null && (scale.library || scaleIsMicrotonal(scale))) applyFine(note, fine ?? 0)
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
    this.project.scale = { ...scale, lastVoicing: voiced, lastCents: voiced.map(() => 0) }
  }

  /**
   * Write voiced tones onto the selected MIDI clip in one undo step.
   * `start` is beats from the end of the notes already in the clip.
   */
  insertLibrary(events: { midi: number; cents: number; start: number; duration: number }[], name = 'Chords') {
    if (!events.length) return
    this.mutate(() => {
      const located = this.libraryClip(name)
      const clip = located.clip
      const origin = clip.notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0)
      const ids: string[] = []
      for (const event of events) {
        const note: MidiNote = {
          id: uid('note'),
          pitch: event.midi,
          startBeat: origin + event.start,
          durationBeats: Math.max(0.05, event.duration),
          velocity: 0.8,
        }
        if (event.cents) note.fine = Math.max(-100, Math.min(100, Math.round(event.cents)))
        clip.notes.push(note)
        ids.push(note.id)
      }
      const end = clip.notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), clip.durationBeats)
      clip.durationBeats = Math.max(clip.durationBeats, Math.ceil(end * 4) / 4)
      this.selectedNoteIds = ids
      this.selectedNoteId = ids.at(-1) ?? null
      this.selectedMidiClipId = clip.id
      this.selectedTrackId = located.track.id
      const lastStart = Math.max(...events.map((event) => event.start))
      const last = events.filter((event) => event.start === lastStart)
      const scale = this.scaleState()
      this.project.scale = { ...scale, lastVoicing: last.map((tone) => tone.midi), lastCents: last.map((tone) => tone.cents) }
    })
  }

  private libraryClip(name: string) {
    const selected = this.selectedMidiClipId
      ? this.project.tracks.find((track) => track.midiClips.some((clip) => clip.id === this.selectedMidiClipId))
      : undefined
    if (selected) {
      const clip = selected.midiClips.find((item) => item.id === this.selectedMidiClipId)
      if (clip) return { track: selected, clip }
    }
    const track = this.selectedTrackId ? this.track(this.selectedTrackId) : undefined
    const host = track?.type === 'midi' ? track : this.ensureMidi(name, '#e0b15a')
    const clip: MidiClip = { id: uid('midi'), name, startBeat: 0, durationBeats: 4, notes: [] }
    host.midiClips.push(clip)
    return { track: host, clip }
  }

  /** Insert one Unstuck suggestion. Undo restores the project. */
  applyUnstuck(suggestion: Suggestion) {
    this.mutate(() => {
      const placed = applySuggestion(this.project, suggestion)
      if (placed.trackId) this.selectedTrackId = placed.trackId
      if (placed.clipId) {
        this.selectedMidiClipId = placed.clipId
        this.selectedMidiClipIds = [placed.clipId]
        this.selectedNoteId = null
        this.selectedNoteIds = []
      }
    })
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

  generatorState() {
    return normalizeGenerator(this.project.generator)
  }

  playerState() {
    return normalizePlayer(this.project.players)
  }

  setPlayers(patch: Partial<PlayerSettings>, draft = false) {
    const apply = () => {
      this.project.players = normalizePlayer({ ...this.playerState(), ...patch })
    }
    if (draft) this.draft(apply)
    else this.mutate(apply)
  }

  /** Write the drummer and session players as editable MIDI. One undo step. */
  writeSession(found?: SessionDetection, seed?: number) {
    if (this.remoteFollow) return
    const settings = normalizePlayer({ ...this.playerState(), ...(seed == null ? {} : { seed }) })
    const built = buildSession(this.project, settings, found)
    if (!built.parts.length) {
      this.toast('Pick drums, bass, or keys.', 'warn')
      return
    }
    this.mutate(() => {
      this.project.players = settings
      let selected: { trackId: string; clipId: string; noteIds: string[] } | null = null
      for (const part of built.parts) {
        const placed = this.placePlayer(part)
        if (part.role === 'drums' || !selected) selected = placed
      }
      if (selected) {
        this.selectedTrackId = selected.trackId
        this.selectedMidiClipId = selected.clipId
        this.selectedMidiClipIds = [selected.clipId]
        this.selectedNoteIds = selected.noteIds
        this.selectedNoteId = selected.noteIds.at(-1) ?? null
      }
      this.toast(built.summary)
    })
  }

  setGenerator(patch: Partial<import('../generators/types').GeneratorSettings>, draft = false) {
    const apply = () => {
      this.project.generator = normalizeGenerator({ ...this.generatorState(), ...patch })
    }
    if (draft) this.draft(apply)
    else this.mutate(apply)
  }

  /** Remember a heard progression without an undo step, so the next part can follow it. */
  rememberChords(chords: import('../generators/types').GeneratorChord[]) {
    const current = this.generatorState()
    if (JSON.stringify(current.chords) === JSON.stringify(chords)) return
    this.project.generator = { ...current, chords }
    this.emit()
  }

  /** Drop generated MIDI on the part's track, or on a fresh one. Notes stay editable. */
  insertGenerated(part: GeneratedPart, where: 'part' | 'new' = 'part') {
    this.mutate(() => {
      const color = GENERATED_COLOR[part.kind]
      let track
      if (where === 'new') {
        track = makeTrack({
          name: this.freshName(part.trackName),
          type: 'midi',
          color,
          input: 'none',
          instrument: part.instrument,
        })
        this.project.tracks.push(track)
      } else {
        track = this.ensureMidi(part.trackName, color)
        if (part.instrument === 'drum-machine' && (!track.instrument || track.instrument === 'none')) track.instrument = 'drum-machine'
        if (part.instrument === '808' && (!track.instrument || track.instrument === 'none')) track.instrument = '808'
      }
      const span = Math.max(1, part.bars * quartersPerBar(this.project.timeSignature))
      const end = part.notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), span)
      const last = track.midiClips.reduce((max, clip) => Math.max(max, clip.startBeat + clip.durationBeats), 0)
      const clip: MidiClip = {
        id: uid('midi'),
        name: part.name,
        startBeat: track.midiClips.length ? last : 0,
        durationBeats: Math.max(span, Math.ceil(end * 4) / 4),
        notes: part.notes.map((note) => ({
          id: uid('note'),
          pitch: note.pitch,
          startBeat: note.startBeat,
          durationBeats: note.durationBeats,
          velocity: note.velocity,
          ...(note.fine ? { fine: note.fine } : {}),
          ...(note.slide ? { slide: true } : {}),
        })),
      }
      track.midiClips.push(clip)
      this.selectedTrackId = track.id
      this.selectedMidiClipId = clip.id
      this.selectedMidiClipIds = [clip.id]
      this.selectedNoteIds = clip.notes.map((note) => note.id)
      this.selectedNoteId = clip.notes.at(-1)?.id ?? null
      if (part.kind === 'chords') this.project.generator = { ...this.generatorState(), chords: part.chords }
      this.toast(`Added ${part.name}`)
    })
  }

  private placePlayer(part: SessionPart) {
    const track = this.ensureMidi(part.trackName, part.color)
    if (part.instrument === 'drum-machine') track.instrument = 'drum-machine'
    else if (part.instrument === '808' && (!track.instrument || track.instrument === 'none' || track.instrument === 'synth')) track.instrument = '808'
    else if (!track.instrument || track.instrument === 'none') track.instrument = part.instrument
    track.midiClips = track.midiClips.filter((clip) => !samePlayer(clip.name, part.role))
    const end = part.notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), part.durationBeats)
    const notes: MidiNote[] = part.notes.map((note) => ({
      id: uid('note'),
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
      ...(note.fine ? { fine: note.fine } : {}),
      ...(note.slide ? { slide: true } : {}),
    }))
    const clip: MidiClip = {
      id: uid('midi'),
      name: part.clipName,
      startBeat: part.startBeat,
      durationBeats: Math.max(part.durationBeats, end),
      notes,
    }
    track.midiClips.push(clip)
    return { trackId: track.id, clipId: clip.id, noteIds: notes.map((note) => note.id) }
  }

  private freshName(base: string) {
    if (!this.project.tracks.some((track) => track.name === base)) return base
    let index = 2
    while (this.project.tracks.some((track) => track.name === `${base} ${index}`)) index += 1
    return `${base} ${index}`
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
      const playingId = this.launched[trackId]
      const playing = track && playingId ? clipById(track, playingId) : null
      const stopQuant = playing?.quant ?? this.project.launchQuant ?? '1bar'
      const plan = stopPlan({
        now: nowSample,
        launchAt: this.launchAt[trackId],
        hasClip: !!playingId,
        quant: stopQuant,
        sampleRate: this.project.sampleRate,
        tempo: this.project.tempo,
        sig: this.project.timeSignature,
      })
      if (!plan.immediate) {
        this.stopAt = { ...this.stopAt, [trackId]: plan.when }
        this.transportMode = 'session'
        this.pendingTransport = null
        this.emit()
        return
      }
      launched[trackId] = null
      delete launchAt[trackId]
      const stopAt = { ...this.stopAt }
      delete stopAt[trackId]
      this.stopAt = stopAt
    } else if (clipId) {
      const stopAt = { ...this.stopAt }
      delete stopAt[trackId]
      this.stopAt = stopAt
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
    this.stopAt = {}
    this.transportMode = 'session'
    this.view = 'session'
    this.pendingTransport = { action: 'scene', scene, timelineSample: at, slots, gen: launchGen }
    this.emit()
  }

  /** Apply quantized stops. While stopped, a queued stop commits immediately. */
  tickSession(nowSample: number, rolling: boolean) {
    this.commitStops(nowSample, rolling)
    if (rolling) this.tickFollow(nowSample)
  }

  private commitStops(nowSample: number, rolling: boolean) {
    const ids = Object.keys(this.stopAt)
    if (!ids.length) return
    const due = ids.filter((id) => !rolling || nowSample + 1e-3 >= this.stopAt[id])
    if (!due.length) return
    const launched = { ...this.launched }
    const launchAt = { ...this.launchAt }
    const stopAt = { ...this.stopAt }
    const slots: TransportSlot[] = []
    for (const trackId of due) {
      const when = stopAt[trackId]
      launched[trackId] = null
      delete launchAt[trackId]
      delete stopAt[trackId]
      slots.push({ trackId, clipId: null, timelineSample: when })
    }
    this.launched = launched
    this.launchAt = launchAt
    this.stopAt = stopAt
    this.transportMode = 'session'
    this.pendingTransport = slots.length === 1
      ? { action: 'launch', trackId: slots[0].trackId, clipId: null, timelineSample: slots[0].timelineSample, gen: this.launchGen }
      : { action: 'scene', timelineSample: nowSample, slots, gen: this.launchGen }
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

  stopSession(nowSample = 0, rolling = false) {
    if (this.remoteFollow) return
    const quant = this.project.launchQuant ?? '1bar'
    const when = quantizeSample(nowSample, quant, this.project.sampleRate, this.project.tempo, this.project.timeSignature)
    const playing = Object.entries(this.launched).filter((entry) => !!entry[1])
    if (rolling && playing.length && when > nowSample + 0.5) {
      const stopAt = { ...this.stopAt }
      for (const [trackId] of playing) stopAt[trackId] = when
      this.stopAt = stopAt
      this.transportMode = 'session'
      this.emit()
      return
    }
    this.launched = {}
    this.launchAt = {}
    this.stopAt = {}
    this.transportMode = 'session'
    this.pendingTransport = { action: 'stop-clips' }
    this.emit()
  }

  armArrangement() {
    this.launched = {}
    this.launchAt = {}
    this.stopAt = {}
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
    this.stopAt = {}
    this.transportMode = 'arrangement'
    this.view = 'arrange'
    this.pendingTransport = { action: 'back' }
    this.emit()
  }

  replaceSession(next: SessionClock) {
    this.launched = { ...next.launched }
    this.launchAt = { ...next.at }
    this.launchGen = { ...next.gen }
    this.stopAt = {}
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
      if (clip.loop == null) clip.loop = true
      clip.slotOnly = true
      track.clips.push(clip)
      track.audioSlots![scene] = clip.id
      this.selectedClipId = clip.id
      this.selectedTrackId = trackId
      this.sessionSlot = null
    })
  }

  copyIntoSlot(trackId: string, scene: number, fromTrackId: string, clipId: string) {
    const dest = this.track(trackId)
    const src = this.track(fromTrackId)
    if (!dest || !src) return
    if (dest.type !== src.type) {
      this.toast('That clip needs the same kind of track.', 'warn')
      return
    }
    const clip = clipById(src, clipId)
    if (!clip) return
    this.mutate(() => {
      const target = this.track(trackId)
      if (!target) return
      this.ensureSlots(target, scene)
      if ('bufferId' in clip && target.type === 'audio') {
        const copy: AudioClip = {
          ...clip,
          id: uid('clip'),
          loop: true,
          slotOnly: true,
          startSample: 0,
        }
        target.clips.push(copy)
        target.audioSlots![scene] = copy.id
        this.selectedClipId = copy.id
      } else if (target.type === 'midi' && !('bufferId' in clip)) {
        const midi = clip as MidiClip
        const copy: MidiClip = {
          ...midi,
          id: uid('midi'),
          loop: true,
          slotOnly: true,
          startBeat: 0,
          notes: midi.notes.map((note) => ({ ...note, id: uid('note') })),
        }
        target.midiClips.push(copy)
        target.midiSlots![scene] = copy.id
        this.selectedMidiClipId = copy.id
      }
      this.selectedTrackId = trackId
      this.sessionEdit = { trackId, scene }
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
    this.sync.rebase(this.project)
    this.emit()
  }

  track(id: string) {
    return this.project.tracks.find((t) => t.id === id)
  }

  retargetSampleRate(rate: number) {
    if (this.project.sampleRate === rate) return
    const ratio = rate / this.project.sampleRate
    for (const asset of this.buffers.values()) {
      if (isPackAsset(asset)) continue
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
    this.scalerTrackId = null
    this.rackTrackId = this.rackTrackId === trackId ? null : trackId
    this.rackFlip = false
    this.rackDetail = false
    this.emit()
  }

  openPatch(trackId: string) {
    if (this.patchTrackId === trackId) {
      this.patchTrackId = null
      this.emit()
      return
    }
    this.patchTrackId = trackId
    const track = this.track(trackId)
    if (track?.type === 'midi' && !track.omniPatch) {
      this.mutate(() => {
        track.omniPatch = emptyOmni(track.name)
      })
      return
    }
    this.emit()
  }

  updateOmni(trackId: string, fn: (patch: OmniPatch) => void, draft = false) {
    const run = () => {
      const track = this.track(trackId)
      if (!track?.omniPatch || track.type !== 'midi') return
      fn(track.omniPatch)
    }
    if (draft) this.draft(run)
    else this.mutate(run)
  }

  saveOmniPatch(trackId: string) {
    this.mutate(() => {
      const patch = this.track(trackId)?.omniPatch
      if (!patch) return
      const copy = cloneOmni(patch, true)
      copy.name = patch.name.trim() || 'Patch'
      const library = (this.project.omniLibrary ?? []).filter((item) => item.name !== copy.name)
      this.project.omniLibrary = [...library, copy]
    })
  }

  loadOmniPatch(trackId: string, id: string) {
    this.mutate(() => {
      const found = this.project.omniLibrary?.find((item) => item.id === id)
      const track = this.track(trackId)
      if (!found || track?.type !== 'midi') return
      const copy = cloneOmni(found, true)
      copy.name = found.name
      track.omniPatch = copy
    })
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

  toggleSoundFavorite(id: string) {
    const key = id.trim()
    if (!key) return
    this.mutate(() => {
      const list = this.project.soundFavorites ?? []
      this.project.soundFavorites = list.includes(key) ? list.filter((item) => item !== key) : [...list, key]
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

  midiEditor(): MidiEditorPrefs {
    return normalizeMidiEditor(this.project.midiEditor)
  }

  setMidiEditor(patch: Partial<MidiEditorPrefs>, drag = false) {
    const run = (body: () => void) => (drag ? this.draft(body) : this.mutate(body))
    run(() => {
      this.project.midiEditor = normalizeMidiEditor({ ...normalizeMidiEditor(this.project.midiEditor), ...patch })
    })
  }

  /** Notes played together land on the step cursor, then the cursor advances. */
  enterSteps(trackId: string, clipId: string, pitches: StepTone[]) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track?.midiClips.find((item) => item.id === clipId)
      if (!track || !clip || !pitches.length) return
      const editor = normalizeMidiEditor(this.project.midiEditor)
      const scale = this.scaleState()
      const tones = pitches.map((tone) => {
        if (isDrumTrack(track) || !scale.snap) return tone
        const locked = lockedTone(tone.pitch, tone.fine ?? 0, scale)
        const next: StepTone = { ...tone, pitch: locked.midi }
        if (scale.library || scaleIsMicrotonal(scale)) next.fine = locked.cents || undefined
        return next
      })
      const placed = placeStep(clip.notes, editor.cursor, tones, editor.step, editor.velocity, editor.tie, () => uid('note'))
      clip.notes = placed.notes.map((note) => {
        if (!note.fine) return note
        const copy = { ...note }
        applyFine(copy, note.fine)
        return copy
      })
      clip.durationBeats = Math.max(clip.durationBeats, placed.cursor)
      this.project.midiEditor = normalizeMidiEditor({ ...editor, cursor: placed.cursor })
      if (placed.ids.length) {
        this.selectedNoteId = placed.ids[0]
        this.selectedNoteIds = placed.ids
      }
    })
  }

  restStep(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const editor = normalizeMidiEditor(this.project.midiEditor)
      const cursor = editor.cursor + editor.step
      clip.durationBeats = Math.max(clip.durationBeats, cursor)
      this.project.midiEditor = normalizeMidiEditor({ ...editor, cursor })
    })
  }

  tieStep(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const editor = normalizeMidiEditor(this.project.midiEditor)
      const tied = tieHeld(clip.notes, editor.cursor, editor.step)
      if (!tied.tied) {
        this.project.midiEditor = normalizeMidiEditor({ ...editor, tie: !editor.tie })
        return
      }
      clip.notes = tied.notes
      clip.durationBeats = Math.max(clip.durationBeats, tied.cursor)
      this.project.midiEditor = normalizeMidiEditor({ ...editor, cursor: tied.cursor })
    })
  }

  stepBack() {
    this.mutate(() => {
      const editor = normalizeMidiEditor(this.project.midiEditor)
      this.project.midiEditor = normalizeMidiEditor({ ...editor, cursor: Math.max(0, editor.cursor - editor.step) })
    })
  }

  clearCursor(trackId: string, clipId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const editor = normalizeMidiEditor(this.project.midiEditor)
      clip.notes = clearStep(clip.notes, editor.cursor, editor.step)
    })
  }

  setDrumHit(trackId: string, clipId: string, pitch: number, step: number, patch: { on?: boolean; velocity?: number; flam?: boolean; roll?: number }, drag = false) {
    const run = (body: () => void) => (drag ? this.draft(body) : this.mutate(body))
    run(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const beat = step * DRUM_STEP
      let note = hitAt(clip.notes, pitch, step)
      if (patch.on === false) {
        if (!note) return
        const id = note.id
        clip.notes = clip.notes.filter((item) => item.id !== id)
        if (this.selectedNoteId === id) {
          this.selectedNoteId = null
          this.selectedNoteIds = []
        }
        return
      }
      if (!note) {
        note = {
          id: uid('note'),
          pitch,
          startBeat: beat,
          durationBeats: 0.2,
          velocity: clamp(patch.velocity ?? normalizeMidiEditor(this.project.midiEditor).velocity, 0.05, 1),
        }
        clip.notes.push(note)
        clip.durationBeats = Math.max(clip.durationBeats, beat + DRUM_STEP)
      }
      if (!note) return
      if (patch.velocity != null) note.velocity = clamp(patch.velocity, 0.05, 1)
      if (patch.flam != null) {
        if (patch.flam) note.flam = true
        else delete note.flam
      }
      if (patch.roll != null) {
        const rolls = clampRoll(patch.roll)
        if (rolls > 1) note.roll = rolls
        else delete note.roll
      }
      this.selectedNoteId = note.id
      this.selectedNoteIds = [note.id]
    })
  }

  setClipSwing(trackId: string, clipId: string, swing: number, drag = false) {
    const run = (body: () => void) => (drag ? this.draft(body) : this.mutate(body))
    run(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const value = clampSwing(swing)
      if (value <= 0) delete clip.swing
      else clip.swing = value
    })
  }

  putScoreNote(trackId: string, clipId: string, beat: number, pitch: number) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      const editor = normalizeMidiEditor(this.project.midiEditor)
      const start = Math.max(0, beat)
      const existing = clip.notes.find((note) => note.pitch === pitch && Math.abs(note.startBeat - start) < 0.02)
      if (existing) {
        this.selectedNoteId = existing.id
        this.selectedNoteIds = [existing.id]
        return
      }
      const note: MidiNote = {
        id: uid('note'),
        pitch: clamp(Math.round(pitch), 0, 127),
        startBeat: start,
        durationBeats: editor.scoreDuration,
        velocity: editor.velocity,
      }
      clip.notes.push(note)
      clip.durationBeats = Math.max(clip.durationBeats, note.startBeat + note.durationBeats)
      this.selectedNoteId = note.id
      this.selectedNoteIds = [note.id]
    })
  }

  editScoreNote(trackId: string, clipId: string, noteId: string, patch: { pitch?: number; durationBeats?: number }) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      const note = clip?.notes.find((item) => item.id === noteId)
      if (!clip || !note) return
      if (patch.pitch != null) note.pitch = clamp(Math.round(patch.pitch), 0, 127)
      if (patch.durationBeats != null) note.durationBeats = Math.max(0.125, patch.durationBeats)
      clip.durationBeats = Math.max(clip.durationBeats, note.startBeat + note.durationBeats)
      this.selectedNoteId = note.id
      this.selectedNoteIds = [note.id]
    })
  }

  removeScoreNote(trackId: string, clipId: string, noteId: string) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((item) => item.id === clipId)
      if (!clip) return
      clip.notes = clip.notes.filter((note) => note.id !== noteId)
      if (this.selectedNoteId === noteId) {
        this.selectedNoteId = null
        this.selectedNoteIds = []
      }
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
    return { tempo: this.project.tempo, root: scale.root, scale: scale.scale as ScaleId, library: scale.library, only }
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

  /** Replace the host's live guide for this take with the guest's aligned recording. */
  acceptAlignedTake(take: {
    peerId: string
    peerName: string
    takeId: string
    placeAtSample: number
    sampleRate: number
    channels: Float32Array[]
    compensationMs: number
    detail: string
    silent?: boolean
  }) {
    const parked: { trackId: string; scene: number }[] = []
    for (const track of this.project.tracks) {
      track.audioSlots?.forEach((id, scene) => {
        if (!id) return
        const clip = track.clips.find((item) => item.id === id)
        if (clip && clip.source === 'guide' && clip.takeId === take.takeId) parked.push({ trackId: track.id, scene })
      })
    }
    this.removeClips((clip) => clip.source === 'guide' && clip.takeId === take.takeId)
    this.dropGuideLanes(take.takeId)
    let track = this.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
    if (!track) {
      this.ensureRemoteTrack(take.peerId, take.peerName)
      track = this.project.tracks.find((item) => item.input === `remote:${take.peerId}`)
    }
    if (!track || !take.channels[0]?.length) return
    const bufferId = uid('buf')
    this.addAsset({
      id: bufferId,
      name: `${take.peerName} take`,
      sampleRate: take.sampleRate,
      channels: take.channels,
    })
    this.addTakeLane(track.id, {
      id: uid('lane'),
      name: `${take.peerName} aligned`,
      bufferId,
      offsetSamples: 0,
      startSample: Math.max(0, Math.round(take.placeAtSample)),
      durationSamples: take.channels[0].length,
      peerId: take.peerId,
      takeId: take.takeId,
      source: 'aligned-take',
    })
    const placed = this.selectedClipId
    if (parked.length && placed) {
      this.mutate(() => {
        for (const slot of parked) {
          const row = this.track(slot.trackId)
          if (row?.audioSlots) row.audioSlots[slot.scene] = placed
        }
      })
    }
    this.toast(
      take.silent
        ? `${take.peerName} take arrived, but it is silent. Check their performance mic.`
        : `${take.peerName} aligned −${take.compensationMs.toFixed(0)} ms. ${take.detail}`,
      take.silent ? 'warn' : 'good',
    )
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

  setMidiToolsOpen(open: boolean) {
    this.midiToolsOpen = open
    if (!open) {
      this.midiLearnActive = false
      this.midiLearnSlot = null
    }
    this.emit()
  }

  setMidiLearn(active: boolean) {
    this.midiLearnActive = active
    if (!active) this.midiLearnSlot = null
    this.emit()
  }

  armLearn(slot: LearnSlot) {
    this.midiLearnActive = true
    this.midiLearnSlot = slot
    this.toast(`Learning ${slot.label}. Move a knob or play a key.`, 'info')
    this.emit()
  }

  completeLearn(message: ParsedMidi) {
    const slot = this.midiLearnSlot
    if (!slot || !this.midiLearnActive) return false
    this.mutate(() => {
      const entry = bindingFromMessage(slot, message, uid('map'))
      this.project.midiMaps = upsertMap(this.project.midiMaps ?? [], entry)
    })
    this.midiLearnActive = false
    this.midiLearnSlot = null
    this.toast(`Mapped ${slot.label}.`, 'good')
    return true
  }

  updateMidiMap(id: string, patch: Partial<MidiMapEntry>) {
    this.mutate(() => {
      const map = this.project.midiMaps?.find((item) => item.id === id)
      if (!map) return
      Object.assign(map, patch)
    })
  }

  clearMidiMap(id: string) {
    this.mutate(() => {
      this.project.midiMaps = (this.project.midiMaps ?? []).filter((item) => item.id !== id)
    })
  }

  clearMidiMaps() {
    this.mutate(() => {
      this.project.midiMaps = []
    })
  }

  setMidiOut(patch: Partial<MidiOutSettings>) {
    this.mutate(() => {
      this.project.midiOut = { enabled: false, port: '', channel: 0, clock: false, ...(this.project.midiOut || {}), ...patch }
    })
  }

  setLiveCapture(patch: Partial<LiveCaptureSettings>) {
    this.mutate(() => {
      const current = { enabled: true, bars: 4, ...(this.project.liveCapture || {}) }
      this.project.liveCapture = { ...current, ...patch, bars: Math.max(1, Math.min(32, Math.round((patch.bars ?? current.bars) || 4))) }
    })
  }

  currentControlValue(target: string) {
    return currentControl(this.project, target)
  }

  applyMidiControl(target: string, value: number, continuous = false) {
    if (Math.abs(currentControl(this.project, target) - value) < 1e-4) return
    if (target === 'transport:tempo') {
      this.setTempo(value, continuous)
      return
    }
    const write = () => {
      const action = describeWrite(target, value)
      if (!action) return
      if (action.kind === 'master') this.project.masterVolume = clamp(action.volume, 0, 1.25)
      else if (action.kind === 'flag') this.project[action.flag] = action.value
      else if (action.kind === 'track') {
        const track = this.track(action.id)
        if (!track) return
        if (action.key === 'volume') track.volume = clamp(action.value, 0, 1.25)
        else if (action.key === 'pan') track.pan = clamp(action.value, -1, 1)
        else if (action.key === 'mute') track.mute = action.value >= 0.5
        else if (action.key === 'solo') track.solo = action.value >= 0.5
        else track.armed = action.value >= 0.5
      } else if (action.kind === 'fx') {
        const effect = this.track(action.trackId)?.midiFx?.find((item) => item.id === action.fxId)
        if (effect) effect.params[action.param] = action.value
      }
    }
    if (continuous) this.draft(write)
    else this.mutate(write)
  }

  addMidiFx(trackId: string, kind: MidiFxKind) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      track.midiFx = [...(track.midiFx ?? []), defaultFx(kind, uid('fx'))]
    })
  }

  setMidiFx(trackId: string, fxId: string, patch: Partial<Pick<MidiFx, 'enabled'>> & { params?: Record<string, number> }) {
    this.mutate(() => {
      const effect = this.track(trackId)?.midiFx?.find((item) => item.id === fxId)
      if (!effect) return
      if (patch.enabled != null) effect.enabled = patch.enabled
      if (patch.params) effect.params = { ...effect.params, ...patch.params }
    })
  }

  moveMidiFx(trackId: string, fxId: string, direction: -1 | 1) {
    this.mutate(() => {
      const track = this.track(trackId)
      const list = track?.midiFx
      if (!list) return
      const index = list.findIndex((item) => item.id === fxId)
      const next = index + direction
      if (index < 0 || next < 0 || next >= list.length) return
      const [item] = list.splice(index, 1)
      list.splice(next, 0, item)
    })
  }

  removeMidiFx(trackId: string, fxId: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track?.midiFx) return
      track.midiFx = track.midiFx.filter((item) => item.id !== fxId)
    })
  }

  /** Bake the chain into the clip so the instrument sees the effected notes. */
  printMidiFx(trackId: string, clipId: string) {
    this.mutate(() => {
      const track = this.track(trackId)
      const clip = track?.midiClips.find((item) => item.id === clipId)
      if (!track || !clip) return
      const muted = clip.notes.filter((note) => note.muted).map((note) => ({ ...note }))
      const printed = applyMidiChain(clip.notes, track.midiFx, chainContext(this.project, clip.id))
      clip.notes = [...printed.map((note) => ({ ...note, id: uid('note') })), ...muted]
      let end = clip.durationBeats
      for (const note of clip.notes) end = Math.max(end, note.startBeat + note.durationBeats)
      clip.durationBeats = Math.max(0.25, end)
    })
  }

  placeMidiTake(
    trackId: string,
    startBeat: number,
    notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[],
    name = 'MIDI take',
  ) {
    if (!notes.length) return
    this.mutate(() => {
      const track = this.track(trackId)
      if (!track || track.type !== 'midi') return
      const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 0.25)
      const clip: MidiClip = {
        id: uid('midi'),
        name,
        startBeat: Math.max(0, startBeat),
        durationBeats: Math.max(0.25, end),
        notes: notes.map((note) => ({
          id: uid('note'),
          pitch: Math.max(0, Math.min(127, Math.round(note.pitch))),
          startBeat: Math.max(0, note.startBeat),
          durationBeats: Math.max(0.05, note.durationBeats),
          velocity: Math.max(0.05, Math.min(1, note.velocity)),
        })),
      }
      track.midiClips.push(clip)
      this.selectedTrackId = trackId
      this.selectedMidiClipId = clip.id
    })
  }

  applyInputRoutes(routes: { trackId: string; input: string; armed: boolean }[]) {
    if (!routes.length) return
    this.mutate(() => {
      for (const route of routes) {
        const track = this.track(route.trackId)
        if (!track) continue
        track.input = route.input
        track.armed = route.armed
      }
    })
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

function applyFine(note: { fine?: number }, cents: number) {
  if (cents) note.fine = Math.max(-100, Math.min(100, Math.round(cents)))
  else delete note.fine
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function uniqueIds(ids: string[]) {
  return [...new Set(ids)]
}

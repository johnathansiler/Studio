import { createPlugin, normalizeProject, presetParams } from '../audio/plugins/catalog'
import { findCycle, MASTER } from '../audio/routing'
import { insertIndex, tracksFor, type AddTrackSpec } from '../model/addTrack'
import { addLane, applyMidiPass, createFolder, flattenPieces, folderClip, folderSpan, quickPunch as quickPunchSettings, recallComp, recallMidiTake, renderComp, saveComp, swipeComp } from '../model/comp'
import { splitAudioClip, trimAudioClip, moveAudioClip, clampFade, moveMidiNote, resizeMidiNote } from '../model/clips'
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
import { progressionById, romanLine, starterParts } from '../model/progressions'
import { cloneRack, defaults, FACTORY_PRESETS, makeDevice, normalizeProjectRack, normalizeTrackRack, type DeviceKind } from '../model/rack'
import { normalizeScale, patternNotes, snapPitch, voiceChord, type PlayNote, type ScaleState } from '../model/scale'
import { createEmptyProject, defaultInsert, defaultRecord, makeTrack, uid, TRACK_COLORS } from '../model/types'
import type { AudioAsset, AudioClip, FollowAction, InsertType, LaunchMode, LaunchQuant, MidiClip, MidiNote, PluginInstance, Project, RecordSettings, TakeLane, Track } from '../model/types'
import { beatsToSamples, quartersPerBar, samplesToBeats } from '../model/time'
import { linearResample } from '../model/wav'

export type WorkspaceView = 'arrange' | 'mix' | 'session'

export interface Toast {
  id: string
  text: string
  tone?: 'info' | 'warn' | 'good'
}

type Listener = () => void

export class ProjectStore {
  project: Project
  buffers = new Map<string, AudioAsset>()
  selectedTrackId: string | null
  selectedClipId: string | null
  selectedMidiClipId: string | null
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
  /** Letter keys play notes while this is on, so tap-tempo stays off T. */
  keyboardMidi = false
  private tempoGroup = false
  toasts: Toast[] = []
  version = 0
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()

  /** Open plugin sheet. Not saved with the project. */
  pluginFocus: { trackId: string; pluginId: string } | null = null

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
    this.snapshot()
    fn()
    this.emit()
  }

  undo() {
    if (this.remoteFollow) return
    this.tempoGroup = false
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(JSON.stringify(this.project))
    this.project = JSON.parse(prev) as Project
    this.emit()
  }

  redo() {
    if (this.remoteFollow) return
    this.tempoGroup = false
    const next = this.future.pop()
    if (!next) return
    this.past.push(JSON.stringify(this.project))
    this.project = JSON.parse(next) as Project
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

  selectClip(trackId: string, clipId: string | null, midi = false) {
    this.selectedTrackId = trackId
    if (midi) {
      this.selectedMidiClipId = clipId
      this.selectedClipId = null
    } else {
      this.selectedClipId = clipId
      this.selectedNoteId = null
      this.selectedNoteIds = []
    }
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

  setTempo(tempo: number, group = false) {
    const value = clamp(Math.round(tempo * 10) / 10, 30, 300)
    if (group && this.tempoGroup) {
      if (this.remoteFollow || this.project.tempo === value) return
      this.project.tempo = value
      this.emit()
      return
    }
    this.mutate(() => {
      this.project.tempo = value
    })
    this.tempoGroup = group
  }

  endTempoGroup() {
    this.tempoGroup = false
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
      const at = insertIndex(this.project.tracks, this.selectedTrackId)
      this.project.tracks.splice(at, 0, ...made)
      this.selectedTrackId = made[0]?.id ?? this.selectedTrackId
      ids.push(...made.map((track) => track.id))
    })
    return ids
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
      if (this.selectedClipId) {
        for (const track of this.project.tracks) {
          track.clips = track.clips.filter((c) => c.id !== this.selectedClipId)
        }
        this.selectedClipId = null
      } else if (this.selectedNoteId && this.selectedMidiClipId) {
        for (const track of this.project.tracks) {
          const clip = track.midiClips.find((c) => c.id === this.selectedMidiClipId)
          if (clip) clip.notes = clip.notes.filter((n) => n.id !== this.selectedNoteId)
        }
        this.selectedNoteId = null
      } else if (this.selectedMidiClipId) {
        for (const track of this.project.tracks) {
          track.midiClips = track.midiClips.filter((c) => c.id !== this.selectedMidiClipId)
        }
        this.selectedMidiClipId = null
      }
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

  addNote(trackId: string, clipId: string, note: Omit<MidiNote, 'id'>) {
    this.mutate(() => {
      const clip = this.track(trackId)?.midiClips.find((c) => c.id === clipId)
      if (!clip) return
      const scale = this.scaleState()
      const pitch = scale.snap ? snapPitch(note.pitch, scale.root, scale.scale) : note.pitch
      const next = { ...note, pitch, id: uid('note') }
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
      const next: MidiNote = { ...note, id: uid('note'), startBeat: rel + note.startBeat }
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

  openRack(trackId: string) {
    this.rackTrackId = this.rackTrackId === trackId ? null : trackId
    this.rackFlip = false
    this.emit()
  }

  flipRack() {
    this.rackFlip = !this.rackFlip
    this.emit()
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

  recordSettings(): RecordSettings {
    return this.project.record || defaultRecord(this.project.loopEndSample)
  }

  setRecord(patch: Partial<RecordSettings>) {
    this.mutate(() => {
      this.project.record = { ...this.recordSettings(), ...patch }
    })
  }

  quickPunch(playhead: number, recording: boolean) {
    this.mutate(() => {
      this.project.record = quickPunchSettings(this.recordSettings(), playhead, this.project.sampleRate, this.project.tempo, this.project.timeSignature, recording)
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

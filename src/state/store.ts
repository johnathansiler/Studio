import { splitAudioClip, trimAudioClip, moveAudioClip, clampFade, moveMidiNote, resizeMidiNote } from '../model/clips'
import { demoMidiNotes } from '../model/demo'
import { createPlugin, normalizeProject, presetParams } from '../audio/plugins/catalog'
import { findCycle, MASTER } from '../audio/routing'
import { createEmptyProject, defaultInsert, makeTrack, uid, TRACK_COLORS } from '../model/types'
import type { AudioAsset, AudioClip, InsertType, MidiClip, MidiNote, PluginInstance, Project, Track } from '../model/types'
import { starterLoom, type LoomState } from '../model/loom'
import { emptySounds, type SoundPersonal } from '../model/sounds'
import { normalizeScale, patternNotes, snapPitch, voiceChord, type PlayNote, type ScaleState } from '../model/scale'
import { beatsToSamples } from '../model/time'
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
  transportMode: 'arrangement' | 'session' = 'arrangement'
  /** Guests mirror the host arrangement and cannot edit it. */
  remoteFollow = false
  toasts: Toast[] = []
  version = 0
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()

  /** Open plugin sheet. Not saved with the project. */
  pluginFocus: { trackId: string; pluginId: string } | null = null

  constructor(project = createEmptyProject(), buffers?: Map<string, AudioAsset>) {
    this.project = normalizeProject({ ...project, scale: normalizeScale(project.scale) })
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
    const prev = this.past.pop()
    if (!prev) return
    this.future.push(JSON.stringify(this.project))
    this.project = JSON.parse(prev) as Project
    this.emit()
  }

  redo() {
    if (this.remoteFollow) return
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

  ensureLoom() {
    if (this.project.loom) return
    this.mutate(() => {
      this.project.loom = starterLoom()
    })
  }

  soundState() {
    return this.project.sounds ?? emptySounds()
  }

  setSounds(next: SoundPersonal) {
    this.mutate(() => {
      this.project.sounds = next
    })
  }

  setLoom(next: LoomState, record = true) {
    const apply = () => {
      this.project.loom = next
    }
    if (!record) {
      if (this.remoteFollow) return
      apply()
      this.emit()
      return
    }
    this.mutate(apply)
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

  setTempo(tempo: number) {
    this.mutate(() => {
      this.project.tempo = clamp(tempo, 40, 300)
    })
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

  addTrack(type: Track['type']) {
    this.mutate(() => {
      const index = this.project.tracks.length
      const track = makeTrack({
        name: type === 'midi' ? `Inst ${index + 1}` : type === 'bus' ? `Bus ${index + 1}` : type === 'group' ? `Group ${index + 1}` : `Audio ${index + 1}`,
        type,
        color: TRACK_COLORS[index % TRACK_COLORS.length],
      })
      this.project.tracks.push(track)
      this.selectedTrackId = track.id
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

  launch(trackId: string, clipId: string | null) {
    this.launched = { ...this.launched, [trackId]: clipId }
    this.transportMode = 'session'
    this.emit()
  }

  stopSession() {
    this.launched = {}
    this.emit()
  }

  armArrangement() {
    this.launched = {}
    this.transportMode = 'arrangement'
    this.emit()
  }

  loadProject(project: Project, buffers: Map<string, AudioAsset>) {
    this.past = []
    this.future = []
    this.project = normalizeProject({ ...project, scale: normalizeScale(project.scale) })
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

  findClip(clipId: string) {
    for (const track of this.project.tracks) {
      const clip = track.clips.find((c) => c.id === clipId)
      if (clip) return { track, clip }
    }
    return null
  }
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

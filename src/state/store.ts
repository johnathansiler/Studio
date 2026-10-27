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
import { createEmptyProject, defaultInsert, makeTrack, uid, TRACK_COLORS } from '../model/types'
import type { AudioAsset, AudioClip, FollowAction, InsertType, LaunchMode, LaunchQuant, MidiClip, MidiNote, Project, Track } from '../model/types'
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
  toasts: Toast[] = []
  version = 0
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()

  constructor(project = createEmptyProject(), buffers?: Map<string, AudioAsset>) {
    this.project = project
    if (buffers) this.buffers = buffers
    this.selectedTrackId = project.tracks[0]?.id ?? null
    this.selectedClipId = null
    this.selectedMidiClipId = null
    this.selectedNoteId = null
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
    }
    this.emit()
  }

  selectNote(id: string | null) {
    this.selectedNoteId = id
    this.emit()
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
        name: type === 'midi' ? `Inst ${index + 1}` : `Audio ${index + 1}`,
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
    this.mutate(() => {
      const track = this.track(id)
      if (!track) return
      Object.assign(track, patch)
    })
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
      const next = { ...note, id: uid('note') }
      clip.notes.push(next)
      this.selectedNoteId = next.id
    })
  }

  updateNote(trackId: string, clipId: string, noteId: string, patch: Partial<MidiNote>) {
    this.mutate(() => {
      const note = this.track(trackId)?.midiClips.find((c) => c.id === clipId)?.notes.find((n) => n.id === noteId)
      if (!note) return
      if (patch.startBeat != null || patch.pitch != null) {
        Object.assign(note, moveMidiNote(note, patch.startBeat ?? note.startBeat, patch.pitch ?? note.pitch))
      }
      if (patch.durationBeats != null) Object.assign(note, resizeMidiNote(note, patch.durationBeats))
      if (patch.velocity != null) note.velocity = patch.velocity
    })
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
    this.project = project
    this.buffers = buffers
    this.selectedTrackId = project.tracks[0]?.id ?? null
    this.selectedClipId = null
    this.selectedMidiClipId = null
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

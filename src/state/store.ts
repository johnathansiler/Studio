import { splitAudioClip, trimAudioClip, moveAudioClip, clampFade, moveMidiNote, resizeMidiNote } from '../model/clips'
import { demoMidiNotes } from '../model/demo'
import { createEmptyProject, defaultInsert, makeTrack, uid, TRACK_COLORS } from '../model/types'
import { cloneRack, defaults, FACTORY_PRESETS, makeDevice, normalizeProjectRack, type DeviceKind } from '../model/rack'
import type { AudioAsset, AudioClip, InsertType, MidiClip, MidiNote, Project, Track } from '../model/types'
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
  view: WorkspaceView = 'arrange'
  launched: Record<string, string | null> = {}
  transportMode: 'arrangement' | 'session' = 'arrangement'
  /** Guests mirror the host arrangement and cannot edit it. */
  remoteFollow = false
  rackTrackId: string | null = null
  rackFlip = false
  toasts: Toast[] = []
  version = 0
  private past: string[] = []
  private future: string[] = []
  private listeners = new Set<Listener>()

  constructor(project = createEmptyProject(), buffers?: Map<string, AudioAsset>) {
    this.project = normalizeProjectRack(project)
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
    this.project = normalizeProjectRack(project)
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
      let lane = this.project.automation.find((item) => item.deviceId === deviceId && item.param === param)
      if (!lane) {
        lane = { id: uid('auto'), deviceId, param, points: [] }
        this.project.automation.push(lane)
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

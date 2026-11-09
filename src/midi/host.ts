import type { AudioEngine } from '../audio/engine'
import { FEATURES } from '../features'
import { heardBeat, midiPerformanceMs } from '../model/midiClock'
import {
  applyMapped,
  clockIntervalMs,
  midiClockBytes,
  midiDestinations,
  parseMidi,
  type ParsedMidi,
} from '../model/midiTools'
import { samplesToBeats } from '../model/time'
import { selectLiveCapture, selectMidiMaps, selectMidiOut } from '../state/select'
import type { ProjectStore } from '../state/store'
import { playScalerLive } from '../instruments/scaler/live'
import { planLive } from '../instruments/scaler/route'
import { noteTarget } from '../model/noteTarget'
import { hardwareMidiAllowed, midiOutputs, onMidiMessage, onMidiPortEnd, type MidiPortInfo } from './access'
import { performanceOwnsMidi, rememberOff, rememberOn, setCaptureEnabled, stepOwnsMidi } from './remember'

interface OpenNote {
  trackId: string
  portId: string
  pitch: number
  startBeat: number
  velocity: number
  /** The key that started this note. A chord shares one source. */
  source: number
}

interface Voiced {
  portId: string
  trackId: string
  source: number
  pitches: number[]
}

/**
 * One Web MIDI listener for learn, mapped controls, live capture, multi-input
 * recording, and hardware output. Project edits go through the store.
 */
export class MidiHost {
  private unlisten: (() => void) | null = null
  private unsub: (() => void) | null = null
  private clock: ReturnType<typeof setInterval> | null = null
  private clockTempo = 0
  private recording = false
  private open: OpenNote[] = []
  /** Notes actually sounding, so note-off, stop, and a dropped port release the whole chord. */
  private voiced: Voiced[] = []
  private portUnlisten: (() => void) | null = null
  private takes = new Map<string, { pitch: number; startBeat: number; durationBeats: number; velocity: number }[]>()
  private draftTimer = 0

  constructor(
    private store: ProjectStore,
    private engine: AudioEngine,
  ) {}

  start(hideHardware: boolean) {
    this.stop()
    if (hideHardware || !hardwareMidiAllowed()) return
    this.unlisten = onMidiMessage((input, data, timeStamp) => this.onMessage(input, data, timeStamp))
    this.portUnlisten = onMidiPortEnd((input) => this.endInput(input))
    this.unsub = this.engine.subscribe(() => this.watchTransport())
    this.engine.midiSink = (bytes, time) => this.send(bytes, time)
    this.watchTransport()
  }

  stop() {
    const recording = this.recording || this.engine.status === 'recording'
    this.unlisten?.()
    this.unlisten = null
    this.portUnlisten?.()
    this.portUnlisten = null
    this.unsub?.()
    this.unsub = null
    this.stopClock()
    if (this.engine.midiSink) this.engine.midiSink = null
    if (recording) this.commitTakes()
    else this.releaseAllVoices()
    this.recording = false
  }

  send(bytes: number[], timeMs?: number) {
    const settings = selectMidiOut(this.store.project)
    if (!settings.enabled) return
    const ports = midiOutputs().filter((port) => !settings.port || port.id === settings.port || port.name === settings.port)
    for (const port of ports) port.send(bytes, timeMs)
  }

  private onMessage(input: MidiPortInfo, data: Uint8Array, timeStamp: number) {
    const message = parseMidi(data)
    if (!message) return
    if (this.store.midiLearnActive && this.store.midiLearnSlot && message.kind !== 'note-off') {
      this.store.completeLearn(message)
      return
    }
    if (message.kind === 'cc') {
      this.applyCc(message)
      return
    }
    if (performanceOwnsMidi() || stepOwnsMidi()) return
    const target = noteTarget(this.store.project.tracks, this.store.selectedTrackId)
    if (target.kind === 'silent') return
    if (target.kind === 'tune') {
      const held = message.kind === 'note-on' ? message.number : -1
      if (message.kind === 'note-on' || message.kind === 'note-off') {
        this.store.updatePlugin(target.trackId, target.pluginId, { params: { holdMidi: held } })
      }
      return
    }
    const recording = this.engine.status === 'recording'
    const dest = midiDestinations(this.store.project.tracks, input.id, this.store.selectedTrackId, recording)
    const beat = this.beatAt(timeStamp)
    if (message.kind === 'note-on') {
      this.noteOn(input.id, dest, message.number, message.value / 127, beat, recording)
      return
    }
    this.noteOff(input.id, dest, message.number, beat, recording)
  }

  /**
   * Sound dest.play only. Every dest.record id is captured, including a track that is not playing.
   * A track in both lists is sounded once and recorded once per pitch.
   */
  private noteOn(portId: string, dest: { play: string[]; record: string[] }, source: number, velocity: number, beat: number, recording: boolean) {
    const played = new Set<string>()
    for (const id of dest.play) {
      const pitches = this.sound(id, source, velocity)
      const dropped = this.replaceVoice(portId, id, source, pitches)
      for (const pitch of dropped) {
        this.engine.releaseThrough(id, pitch)
        if (!recording) rememberOff(id, pitch, beat)
      }
      played.add(id)
      if (!recording) {
        for (const pitch of pitches) rememberOn(id, pitch, beat, velocity)
      }
    }
    if (!recording) return
    for (const id of new Set(dest.record)) {
      this.closeRecorded([id], source, beat, portId)
      const pitches = played.has(id) ? this.voicePitches(portId, id, source) : this.capturePitches(id, source, velocity)
      for (const pitch of uniquePitches(pitches)) {
        this.open.push({ trackId: id, portId, pitch, startBeat: beat, velocity, source })
      }
    }
  }

  private noteOff(portId: string, dest: { play: string[]; record: string[] }, source: number, beat: number, recording: boolean) {
    for (const id of dest.play) {
      const pitches = this.takeVoice(portId, id, source) ?? [source]
      for (const pitch of pitches) {
        this.engine.releaseThrough(id, pitch)
        if (!recording) rememberOff(id, pitch, beat)
      }
    }
    if (recording) this.closeRecorded(dest.record, source, beat, portId)
  }

  /** Pitches a record-only track would store. Scaler can transpose them. This does not play the track. */
  private capturePitches(trackId: string, midi: number, velocity: number): number[] {
    const plan = planLive(this.store.project, trackId, midi, velocity)
    if (!plan) return [midi]
    return plan.record
  }

  /** Play a key. Scaler may turn it into a chord, or hide it. */
  private sound(trackId: string, midi: number, velocity: number): number[] {
    const live = playScalerLive(this.store.project, this.engine, trackId, midi, velocity)
    if (live === null) {
      this.engine.playThrough(trackId, midi, velocity)
      return [midi]
    }
    return live.map((note) => note.midi)
  }

  private applyCc(message: ParsedMidi) {
    let wrote = false
    for (const entry of selectMidiMaps(this.store.project)) {
      const next = applyMapped(entry, message, this.store.currentControlValue(entry.target))
      if (next == null) continue
      this.store.applyMidiControl(entry.target, next, entry.mode !== 'toggle')
      wrote = true
    }
    if (!wrote) return
    window.clearTimeout(this.draftTimer)
    this.draftTimer = window.setTimeout(() => {
      this.store.endDraft()
      this.store.endTempoGroup()
    }, 160)
  }

  private closeRecorded(trackIds: string[], pitch: number, beat: number, portId: string) {
    const wanted = new Set(trackIds)
    const keep: OpenNote[] = []
    for (const note of this.open) {
      if (note.source !== pitch || note.portId !== portId || !wanted.has(note.trackId)) {
        keep.push(note)
        continue
      }
      this.pushTake(note, beat)
    }
    this.open = keep
  }

  /** A port that drops releases what it was sounding and ends its open recorded notes. */
  private endInput(input: MidiPortInfo) {
    const beat = this.beatAt(performance.now())
    const recording = this.recording || this.engine.status === 'recording'
    const mine = this.voiced.filter((voice) => voice.portId === input.id)
    this.voiced = this.voiced.filter((voice) => voice.portId !== input.id)
    for (const voice of mine) {
      for (const pitch of voice.pitches) {
        this.engine.releaseThrough(voice.trackId, pitch)
        if (!recording) rememberOff(voice.trackId, pitch, beat)
      }
    }
    if (!recording) return
    const keep: OpenNote[] = []
    for (const note of this.open) {
      if (note.portId !== input.id) {
        keep.push(note)
        continue
      }
      this.pushTake(note, beat)
    }
    this.open = keep
  }

  private releaseAllVoices() {
    const beat = this.beatAt(performance.now())
    const recording = this.recording || this.engine.status === 'recording'
    const voices = this.voiced.splice(0)
    for (const voice of voices) {
      for (const pitch of voice.pitches) {
        this.engine.releaseThrough(voice.trackId, pitch)
        if (!recording) rememberOff(voice.trackId, pitch, beat)
      }
    }
  }

  private replaceVoice(portId: string, trackId: string, source: number, pitches: number[]): number[] {
    const index = this.voiceIndex(portId, trackId, source)
    const previous = index >= 0 ? this.voiced[index].pitches : []
    const next = { portId, trackId, source, pitches }
    if (index >= 0) this.voiced[index] = next
    else this.voiced.push(next)
    const kept = new Set(pitches)
    return previous.filter((pitch) => !kept.has(pitch))
  }

  private takeVoice(portId: string, trackId: string, source: number): number[] | null {
    const index = this.voiceIndex(portId, trackId, source)
    if (index < 0) return null
    const [found] = this.voiced.splice(index, 1)
    return found.pitches
  }

  private voicePitches(portId: string, trackId: string, source: number): number[] {
    return this.voiced.find((item) => item.portId === portId && item.trackId === trackId && item.source === source)?.pitches ?? []
  }

  private voiceIndex(portId: string, trackId: string, source: number) {
    return this.voiced.findIndex((item) => item.portId === portId && item.trackId === trackId && item.source === source)
  }

  private pushTake(note: OpenNote, beat: number) {
    const list = this.takes.get(note.trackId) || []
    list.push({
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: Math.max(0.05, beat - note.startBeat),
      velocity: note.velocity,
    })
    this.takes.set(note.trackId, list)
  }

  private watchTransport() {
    const settings = selectMidiOut(this.store.project)
    setCaptureEnabled(selectLiveCapture(this.store.project).enabled)
    this.engine.midiOutChannel = settings.channel
    const playing = this.engine.status === 'playing' || this.engine.status === 'recording'
    const wantClock = playing && settings.enabled && settings.clock
    if (wantClock && !this.clock) {
      this.send(midiClockBytes('start'))
      this.armClock()
    } else if (wantClock && this.clockTempo !== this.store.project.tempo) {
      this.armClock()
    } else if (!wantClock && this.clock) {
      this.stopClock()
      this.send(midiClockBytes('stop'))
    }
    const recording = this.engine.status === 'recording'
    if (this.recording && !recording) this.commitTakes()
    this.recording = recording
  }

  private commitTakes() {
    this.releaseAllVoices()
    const beat = samplesToBeats(this.engine.currentTimelineSample(), this.store.project.sampleRate, this.store.project.tempo)
    for (const note of this.open) this.pushTake(note, beat)
    this.open = []
    for (const [trackId, notes] of this.takes) {
      if (!notes.length) continue
      const slot = this.store.sessionSlot
      if (FEATURES.session && slot && slot.trackId === trackId) {
        const ordered = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
        this.store.overdubSlot(trackId, slot.scene, ordered, this.store.sessionRecordBeat ?? undefined)
        continue
      }
      const start = Math.min(...notes.map((note) => note.startBeat))
      const relative = notes
        .map((note) => ({ ...note, startBeat: Math.max(0, note.startBeat - start) }))
        .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
      this.store.placeMidiTake(trackId, Math.max(0, start), relative, 'MIDI take')
    }
    this.takes.clear()
  }

  private armClock() {
    this.stopClock()
    this.clockTempo = this.store.project.tempo
    const pulse = () => {
      const settings = selectMidiOut(this.store.project)
      if (!settings.enabled || !settings.clock) return
      this.send(midiClockBytes('pulse'))
    }
    this.clock = setInterval(pulse, clockIntervalMs(this.store.project.tempo))
  }

  private stopClock() {
    if (this.clock) clearInterval(this.clock)
    this.clock = null
  }

  private beatAt(timeStamp: number) {
    const now = performance.now()
    const eventMs = midiPerformanceMs(timeStamp, now)
    const origin = this.engine.playOrigin()
    const clock = this.engine.clockCompensation()
    return Math.max(0, heardBeat({
      eventMs,
      stamp: this.engine.outputStamp(),
      originContext: origin.context,
      originBeat: origin.beat,
      tempo: this.store.project.tempo,
      outputLatency: clock.outputLatency,
      baseLatency: clock.baseLatency,
      calibrationSec: clock.calibrationSec,
      quantizeBeats: this.store.project.quantizeBeats || 0,
    }))
  }
}

function uniquePitches(pitches: number[]): number[] {
  const seen = new Set<number>()
  const out: number[] = []
  for (const pitch of pitches) {
    const next = Math.max(0, Math.min(127, Math.round(pitch)))
    if (seen.has(next)) continue
    seen.add(next)
    out.push(next)
  }
  return out
}

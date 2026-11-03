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
import { noteTarget } from '../model/noteTarget'
import { hardwareMidiAllowed, midiOutputs, onMidiMessage, type MidiPortInfo } from './access'
import { performanceOwnsMidi, rememberOff, rememberOn, setCaptureEnabled, stepOwnsMidi } from './remember'

interface OpenNote {
  trackId: string
  pitch: number
  startBeat: number
  velocity: number
  /** The key that started this note. A chord shares one source. */
  source: number
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
  /** Source key to the pitches it actually sounded, so note-off releases the whole chord. */
  private sounded = new Map<string, number[]>()
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
    this.unsub = this.engine.subscribe(() => this.watchTransport())
    this.engine.midiSink = (bytes, time) => this.send(bytes, time)
  }

  stop() {
    this.unlisten?.()
    this.unlisten = null
    this.unsub?.()
    this.unsub = null
    this.stopClock()
    if (this.engine.midiSink) this.engine.midiSink = null
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
      const velocity = message.value / 127
      for (const id of dest.play) {
        const pitches = this.sound(id, message.number, velocity)
        this.sounded.set(`${id}:${message.number}`, pitches)
        if (recording && dest.record.includes(id)) {
          for (const pitch of pitches) this.open.push({ trackId: id, pitch, startBeat: beat, velocity, source: message.number })
        } else if (!recording) {
          for (const pitch of pitches) rememberOn(id, pitch, beat, velocity)
        }
      }
      return
    }
    for (const id of dest.play) {
      const pitches = this.sounded.get(`${id}:${message.number}`) ?? [message.number]
      this.sounded.delete(`${id}:${message.number}`)
      for (const pitch of pitches) this.engine.releaseThrough(id, pitch)
      if (!recording) for (const pitch of pitches) rememberOff(id, pitch, beat)
    }
    if (recording) this.closeRecorded(dest.record, message.number, beat)
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

  private closeRecorded(trackIds: string[], pitch: number, beat: number) {
    const wanted = new Set(trackIds)
    const keep: OpenNote[] = []
    for (const note of this.open) {
      if (note.source !== pitch || !wanted.has(note.trackId)) {
        keep.push(note)
        continue
      }
      const list = this.takes.get(note.trackId) || []
      list.push({
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: Math.max(0.05, beat - note.startBeat),
        velocity: note.velocity,
      })
      this.takes.set(note.trackId, list)
    }
    this.open = keep
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
    const beat = samplesToBeats(this.engine.currentTimelineSample(), this.store.project.sampleRate, this.store.project.tempo)
    for (const note of this.open) {
      const list = this.takes.get(note.trackId) || []
      list.push({
        pitch: note.pitch,
        startBeat: note.startBeat,
        durationBeats: Math.max(0.05, beat - note.startBeat),
        velocity: note.velocity,
      })
      this.takes.set(note.trackId, list)
    }
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

import type { AudioEngine } from './engine'
import { DRUM_PADS } from '../model/drums'
import { heardBeat, midiPerformanceMs, repeatBeats, repeatIntervalBeats, repeatIntervalSeconds, type RepeatRate } from '../model/midiClock'
import { snapPitch, type ScaleId } from '../model/scale'

export interface PlayedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export interface PerformTarget {
  trackId: string
  clipId: string
  drums: boolean
}

/**
 * Turns a pointer, key, or MIDI message into sound before any project edit.
 * The musical position is taken from the event timestamp, so a late handler still prints the right beat.
 */
export class Performer {
  private held = new Map<number, { pitch: number; eventMs: number; velocity: number }>()
  private repeat: { rate: RepeatRate; triplet: boolean } | null = null
  private quantizeBeats = 0
  private octave = 0
  private snap = false
  private root = 0
  private scale: ScaleId = 'ionian'

  constructor(
    private engine: AudioEngine,
    private target: () => PerformTarget | null,
    private commit: (target: PerformTarget, notes: PlayedNote[]) => void,
    private recording: () => boolean,
  ) {}

  setScale(snap: boolean, root: number, scale: ScaleId, octave: number) {
    this.snap = snap
    this.root = root
    this.scale = scale
    this.octave = octave
  }

  setRepeat(rate: RepeatRate | null, triplet: boolean) {
    this.repeat = rate ? { rate, triplet } : null
  }

  setQuantize(beats: number) {
    this.quantizeBeats = beats > 0 ? beats : 0
  }

  down(rawPitch: number, velocity: number, eventMs: number, pointerId: number) {
    const pitch = this.soundingPitch(rawPitch)
    const drums = this.target()?.drums ?? false
    const interval = this.repeatSeconds()
    const every = interval > 0 ? Math.round(interval * (this.engine.sampleRate || 48000)) : 0
    if (drums) this.engine.liveDrum(pitch, velocity, every)
    else this.engine.liveNoteOn(pitch, velocity, -1, every)
    this.held.set(pointerId, { pitch, eventMs, velocity })
  }

  up(pointerId: number, eventMs: number) {
    const held = this.held.get(pointerId)
    if (!held) return
    this.held.delete(pointerId)
    this.engine.liveNoteOff(held.pitch)
    this.print(held.pitch, held.velocity, held.eventMs, eventMs)
  }

  midi(data: Uint8Array, timeStamp: number, nowMs: number) {
    if (data.length < 3) return
    const status = data[0] & 0xf0
    const pitch = data[1]
    const velocity = data[2] / 127
    const eventMs = midiPerformanceMs(timeStamp, nowMs)
    if (status === 0x90 && data[2] > 0) this.down(pitch, velocity, eventMs, 1000 + pitch)
    if (status === 0x80 || (status === 0x90 && data[2] === 0)) this.up(1000 + pitch, eventMs)
  }

  private soundingPitch(rawPitch: number) {
    if (this.target()?.drums) return Math.max(0, Math.min(127, rawPitch))
    const shifted = Math.max(0, Math.min(127, rawPitch + this.octave * 12))
    return this.snap ? snapPitch(shifted, this.root, this.scale) : shifted
  }

  private repeatSeconds() {
    if (!this.repeat) return 0
    return repeatIntervalSeconds(this.repeat.rate, this.repeat.triplet, this.engine.tempo)
  }

  private print(pitch: number, velocity: number, startMs: number, endMs: number) {
    if (!this.recording()) return
    const target = this.target()
    if (!target) return
    const tempo = this.engine.tempo
    const origin = this.engine.playOrigin()
    const clock = this.engine.clockCompensation()
    const place = (eventMs: number) => heardBeat({
      eventMs,
      stamp: this.engine.outputStamp(),
      originContext: origin.context,
      originBeat: origin.beat,
      tempo,
      outputLatency: clock.outputLatency,
      baseLatency: clock.baseLatency,
      calibrationSec: clock.calibrationSec,
      quantizeBeats: this.quantizeBeats,
    })
    const startBeat = Math.max(0, place(startMs))
    const endBeat = Math.max(startBeat + 0.05, place(endMs))
    const interval = this.repeat ? repeatIntervalBeats(this.repeat.rate, this.repeat.triplet) : 0
    const marks = interval > 0 ? repeatBeats(startBeat, endBeat, interval) : [startBeat]
    const span = interval > 0 ? Math.min(interval * 0.9, 0.5) : endBeat - startBeat
    this.commit(target, marks.map((beat) => ({ pitch, velocity, startBeat: beat, durationBeats: span })))
  }
}

export function pointerVelocity(event: { clientY: number; pressure: number; pointerType: string }, rect: { top: number; height: number }) {
  const along = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  const fromPlace = 1 - Math.min(1, Math.max(0, along))
  if (event.pointerType === 'touch' && event.pressure > 0 && event.pressure < 1) return Math.max(0.15, event.pressure)
  return Math.max(0.15, fromPlace)
}

export function padPitch(index: number) {
  return DRUM_PADS[index]?.pitch ?? 36
}

import type { AudioEngine } from './engine'
import { gridRepeatBeats } from '../model/beatRepeat'
import { heardBeat, midiPerformanceMs, quantizeBeat, repeatIntervalBeats, type RepeatRate } from '../model/midiClock'
import { snapPitch, type ScaleId } from '../model/scale'
import {
  chokeTargets,
  effectiveSwing,
  padVelocity,
  pickLayer,
  sixteenLevels,
  swingDelay,
  timingCorrect,
  type LevelSpread,
  type PadProgram,
} from '../model/padMachine'

export interface PlayedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  nudge?: number
  locks?: Record<string, number>
}

export interface PerformTarget {
  trackId: string
  clipId: string
  drums: boolean
}

interface HeldNote {
  pitch: number
  eventMs: number
  velocity: number
  erase: boolean
  locks?: Record<string, number>
  repeating?: boolean
  printed?: boolean
  repeatRate?: RepeatRate
  repeatTriplet?: boolean
}

/**
 * Turns a pointer, key, or MIDI message into sound before any project edit.
 * The musical position is taken from the event timestamp, so a late handler still prints the right beat.
 */
export class Performer {
  private held = new Map<number, HeldNote>()
  private latched = new Map<number, HeldNote>()
  private recent: PlayedNote[] = []
  private repeat: { rate: RepeatRate; triplet: boolean } | null = null
  private quantizeBeats = 0
  private octave = 0
  private snap = false
  private root = 0
  private scale: ScaleId = 'ionian'
  private swing = 50
  private fullLevel = false
  private accent = false
  private erase = false
  private latch = false
  private levelSpread: LevelSpread | null = null
  private kit: PadProgram | null = null
  private robin = 0
  private fixedBeats = 0
  private recordMode: 'overdub' | 'replace' = 'overdub'
  private sampleOf: (bufferId: string) => Float32Array | null = () => null

  constructor(
    private engine: AudioEngine,
    private target: () => PerformTarget | null,
    private commit: (target: PerformTarget, notes: PlayedNote[], mode: 'overdub' | 'replace', fixedBeats: number) => void,
    private recording: () => boolean,
    private eraseNotes: (target: PerformTarget, pitch: number, fromBeat: number, toBeat: number) => void,
  ) {}

  setScale(snap: boolean, root: number, scale: ScaleId, octave: number) {
    this.snap = snap
    this.root = root
    this.scale = scale
    this.octave = octave
  }

  setRepeat(rate: RepeatRate | null, triplet: boolean, eventMs = performance.now()) {
    const next = rate ? { rate, triplet } : null
    const same = (!this.repeat && !next) || (this.repeat && next && this.repeat.rate === next.rate && this.repeat.triplet === next.triplet)
    if (same) return
    if (this.repeat && !next) {
      this.releaseRepeats(eventMs)
      this.repeat = null
      return
    }
    this.repeat = next
  }

  setQuantize(beats: number) {
    this.quantizeBeats = beats > 0 ? beats : 0
  }

  setDeck(opts: {
    kit: PadProgram | null
    swing: number
    fullLevel: boolean
    accent: boolean
    erase: boolean
    latch: boolean
    levels: LevelSpread | null
    fixedBeats: number
    recordMode: 'overdub' | 'replace'
    sampleOf: (bufferId: string) => Float32Array | null
  }) {
    this.kit = opts.kit
    this.swing = effectiveSwing(opts.kit?.swing ?? opts.swing, opts.kit?.trackSwing ?? opts.swing)
    this.fullLevel = opts.fullLevel
    this.accent = opts.accent
    this.erase = opts.erase
    this.latch = opts.latch
    this.levelSpread = opts.levels
    this.fixedBeats = opts.fixedBeats
    this.recordMode = opts.recordMode
    this.sampleOf = opts.sampleOf
  }

  down(rawPitch: number, velocity: number, eventMs: number, pointerId: number, levelIndex?: number) {
    const pitch = this.soundingPitch(rawPitch)
    if (this.erase && (this.target()?.drums ?? false)) {
      this.held.set(pointerId, { pitch, eventMs, velocity, erase: true })
      return
    }
    if (this.latch && this.repeat && this.latched.has(pitch)) {
      const held = this.latched.get(pitch)!
      this.latched.delete(pitch)
      this.finishPitch(pitch, eventMs, held)
      return
    }
    const drums = this.target()?.drums ?? false
    const spread = drums && this.levelSpread && levelIndex != null ? sixteenLevels(levelIndex, this.levelSpread) : null
    const played = spread && this.levelSpread === 'velocity' ? spread.velocity : velocity
    const level = padVelocity(played, this.fullLevel, this.accent)
    const pad = drums ? this.padFor(pitch) : undefined
    const locks = spread
      ? { tune: spread.tune, filter: spread.filter, decay: spread.decay, attack: spread.attack }
      : undefined
    const color = spread
      ? { tune: spread.tune, filter: spread.filter, decay: spread.decay, attack: spread.attack, swing: this.repeat ? this.swingFraction() : 0 }
      : pad
        ? { tune: pad.tune, filter: pad.filter, decay: pad.decay, attack: pad.attack, swing: this.repeat ? this.swingFraction() : 0 }
        : undefined
    let sample: Float32Array | null = null
    let sampleId: string | undefined
    if (pad && !spread) {
      const layerIndex = pickLayer(pad.layers, level, pad.layerMode, this.robin, this.kit?.seed ?? 1)
      this.robin = (this.robin + 1) % 4
      const layer = pad.layers[layerIndex]
      if (layer?.bufferId) {
        sample = this.sampleOf(layer.bufferId)
        sampleId = layer.bufferId
      }
      if (layer?.tune && color) color.tune = (color.tune || 0) + layer.tune
    }
    const gain = level * (pad?.level ?? 1)
    const previous = this.held.get(pointerId)
    if (previous?.repeating && !previous.printed) this.finishPitch(previous.pitch, eventMs, previous)
    if (drums) {
      for (const other of chokeTargets(this.chokePads(), pitch)) this.finishPitch(other, eventMs)
      if (pad?.poly === 'mono') this.finishPitch(pitch, eventMs)
    }
    if (this.repeat) {
      const clock = this.engine.musicalClock()
      this.engine.liveGridRepeat({
        pitch,
        velocity: gain,
        drums,
        intervalBeats: repeatIntervalBeats(this.repeat.rate, this.repeat.triplet),
        swing: swingDelay(this.swing),
        originContext: clock.originContext,
        originBeat: clock.originBeat,
        tempo: clock.tempo,
        armedBeat: this.musicalBeat(eventMs),
        sample,
        sampleId,
        tune: color?.tune,
        decay: color?.decay,
        attack: color?.attack,
        filter: color?.filter,
      })
    } else if (sample) this.engine.playBuffer(sample, pitch, gain, color)
    else if (drums) this.engine.liveDrum(pitch, gain, 0, color)
    else this.engine.liveNoteOn(pitch, gain, -1, 0, color)
    const held = {
      pitch,
      eventMs,
      velocity: gain,
      erase: false,
      locks,
      repeating: Boolean(this.repeat),
      repeatRate: this.repeat?.rate,
      repeatTriplet: this.repeat?.triplet,
    }
    this.held.set(pointerId, held)
    if (this.latch && this.repeat) this.latched.set(pitch, held)
  }

  up(pointerId: number, eventMs: number) {
    const held = this.held.get(pointerId)
    if (!held) return
    this.held.delete(pointerId)
    if (held.erase) {
      const target = this.target()
      if (!target) return
      const start = this.place(held.eventMs)
      const end = Math.max(this.place(eventMs), start + 0.25)
      this.eraseNotes(target, held.pitch, start, end)
      return
    }
    if (held.printed) return
    const still = [...this.held.values(), ...this.latched.values()].some((item) => item.pitch === held.pitch)
    if (this.latched.has(held.pitch)) return
    if (still) {
      if (held.repeating) {
        for (const other of [...this.held.values(), ...this.latched.values()]) {
          if (other.pitch === held.pitch && other.eventMs > held.eventMs) other.eventMs = held.eventMs
        }
      }
      return
    }
    if (held.repeating) this.finishPitch(held.pitch, eventMs, held)
    else {
      this.engine.liveNoteOff(held.pitch)
      this.print(held.pitch, held.velocity, held.eventMs, eventMs, held.locks)
    }
  }

  pressure(pointerId: number, velocity: number) {
    const held = this.held.get(pointerId)
    if (!held || held.erase) return
    const level = padVelocity(velocity, this.fullLevel, this.accent)
    held.velocity = level
    if (this.repeat) this.engine.liveGain(held.pitch, level)
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

  capture(): PlayedNote[] {
    const notes = this.recent
    this.recent = []
    return notes
  }

  private padFor(pitch: number) {
    const banks = this.kit?.banks
    if (!banks) return undefined
    for (const row of banks) {
      const pad = row.find((item) => item.pitch === pitch)
      if (pad) return pad
    }
    return undefined
  }

  private chokePads() {
    const pads = []
    for (const row of this.kit?.banks || []) for (const pad of row) pads.push({ pitch: pad.pitch, choke: pad.choke })
    return pads
  }

  private swingFraction() {
    return 2 * (this.swing / 100) - 1
  }

  private soundingPitch(rawPitch: number) {
    if (this.target()?.drums) return Math.max(0, Math.min(127, rawPitch))
    const shifted = Math.max(0, Math.min(127, rawPitch + this.octave * 12))
    return this.snap ? snapPitch(shifted, this.root, this.scale) : shifted
  }

  private releaseRepeats(eventMs: number) {
    const pitches = new Set<number>()
    for (const held of [...this.held.values(), ...this.latched.values()]) {
      if (held.repeating && !held.printed && !held.erase) pitches.add(held.pitch)
    }
    for (const pitch of pitches) this.finishPitch(pitch, eventMs)
    for (const [pitch, held] of this.latched) {
      if (held.printed || !held.repeating) this.latched.delete(pitch)
    }
  }

  /** Stop one pitch, and if it was repeating, print the grid hits up to this moment. */
  private finishPitch(pitch: number, eventMs: number, extra?: HeldNote) {
    const notes: HeldNote[] = []
    const take = (held: HeldNote) => {
      if (held.pitch !== pitch || held.printed || held.erase || !held.repeating) return
      notes.push(held)
    }
    if (extra) take(extra)
    for (const held of this.held.values()) take(held)
    for (const held of this.latched.values()) take(held)
    if (!notes.length) {
      this.engine.liveNoteOff(pitch)
      return
    }
    let start = notes[0].eventMs
    let velocity = notes[0].velocity
    let locks = notes[0].locks
    for (const held of notes) {
      if (held.eventMs < start) start = held.eventMs
      velocity = held.velocity
      locks = held.locks
      held.printed = true
      held.repeating = false
    }
    this.engine.liveNoteOff(pitch, this.musicalBeat(eventMs))
    const gesture = notes.find((note) => note.repeatRate)
    this.print(
      pitch,
      velocity,
      start,
      eventMs,
      locks,
      true,
      gesture?.repeatRate ? { rate: gesture.repeatRate, triplet: Boolean(gesture.repeatTriplet) } : undefined,
    )
  }

  private musicalBeat(eventMs: number) {
    const clock = this.engine.musicalClock()
    const comp = this.engine.clockCompensation()
    return heardBeat({
      eventMs,
      stamp: this.engine.outputStamp(),
      originContext: clock.originContext,
      originBeat: clock.originBeat,
      tempo: clock.tempo,
      outputLatency: comp.outputLatency,
      baseLatency: comp.baseLatency,
      calibrationSec: comp.calibrationSec,
      quantizeBeats: 0,
    })
  }

  private place(eventMs: number) {
    const tempo = this.engine.tempo
    const origin = this.engine.playOrigin()
    const clock = this.engine.clockCompensation()
    const beat = heardBeat({
      eventMs,
      stamp: this.engine.outputStamp(),
      originContext: origin.context,
      originBeat: origin.beat,
      tempo,
      outputLatency: clock.outputLatency,
      baseLatency: clock.baseLatency,
      calibrationSec: clock.calibrationSec,
      quantizeBeats: 0,
    })
    if (this.kit?.timing) return timingCorrect(beat, this.kit.timingGrid || this.quantizeBeats || 0.25, this.kit.timingStrength, this.repeat ? 50 : this.swing, true)
    return quantizeBeat(beat, this.quantizeBeats)
  }

  private print(
    pitch: number,
    velocity: number,
    startMs: number,
    endMs: number,
    locks?: Record<string, number>,
    repeating = false,
    gesture?: { rate: RepeatRate; triplet: boolean },
  ) {
    const target = this.target()
    if (!target) return
    const spec = gesture ?? this.repeat
    let notes: PlayedNote[]
    if (repeating && spec) {
      const startBeat = this.musicalBeat(startMs)
      const endBeat = this.musicalBeat(endMs)
      const interval = repeatIntervalBeats(spec.rate, spec.triplet)
      const marks = gridRepeatBeats(startBeat, endBeat, interval, this.swing)
      if (!marks.length) return
      const span = Math.min(interval * 0.9, 0.5)
      notes = marks.map((beat) => ({ pitch, velocity, startBeat: beat, durationBeats: span, locks }))
    } else {
      const startBeat = Math.max(0, this.place(startMs))
      const endBeat = Math.max(startBeat + 0.05, this.place(endMs))
      notes = [{ pitch, velocity, startBeat, durationBeats: endBeat - startBeat, locks }]
    }
    if (this.recording()) this.commit(target, notes, this.recordMode, this.fixedBeats)
    else {
      this.recent.push(...notes)
      if (this.recent.length > 256) this.recent.splice(0, this.recent.length - 256)
    }
  }
}

export function pointerVelocity(event: { clientY: number; pressure: number; pointerType: string }, rect: { top: number; height: number }) {
  const along = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
  const fromPlace = 1 - Math.min(1, Math.max(0, along))
  if (event.pointerType === 'touch' && event.pressure > 0 && event.pressure < 1) return Math.max(0.15, event.pressure)
  return Math.max(0.15, fromPlace)
}

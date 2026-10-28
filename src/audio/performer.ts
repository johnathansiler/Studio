import { rememberPlayed } from '../midi/remember'
import type { AudioEngine } from './engine'
import { BEAT_LOOKAHEAD_SEC, BeatRepeat, beatAt, contextAt, type RepeatHit } from '../model/beatRepeat'
import { heardBeat, midiPerformanceMs, quantizeBeat, repeatIntervalBeats, type RepeatRate } from '../model/midiClock'
import { type ScaleId } from '../model/scale'
import { lockedTone } from '../theory/lock'
import {
  chokeTargets,
  effectiveSwing,
  padVelocity,
  pickLayer,
  sixteenLevels,
  timingCorrect,
  type LevelSpread,
  type PadProgram,
} from '../model/padMachine'
import { samplesToBeats } from '../model/time'

export interface PlayedNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  /** Cents offset. Quarter-tone scale lock uses ±50. */
  fine?: number
  nudge?: number
  locks?: Record<string, number>
}

export interface PerformTarget {
  trackId: string
  clipId: string
  drums: boolean
}

interface PadColor {
  tune?: number
  filter?: number
  decay?: number
  attack?: number
  swing?: number
}

interface HeldNote {
  pitch: number
  fine: number
  eventMs: number
  velocity: number
  erase: boolean
  locks?: Record<string, number>
  sample: Float32Array | null
  color?: PadColor
  choke: number[]
  repeated: boolean
}

interface RepeatVoice {
  sample: Float32Array | null
  color?: PadColor
  locks?: Record<string, number>
  choke: number[]
}

/**
 * Turns a pointer, key, or MIDI message into sound before any project edit.
 * The musical position is taken from the event timestamp, so a late handler still prints the right beat.
 * Beat repeat is scheduled on the audio clock, ahead of the speaker, and locked to the transport grid.
 */
export class Performer {
  private held = new Map<number, HeldNote>()
  private latched = new Map<number, HeldNote>()
  private holders = new Map<number, number>()
  private voices = new Map<number, RepeatVoice>()
  private recent: PlayedNote[] = []
  private pending: PlayedNote[] = []
  private beat = new BeatRepeat()
  private grid: { rate: RepeatRate; triplet: boolean } | null = null
  private engaged = false
  private quantizeBeats = 0
  private octave = 0
  private snap = false
  private root = 0
  private scale: ScaleId = 'ionian'
  private library = ''
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
  private freeOrigin: { context: number; beat: number } | null = null

  constructor(
    private engine: AudioEngine,
    private target: () => PerformTarget | null,
    private commit: (target: PerformTarget, notes: PlayedNote[], mode: 'overdub' | 'replace', fixedBeats: number, coalesce?: boolean) => void,
    private recording: () => boolean,
    private eraseNotes: (target: PerformTarget, pitch: number, fromBeat: number, toBeat: number) => void,
    private finishTake: () => void = () => undefined,
  ) {}

  setScale(snap: boolean, root: number, scale: ScaleId, octave: number, library = '') {
    this.snap = snap
    this.root = root
    this.scale = scale
    this.octave = octave
    this.library = library
  }

  /** Keys: choosing a rate also turns repeat on. The pad deck engages with the Beat button instead. */
  setRepeat(rate: RepeatRate | null, triplet: boolean) {
    this.setGrid(rate, triplet)
    this.setEngaged(!!rate)
  }

  setGrid(rate: RepeatRate | null, triplet: boolean) {
    const next = rate ? { rate, triplet } : null
    const changed = (next?.rate ?? null) !== (this.grid?.rate ?? null) || (next?.triplet ?? false) !== (this.grid?.triplet ?? false)
    this.grid = next
    if (!changed) return
    if (!next) {
      if (this.engaged) this.setEngaged(false)
      return
    }
    if (this.engaged) this.retarget(repeatIntervalBeats(next.rate, next.triplet))
  }

  setEngaged(on: boolean) {
    if (this.engaged === on) return
    this.engaged = on
    if (on) {
      this.armHeld()
      this.engine.setRepeatWatch(true)
      this.pumpSoon()
      return
    }
    const beat = this.safeBeat()
    this.beat.releaseAll(beat)
    this.holders.clear()
    this.latched.clear()
    this.cancelFuture(beat)
    this.pumpSoon()
    this.flushRepeats(true)
    this.engine.setRepeatWatch(false)
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
    const swing = effectiveSwing(opts.kit?.swing ?? opts.swing, opts.kit?.trackSwing ?? opts.swing)
    const swingChanged = swing !== this.swing
    this.kit = opts.kit
    this.swing = swing
    this.fullLevel = opts.fullLevel
    this.accent = opts.accent
    this.erase = opts.erase
    this.latch = opts.latch
    this.levelSpread = opts.levels
    this.fixedBeats = opts.fixedBeats
    this.recordMode = opts.recordMode
    this.sampleOf = opts.sampleOf
    if (swingChanged && this.engaged && this.grid) this.retarget(repeatIntervalBeats(this.grid.rate, this.grid.triplet))
  }

  down(rawPitch: number, velocity: number, eventMs: number, pointerId: number, levelIndex?: number, givenFine?: number) {
    const sounded = this.soundingPitch(rawPitch, givenFine)
    const pitch = sounded.midi
    const fine = sounded.cents
    if (this.erase && (this.target()?.drums ?? false)) {
      this.held.set(pointerId, { pitch, fine: 0, eventMs, velocity, erase: true, sample: null, choke: [], repeated: false })
      return
    }
    if (this.latch && this.engaged && this.latched.has(pitch)) {
      this.latched.delete(pitch)
      this.releaseRepeat(pitch, eventMs)
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
    const tune = (spread?.tune ?? pad?.tune ?? 0) + fine / 100
    const color: PadColor | undefined = spread
      ? { tune, filter: spread.filter, decay: spread.decay, attack: spread.attack }
      : pad
        ? { tune, filter: pad.filter, decay: pad.decay, attack: pad.attack }
        : fine
          ? { tune: fine / 100 }
          : undefined
    let sample: Float32Array | null = null
    if (pad && !spread) {
      const layerIndex = pickLayer(pad.layers, level, pad.layerMode, this.robin, this.kit?.seed ?? 1)
      this.robin = (this.robin + 1) % 4
      const layer = pad.layers[layerIndex]
      if (layer?.bufferId) sample = this.sampleOf(layer.bufferId)
      if (layer?.tune && color) color.tune = (color.tune || 0) + layer.tune
    }
    const gain = level * (pad?.level ?? 1)
    const choke = drums ? chokeTargets(this.chokePads(), pitch) : []
    const repeated = this.engaged && !!this.grid
    const note: HeldNote = { pitch, fine, eventMs, velocity: gain, erase: false, locks, sample, color, choke, repeated }
    this.held.set(pointerId, note)
    if (repeated) {
      const count = (this.holders.get(pitch) ?? 0) + 1
      this.holders.set(pitch, count)
      if (count === 1) this.startRepeat(pitch, gain, this.transportBeat(eventMs), sample, color, locks, choke)
      else this.beat.pressure(pitch, gain, this.transportBeat(eventMs))
      if (this.latch) this.latched.set(pitch, note)
      this.pumpNow()
      return
    }
    if (drums) {
      for (const other of choke) this.engine.liveNoteOff(other)
      if (pad?.poly === 'mono') this.engine.liveNoteOff(pitch)
    }
    if (sample) this.engine.playBuffer(sample, pitch, gain, color)
    else if (drums) this.engine.liveDrum(pitch, gain, 0, color)
    else {
      const aimed = this.target()
      if (aimed) this.engine.playThrough(aimed.trackId, pitch, gain)
      else this.engine.liveNoteOn(pitch, gain, -1, 0, color)
    }
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
    if (held.repeated) {
      if (this.latched.has(held.pitch)) return
      const left = (this.holders.get(held.pitch) ?? 1) - 1
      if (left > 0) {
        this.holders.set(held.pitch, left)
        return
      }
      this.releaseRepeat(held.pitch, eventMs)
      return
    }
    const still = [...this.held.values(), ...this.latched.values()].some((item) => item.pitch === held.pitch)
    if (!still) {
      const aimed = this.target()
      if (aimed && !aimed.drums && !held.sample) this.engine.releaseThrough(aimed.trackId, held.pitch)
      else this.engine.liveNoteOff(held.pitch)
    }
    this.print(held.pitch, held.fine, held.velocity, held.eventMs, eventMs, held.locks)
  }

  pressure(pointerId: number, velocity: number) {
    const held = this.held.get(pointerId)
    if (!held || held.erase) return
    const level = padVelocity(velocity, this.fullLevel, this.accent)
    held.velocity = level
    if (held.repeated) this.beat.pressure(held.pitch, level, this.transportBeat(performance.now()))
    this.engine.liveGain(held.pitch, level)
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
    const notes = this.recent.splice(0, this.recent.length)
    return notes
  }

  /** Called from the audio look-ahead. Hit times were chosen on the musical grid. */
  pumpRepeats(now: number, horizon: number) {
    if (!this.grid && this.beat.count === 0) return
    const clock = this.clockFor(now)
    const { play, record, realigned } = this.beat.take(clock, now, horizon)
    if (realigned) {
      for (const pitch of this.voices.keys()) this.engine.cancelPadHits(pitch, now)
    }
    for (const hit of play) this.sound(hit)
    if (record.length) this.remember(record)
  }

  private armHeld() {
    if (!this.grid) return
    const seen = new Set<number>()
    for (const note of this.held.values()) {
      if (note.erase || seen.has(note.pitch)) continue
      seen.add(note.pitch)
      note.repeated = true
      let count = 0
      for (const other of this.held.values()) if (!other.erase && other.pitch === note.pitch) count += 1
      this.holders.set(note.pitch, count)
      this.startRepeat(note.pitch, note.velocity, this.transportBeat(performance.now()), note.sample, note.color, note.locks, note.choke)
      if (this.latch) this.latched.set(note.pitch, note)
    }
  }

  private startRepeat(
    pitch: number,
    velocity: number,
    fromBeat: number,
    sample: Float32Array | null,
    color: PadColor | undefined,
    locks: Record<string, number> | undefined,
    choke: number[],
  ) {
    if (!this.grid) return
    this.voices.set(pitch, { sample, color, locks, choke })
    this.beat.arm({
      pitch,
      velocity,
      fromBeat,
      interval: repeatIntervalBeats(this.grid.rate, this.grid.triplet),
      swing: this.swing,
    })
    this.engine.setRepeatWatch(true)
  }

  private retarget(interval: number) {
    const { now } = this.clockNow()
    this.beat.retarget(interval, this.swing, beatAt(this.clockFor(now), now), now)
    this.cancelFuture()
    this.pumpSoon()
  }

  private releaseRepeat(pitch: number, eventMs: number) {
    this.holders.delete(pitch)
    if (this.beat.hasOpen(pitch)) {
      const beat = this.transportBeat(eventMs)
      this.beat.release(pitch, beat)
      this.engine.cancelPadHits(pitch, this.contextForBeat(beat))
      this.pumpNow()
    }
    this.voices.delete(pitch)
    const still = [...this.held.values(), ...this.latched.values()].some((item) => item.pitch === pitch)
    if (!still) this.engine.liveNoteOff(pitch)
    if (this.beat.count === 0) {
      this.flushRepeats(true)
      if (!this.engaged) this.engine.setRepeatWatch(false)
    }
  }

  private sound(hit: RepeatHit) {
    const voice = this.voices.get(hit.pitch)
    if (!voice) return
    if (voice.sample) this.engine.playBuffer(voice.sample, hit.pitch, hit.velocity, voice.color, hit.when)
    else this.engine.schedulePadHit(hit.when, hit.pitch, hit.velocity, voice.color)
    for (const other of voice.choke) this.engine.duckPad(other)
  }

  private remember(hits: RepeatHit[]) {
    for (const hit of hits) {
      const voice = this.voices.get(hit.pitch)
      this.pending.push({
        pitch: hit.pitch,
        startBeat: Math.max(0, hit.beat),
        durationBeats: hit.durationBeats,
        velocity: hit.velocity,
        locks: voice?.locks,
      })
    }
    this.flushRepeats(false)
  }

  private flushRepeats(close: boolean) {
    const notes = this.pending.splice(0, this.pending.length)
    const target = this.target()
    if (notes.length && this.recording() && target) this.commit(target, notes, this.recordMode, this.fixedBeats, true)
    else if (notes.length) {
      this.recent.push(...notes)
      if (this.recent.length > 256) this.recent.splice(0, this.recent.length - 256)
    }
    if (close) this.finishTake()
  }

  private cancelFuture(fromBeat?: number) {
    const when = fromBeat == null ? this.clockNow().now : this.contextForBeat(fromBeat)
    for (const pitch of this.voices.keys()) this.engine.cancelPadHits(pitch, when)
  }

  private pumpNow() {
    const { now } = this.clockNow()
    this.pumpRepeats(now, now + BEAT_LOOKAHEAD_SEC)
  }

  private pumpSoon() {
    queueMicrotask(() => this.pumpNow())
  }

  private clockNow() {
    const ctx = this.engine.unlock()
    const now = ctx.currentTime
    return { clock: this.clockFor(now), now }
  }

  private safeBeat() {
    const { clock, now } = this.clockNow()
    return beatAt(clock, now)
  }

  private contextForBeat(beat: number) {
    return contextAt(this.clockNow().clock, beat)
  }

  private clockFor(now: number) {
    if (this.engine.transportPlaying) {
      this.freeOrigin = null
      const origin = this.engine.playOrigin()
      return { originContext: origin.context, originBeat: origin.beat, tempo: this.engine.tempo, sampleRate: this.engine.sampleRate }
    }
    if (!this.freeOrigin) {
      const beat = samplesToBeats(this.engine.positionSamples, this.engine.sampleRate, this.engine.tempo)
      this.freeOrigin = { context: now, beat }
    }
    return {
      originContext: this.freeOrigin.context,
      originBeat: this.freeOrigin.beat,
      tempo: this.engine.tempo,
      sampleRate: this.engine.sampleRate,
    }
  }

  private transportBeat(eventMs: number) {
    const { clock } = this.clockNow()
    const timing = this.engine.clockCompensation()
    return heardBeat({
      eventMs,
      stamp: this.engine.outputStamp(),
      originContext: clock.originContext,
      originBeat: clock.originBeat,
      tempo: clock.tempo,
      outputLatency: timing.outputLatency,
      baseLatency: timing.baseLatency,
      calibrationSec: timing.calibrationSec,
      quantizeBeats: 0,
    })
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

  private soundingPitch(rawPitch: number, givenFine?: number) {
    if (this.target()?.drums) return { midi: Math.max(0, Math.min(127, rawPitch)), cents: 0 }
    const shifted = Math.max(0, Math.min(127, rawPitch + this.octave * 12))
    const fine = givenFine ?? 0
    if (!this.snap) return { midi: shifted, cents: fine }
    const tone = lockedTone(shifted, fine, { root: this.root, scale: this.scale, library: this.library })
    return { midi: Math.max(0, Math.min(127, tone.midi)), cents: tone.cents }
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
    if (this.kit?.timing) return timingCorrect(beat, this.kit.timingGrid || this.quantizeBeats || 0.25, this.kit.timingStrength, this.swing, true)
    return quantizeBeat(beat, this.quantizeBeats)
  }

  private print(pitch: number, fine: number, velocity: number, startMs: number, endMs: number, locks?: Record<string, number>) {
    const target = this.target()
    if (!target) return
    const startBeat = Math.max(0, this.place(startMs))
    const endBeat = Math.max(startBeat + 0.05, this.place(endMs))
    const notes = [{ pitch, velocity, startBeat, durationBeats: endBeat - startBeat, locks, ...(fine ? { fine: Math.round(fine) } : {}) }]
    if (this.recording()) this.commit(target, notes, this.recordMode, this.fixedBeats)
    else {
      this.recent.push(...notes)
      rememberPlayed(target.trackId, notes)
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

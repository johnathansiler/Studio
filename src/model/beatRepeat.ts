/** MPC-style beat repeat. Hits are musical-grid times, not timer ticks. */

import { repeatIntervalBeats, type RepeatRate } from './midiClock'
import { latchRepeat, swingDelay } from './padMachine'

export const BEAT_LOOKAHEAD_SEC = 0.35
export const BEAT_RATES: RepeatRate[] = ['1/4', '1/8', '1/16', '1/32']

export interface RepeatClock {
  originContext: number
  originBeat: number
  tempo: number
  sampleRate: number
  /** Transport is stopped. Hits start at the press and step at the rate. */
  free?: boolean
}

export interface RepeatHit {
  pitch: number
  beat: number
  when: number
  frame: number
  velocity: number
  durationBeats: number
}

export interface ArmRepeat {
  pitch: number
  velocity: number
  fromBeat: number
  interval: number
  swing: number
  /** Start on this press. Playing transport leaves this off and locks to the song grid. */
  free?: boolean
}

interface VelocityMark {
  beat: number
  velocity: number
}

interface RepeatPad {
  pitch: number
  fromBeat: number
  interval: number
  swing: number
  untilBeat: number | null
  velocities: VelocityMark[]
  nextPlay: number
  queued: RepeatHit[]
  /** Stopped transport. The phase starts at fromBeat instead of the song grid. */
  free: boolean
}

/**
 * Hold keeps beat repeat on only while the finger is down.
 * Latch turns a tap into a toggle so one hand can play the pads.
 */
export function beatRepeatHeld(on: boolean, latch: boolean, phase: 'down' | 'up'): boolean {
  if (latch) return latchRepeat(on, phase === 'down')
  return phase === 'down'
}

/** iPhone has no hardware MIDI path. Other devices may open a pad controller. */
export function hardwareMidiAllowed(userAgent: string): boolean {
  return !/iPhone|iPod/i.test(userAgent || '')
}

export function gridInterval(rate: RepeatRate, triplet: boolean): number {
  return repeatIntervalBeats(rate, triplet)
}

export function swungGridBeat(index: number, interval: number, swingPercent: number): number {
  const base = index * interval
  if (index % 2 === 1) return base + interval * swingDelay(swingPercent)
  return base
}

export function firstGridIndex(fromBeat: number, interval: number, swingPercent: number): number {
  if (!(interval > 0)) return 0
  let index = Math.max(0, Math.floor(Math.max(0, fromBeat) / interval) - 1)
  while (index < 1_000_000 && swungGridBeat(index, interval, swingPercent) < fromBeat - 1e-9) index += 1
  return index
}

export function contextAt(clock: RepeatClock, beat: number): number {
  const tempo = Math.max(1, clock.tempo)
  return clock.originContext + (beat - clock.originBeat) * (60 / tempo)
}

export function beatAt(clock: RepeatClock, contextTime: number): number {
  const tempo = Math.max(1, clock.tempo)
  return clock.originBeat + (contextTime - clock.originContext) * (tempo / 60)
}

export function hitFrame(when: number, sampleRate: number): number {
  return Math.round(when * sampleRate)
}

export function repeatNoteLength(intervalBeats: number): number {
  return Math.min(Math.max(intervalBeats, 0.05) * 0.9, 0.5)
}

/**
 * Sample offset of each hit inside an audio block.
 * A hit up to one block late still starts on the first sample of this block.
 */
export function blockHitOffsets(frames: number[], blockStart: number, blockLength: number): { offset: number; frame: number }[] {
  const out: { offset: number; frame: number }[] = []
  const end = blockStart + blockLength
  for (const frame of frames) {
    if (frame >= end || frame < blockStart - blockLength) continue
    const offset = Math.max(0, frame - blockStart)
    if (offset < blockLength) out.push({ offset, frame: blockStart + offset })
  }
  return out
}

function velocityAt(pad: RepeatPad, beat: number): number {
  let velocity = pad.velocities[0]?.velocity ?? 0.8
  for (const mark of pad.velocities) if (mark.beat <= beat + 1e-9) velocity = mark.velocity
  return velocity
}

function phaseBeat(pad: RepeatPad, index: number): number {
  const grid = swungGridBeat(index, pad.interval, pad.swing)
  return pad.free ? pad.fromBeat + grid : grid
}

/** Next index whose beat is still ahead of `beatNow`. Free clocks count from the press. */
function nextIndex(pad: RepeatPad, beatNow: number): number {
  if (!(pad.interval > 0)) return 0
  if (pad.free) {
    let index = 0
    if (pad.interval > 0 && beatNow > pad.fromBeat) {
      index = Math.max(0, Math.floor((beatNow - pad.fromBeat) / pad.interval) - 1)
    }
    while (index < 1_000_000 && phaseBeat(pad, index) < beatNow - 1e-9) index += 1
    return index
  }
  return firstGridIndex(Math.max(pad.fromBeat, beatNow), pad.interval, pad.swing)
}

function makeHit(pad: RepeatPad, beat: number, clock: RepeatClock): RepeatHit {
  const when = contextAt(clock, beat)
  return {
    pitch: pad.pitch,
    beat,
    when,
    frame: hitFrame(when, clock.sampleRate),
    velocity: velocityAt(pad, beat),
    durationBeats: repeatNoteLength(pad.interval),
  }
}

/**
 * Look-ahead clock for pads that are held while beat repeat is on.
 * `take` places hits on the audio clock. It does not wait on a timer.
 */
export class BeatRepeat {
  private pads = new Map<number, RepeatPad>()
  private originKey = ''

  arm(input: ArmRepeat) {
    const existing = this.pads.get(input.pitch)
    if (existing && existing.untilBeat == null) {
      this.pressure(input.pitch, input.velocity, input.fromBeat)
      return
    }
    const interval = input.interval > 0 ? input.interval : 0
    const free = input.free === true
    this.pads.set(input.pitch, {
      pitch: input.pitch,
      fromBeat: input.fromBeat,
      interval,
      swing: input.swing,
      untilBeat: null,
      velocities: [{ beat: input.fromBeat, velocity: input.velocity }],
      nextPlay: free ? 0 : firstGridIndex(input.fromBeat, interval, input.swing),
      queued: [],
      free,
    })
  }

  pressure(pitch: number, velocity: number, beat: number) {
    const pad = this.pads.get(pitch)
    if (!pad || pad.untilBeat != null) return
    pad.velocities.push({ beat, velocity })
    if (pad.velocities.length > 64) pad.velocities.splice(0, pad.velocities.length - 64)
  }

  /** The grid changed. Future hits use the new interval; audio that has not sounded yet is dropped. */
  retarget(interval: number, swing: number, beatNow: number, now = Number.POSITIVE_INFINITY) {
    for (const pad of this.pads.values()) {
      if (pad.untilBeat != null) continue
      pad.interval = interval > 0 ? interval : pad.interval
      pad.swing = swing
      pad.nextPlay = nextIndex(pad, Math.max(pad.fromBeat, beatNow))
      pad.queued = pad.queued.filter((hit) => hit.when <= now + 1e-4)
    }
  }

  release(pitch: number, untilBeat: number) {
    const pad = this.pads.get(pitch)
    if (!pad || pad.untilBeat != null) return
    pad.untilBeat = untilBeat
    pad.queued = pad.queued.filter((hit) => hit.beat < untilBeat - 1e-9)
  }

  releaseAll(untilBeat: number) {
    for (const pitch of [...this.pads.keys()]) this.release(pitch, untilBeat)
  }

  hasOpen(pitch: number) {
    const pad = this.pads.get(pitch)
    return !!pad && pad.untilBeat == null
  }

  get count() {
    let open = 0
    for (const pad of this.pads.values()) if (pad.untilBeat == null) open += 1
    return open
  }

  /**
   * Hits whose audio time falls in `[now - one block, horizon)`.
   * Recorded hits are the ones whose grid time has arrived.
   * A late call still reports the original grid time.
   */
  take(clock: RepeatClock, now: number, horizon: number): { play: RepeatHit[]; record: RepeatHit[]; realigned: boolean } {
    const play: RepeatHit[] = []
    const record: RepeatHit[] = []
    const free = clock.free === true
    const key = `${Math.round(clock.originContext * 1e6)}|${Math.round(clock.originBeat * 1e6)}|${clock.tempo}|${clock.sampleRate}|${free ? 1 : 0}`
    const realigned = this.originKey !== '' && key !== this.originKey
    this.originKey = key
    const late = free ? 0.08 : 128 / Math.max(1, clock.sampleRate)
    if (realigned) {
      const beatNow = beatAt(clock, now)
      for (const pad of this.pads.values()) {
        pad.free = free
        pad.queued = pad.queued.filter((hit) => hit.when <= now)
        if (pad.untilBeat == null) pad.nextPlay = nextIndex(pad, Math.max(pad.fromBeat, beatNow))
      }
    }
    for (const pad of this.pads.values()) {
      if (!(pad.interval > 0)) continue
      while (pad.nextPlay < 1_000_000) {
        const beat = phaseBeat(pad, pad.nextPlay)
        if (pad.untilBeat != null && beat >= pad.untilBeat - 1e-9) break
        const when = contextAt(clock, beat)
        if (when >= horizon) break
        if (when >= now - late) {
          const hit = makeHit(pad, beat, clock)
          if (free && hit.when < now) {
            hit.when = now
            hit.frame = hitFrame(now, clock.sampleRate)
          }
          play.push(hit)
          pad.queued.push(hit)
        }
        pad.nextPlay += 1
      }
      const still: RepeatHit[] = []
      for (const hit of pad.queued) {
        if (pad.untilBeat != null && hit.beat >= pad.untilBeat - 1e-9) continue
        if (hit.when <= now) record.push(hit)
        else still.push(hit)
      }
      pad.queued = still
    }
    for (const [pitch, pad] of this.pads) {
      if (pad.untilBeat == null) continue
      const upcoming = phaseBeat(pad, pad.nextPlay)
      if (upcoming >= pad.untilBeat - 1e-9 && !pad.queued.length) this.pads.delete(pitch)
    }
    return { play, record, realigned }
  }
}

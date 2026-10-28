/** MPC-style beat repeat. Hits land on the tempo grid, counted in samples on the audio clock. */

import { swingDelay } from './padMachine'

export const BEAT_REPEAT_CC = 119
export const BEAT_REPEAT_KEY = 'Space'

export interface ClockAnchor {
  originContext: number
  originBeat: number
  tempo: number
  sample: number
}

export interface GridCursor {
  nextIndex: number
}

export interface GridRepeat {
  pitch: number
  velocity: number
  /** False for keys, so a pad pitch does not swap in a drum sample. */
  drums: boolean
  intervalBeats: number
  /** 0 is straight. 0.5 delays every odd grid point by half an interval. */
  swing: number
  originContext: number
  originBeat: number
  tempo: number
  /** Musical beat of the press, already compensated for output latency. */
  armedBeat: number
  sample?: Float32Array | null
  sampleId?: string
  tune?: number
  decay?: number
  attack?: number
  filter?: number
}

/**
 * One grid while the playhead sits still. Seeking or changing tempo starts another,
 * so every pad shares the same phase instead of restarting it on the next press.
 */
export function anchorClock(previous: ClockAnchor | null, sample: number, beat: number, tempo: number, context: number): ClockAnchor {
  if (previous && previous.tempo === tempo && previous.sample === sample) return previous
  return { originContext: context, originBeat: beat, tempo, sample }
}

/** CC 119 is the momentary Beat Repeat switch. Notes are pads, not the switch. */
export function beatRepeatSwitch(data: Uint8Array): boolean | null {
  if (data.length < 3) return null
  if ((data[0] & 0xf0) !== 0xb0 || data[1] !== BEAT_REPEAT_CC) return null
  return data[2] >= 64
}

export function gridBeatAt(index: number, interval: number, swing: number): number {
  const delay = index % 2 === 1 ? swing * interval : 0
  return index * interval + delay
}

export function firstGridIndex(beat: number, interval: number, swing: number): number {
  if (!(interval > 0)) return 0
  let index = Math.floor((beat - 1e-8) / interval)
  if (index < 0) index = 0
  for (let step = 0; step < 8; step++) {
    if (gridBeatAt(index, interval, swing) >= beat - 1e-9) return index
    index += 1
  }
  return index
}

export function gridSample(beat: number, originContext: number, originBeat: number, tempo: number, sampleRate: number): number {
  const time = originContext + (beat - originBeat) * (60 / tempo)
  return Math.round(time * sampleRate)
}

/**
 * Sample offsets inside this render block where a repeat fires.
 * A hit that fell just before the block still sounds on the first sample,
 * once, so a late message stays in that grid slot. The release beat is excluded.
 */
export function takeGridHits(
  cursor: GridCursor,
  blockFrame: number,
  frames: number,
  sampleRate: number,
  originContext: number,
  originBeat: number,
  tempo: number,
  interval: number,
  swing: number,
  armedBeat: number,
  releaseBeat: number,
): number[] {
  const hits: number[] = []
  if (!(interval > 0) || !(tempo > 0) || !(sampleRate > 0) || frames <= 0) return hits
  const blockEnd = blockFrame + frames
  let late = false
  for (let guard = 0; guard < 64; guard++) {
    const beat = gridBeatAt(cursor.nextIndex, interval, swing)
    if (!(beat < releaseBeat - 1e-9)) break
    if (beat < armedBeat - 1e-9) {
      cursor.nextIndex += 1
      continue
    }
    const sample = gridSample(beat, originContext, originBeat, tempo, sampleRate)
    if (sample >= blockEnd) break
    if (sample >= blockFrame) {
      hits.push(sample - blockFrame)
      cursor.nextIndex += 1
      continue
    }
    late = true
    cursor.nextIndex += 1
    while (guard < 64) {
      const nextBeat = gridBeatAt(cursor.nextIndex, interval, swing)
      if (!(nextBeat < releaseBeat - 1e-9)) break
      const nextSample = gridSample(nextBeat, originContext, originBeat, tempo, sampleRate)
      if (nextSample >= blockFrame) break
      cursor.nextIndex += 1
      guard += 1
    }
  }
  if (late && hits[0] !== 0) hits.unshift(0)
  return hits
}

/** Grid points inside [startBeat, endBeat). Swing percent matches the pad deck (50 is straight, 75 is the far shuffle). */
export function gridRepeatBeats(startBeat: number, endBeat: number, intervalBeats: number, swingPercent = 50): number[] {
  if (!(intervalBeats > 0) || !(endBeat > startBeat)) return []
  const swing = swingDelay(swingPercent)
  const marks: number[] = []
  let index = firstGridIndex(startBeat, intervalBeats, swing)
  for (let guard = 0; guard < 20000; guard++) {
    const beat = gridBeatAt(index, intervalBeats, swing)
    if (!(beat < endBeat - 1e-9)) break
    if (beat >= startBeat - 1e-9) marks.push(beat)
    index += 1
  }
  return marks
}

/** Maps an input timestamp onto the musical grid without waiting for the main thread. */

export interface ClockStamp {
  /** AudioContext time paired with performanceTime by getOutputTimestamp. */
  contextTime: number
  /** performance.now() value for that same output frame. */
  performanceTime: number
}

export type RepeatRate = '1/8' | '1/16' | '1/32'

const REPEAT_BEATS: Record<RepeatRate, number> = {
  '1/8': 1 / 2,
  '1/16': 1 / 4,
  '1/32': 1 / 8,
}

/** Audio-clock time of an input. Uses the event timestamp, not the time the handler runs. */
export function contextTimeForEvent(eventMs: number, stamp: ClockStamp): number {
  return stamp.contextTime + (eventMs - stamp.performanceTime) / 1000
}

/**
 * Context time of the audio the player was hearing.
 * outputLatency and baseLatency pull the note back onto the click that reached the speaker.
 * calibrationSec is the measured loopback minus that estimate (0 until Calibrate).
 */
export function heardContextTime(eventMs: number, stamp: ClockStamp, outputLatency: number, baseLatency: number, calibrationSec: number): number {
  return contextTimeForEvent(eventMs, stamp) - outputLatency - baseLatency - calibrationSec
}

export function heardBeat(opts: {
  eventMs: number
  stamp: ClockStamp
  originContext: number
  originBeat: number
  tempo: number
  outputLatency: number
  baseLatency: number
  calibrationSec: number
  quantizeBeats?: number
}): number {
  const heard = heardContextTime(opts.eventMs, opts.stamp, opts.outputLatency, opts.baseLatency, opts.calibrationSec)
  const beat = opts.originBeat + (heard - opts.originContext) * (opts.tempo / 60)
  return quantizeBeat(beat, opts.quantizeBeats ?? 0)
}

/** 0 grid leaves the beat untouched. Record quantize is off unless a grid is set. */
export function quantizeBeat(beat: number, gridBeats: number): number {
  if (!(gridBeats > 0)) return beat
  return Math.round(beat / gridBeats) * gridBeats
}

export function repeatIntervalBeats(rate: RepeatRate, triplet: boolean): number {
  return REPEAT_BEATS[rate] * (triplet ? 2 / 3 : 1)
}

export function repeatIntervalSeconds(rate: RepeatRate, triplet: boolean, tempo: number): number {
  return repeatIntervalBeats(rate, triplet) * (60 / Math.max(1, tempo))
}

/** Includes the attack and every repeat strictly before the release. */
export function repeatBeats(startBeat: number, endBeat: number, intervalBeats: number): number[] {
  if (!(endBeat > startBeat)) return [startBeat]
  if (!(intervalBeats > 0)) return [startBeat]
  const marks: number[] = []
  const limit = endBeat - intervalBeats * 1e-6
  for (let beat = startBeat; beat <= limit; beat += intervalBeats) marks.push(beat)
  return marks.length ? marks : [startBeat]
}

/** Sample positions of repeats. Used by the voice so the main thread cannot drag them. */
export function repeatSampleMarks(startSample: number, endSample: number, intervalSamples: number): number[] {
  if (!(intervalSamples > 0)) return [startSample]
  const marks: number[] = []
  for (let sample = startSample; sample < endSample; sample += intervalSamples) marks.push(sample)
  return marks.length ? marks : [startSample]
}

/**
 * MIDIMessageEvent.timeStamp is a DOMHighResTimeStamp, the same clock as performance.now().
 * A value that is clearly in microseconds (legacy) is scaled down.
 */
export function midiPerformanceMs(timeStamp: number, nowMs: number): number {
  if (timeStamp > nowMs * 100 && timeStamp > 1_000_000_000) return timeStamp / 1000
  return timeStamp
}

/** Seconds to subtract so a performance lines up with what was heard. */
export function monitoringOffset(outputLatency: number, baseLatency: number, loopbackSec: number | null): number {
  if (loopbackSec == null || !Number.isFinite(loopbackSec)) return Math.max(0, outputLatency) + Math.max(0, baseLatency)
  return Math.max(0, loopbackSec)
}

export function calibrationTrim(outputLatency: number, baseLatency: number, loopbackSec: number | null): number {
  if (loopbackSec == null || !Number.isFinite(loopbackSec)) return 0
  return loopbackSec - (Math.max(0, outputLatency) + Math.max(0, baseLatency))
}

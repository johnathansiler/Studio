import { describe, expect, it } from 'vitest'
import { createVoices, renderDrum, repeatsInBlock, residentDrums, triggerVoice } from '../model/drums'
import {
  calibrationTrim,
  contextTimeForEvent,
  heardBeat,
  midiPerformanceMs,
  monitoringOffset,
  repeatBeats,
  repeatIntervalSeconds,
  repeatSampleMarks,
} from '../model/midiClock'

describe('recorded timing ignores main-thread jank', () => {
  it.each([60, 120, 240])('places a note within 1 ms at %i BPM after a late handler', (tempo) => {
    const outputLatency = 0.02
    const baseLatency = 0.008
    for (const jank of [50, 120, 200]) {
      const eventMs = 10_000
      const processedMs = eventMs + jank
      const stamp = { contextTime: 5, performanceTime: processedMs }
      const beat = heardBeat({
        eventMs,
        stamp,
        originContext: 0,
        originBeat: 0,
        tempo,
        outputLatency,
        baseLatency,
        calibrationSec: 0,
      })
      const intendedContext = contextTimeForEvent(eventMs, stamp) - outputLatency - baseLatency
      const intendedBeat = intendedContext * (tempo / 60)
      const errorMs = Math.abs(beat - intendedBeat) * (60 / tempo) * 1000
      expect(errorMs).toBeLessThan(1)
      const late = heardBeat({
        eventMs: processedMs,
        stamp,
        originContext: 0,
        originBeat: 0,
        tempo,
        outputLatency,
        baseLatency,
        calibrationSec: 0,
      })
      expect(Math.abs(late - beat) * (60 / tempo) * 1000).toBeGreaterThan(jank - 1)
    }
  })

  it('maps a hardware MIDI timestamp on the same clock as the pointer', () => {
    const now = 8_000
    const midiMs = midiPerformanceMs(now - 30, now)
    const pointerMs = now - 30
    const stamp = { contextTime: 3, performanceTime: now }
    expect(contextTimeForEvent(midiMs, stamp)).toBeCloseTo(contextTimeForEvent(pointerMs, stamp), 6)
    expect(contextTimeForEvent(midiMs, stamp)).toBeCloseTo(2.97, 6)
  })

  it('keeps quantize off unless a grid is chosen', () => {
    const stamp = { contextTime: 1.013, performanceTime: 0 }
    const raw = heardBeat({ eventMs: 0, stamp, originContext: 1, originBeat: 0, tempo: 120, outputLatency: 0, baseLatency: 0, calibrationSec: 0 })
    const locked = heardBeat({ eventMs: 0, stamp, originContext: 1, originBeat: 0, tempo: 120, outputLatency: 0, baseLatency: 0, calibrationSec: 0, quantizeBeats: 0.25 })
    expect(raw).toBeCloseTo(0.026, 4)
    expect(locked).toBe(0)
  })

  it('uses a measured loopback when Calibrate has run', () => {
    expect(monitoringOffset(0.02, 0.01, null)).toBeCloseTo(0.03)
    expect(monitoringOffset(0.02, 0.01, 0)).toBe(0)
    expect(calibrationTrim(0.02, 0.01, 0.05)).toBeCloseTo(0.02)
    expect(0.02 + 0.01 + calibrationTrim(0.02, 0.01, 0.05)).toBeCloseTo(0.05)
  })
})

describe('voices are ready before the first hit', () => {
  it('triggers a resident drum without building another buffer', () => {
    const drums = residentDrums(48000)
    expect(drums).toHaveLength(16)
    const kick = drums[0].samples
    expect(kick.length).toBeGreaterThan(1000)
    const again = renderDrum('kick', 48000)
    expect(again).not.toBe(kick)
    const voices = createVoices(16)
    const started = performance.now()
    const voice = triggerVoice(voices, 36, 0.8, 0)
    expect(performance.now() - started).toBeLessThan(1)
    expect(voices).toHaveLength(16)
    expect(voice.drumIndex).toBe(0)
    expect(voice.active).toBe(true)
    expect(kick.length).toBe(drums[0].samples.length)
  })
})

describe('note repeat', () => {
  it('fires 1/16 notes on the grid and triplets closer together', () => {
    expect(repeatIntervalSeconds('1/16', false, 120)).toBeCloseTo(0.125)
    expect(repeatIntervalSeconds('1/8', false, 120)).toBeCloseTo(0.25)
    expect(repeatIntervalSeconds('1/32', false, 120)).toBeCloseTo(0.0625)
    expect(repeatIntervalSeconds('1/16', true, 120)).toBeCloseTo(0.125 * (2 / 3))
    expect(repeatBeats(0, 0.5, 0.125)).toEqual([0, 0.125, 0.25, 0.375])
    const marks = repeatSampleMarks(0, 18000, Math.round(0.125 * 48000))
    expect(marks).toEqual([0, 6000, 12000])
  })

  it('counts repeats inside the audio block rather than on the main thread', () => {
    const voices = createVoices(1)
    const voice = triggerVoice(voices, 42, 1, 4, 100)
    expect(repeatsInBlock(voice, 250)).toBe(2)
    expect(repeatsInBlock(voice, 50)).toBe(0)
  })
})

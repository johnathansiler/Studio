import { describe, expect, it } from 'vitest'
import { continuousCeiling, softClip } from '../audio/sample/pitch'
import { san } from '../instruments/patch/dsp'
import {
  ATTACK_SEC,
  DRUM_PEAK,
  acceptNoteOn,
  attackReached,
  builtinLevel,
  clearNote,
  drumLevel,
  liveWhen,
  mixMatchedNotes,
  renderMatchedNote,
  scheduleDelaySeconds,
  transparentLimit,
} from '../audio/liveStage'

describe('live input latency and level', () => {
  it('schedules a live note at currentTime with no lookahead', () => {
    const now = 12.345
    expect(liveWhen(now)).toBe(now)
    expect(scheduleDelaySeconds(liveWhen(now), now)).toBe(0)
    const live = renderMatchedNote('live', 60, 0.9, 48000, 4800, now)
    const play = renderMatchedNote('playback', 60, 0.9, 48000, 4800, now)
    expect(live.scheduleDelay).toBe(0)
    expect(play.scheduleDelay).toBe(0)
    let diff = 0
    for (let i = 0; i < live.audio.length; i++) diff = Math.max(diff, Math.abs(live.audio[i] - play.audio[i]))
    expect(diff).toBe(0)
  })

  it('keeps a single voice under the clip and inside a 2–5 ms attack', () => {
    const note = renderMatchedNote('live', 69, 1, 48000, 4800, 1)
    expect(note.peak).toBeGreaterThan(0.02)
    expect(note.peak).toBeLessThanOrEqual(builtinLevel(1) + 1e-6)
    expect(note.peak).toBeLessThan(0.98)
    const attack = attackReached(note.audio, 48000, 0.5)
    expect(attack).toBeGreaterThan(0.001)
    expect(attack).toBeLessThanOrEqual(ATTACK_SEC + 0.001)
  })

  it('matches live and playback waveforms and does not clip a chord', () => {
    const rate = 48000
    const notes = [60, 64, 67, 71].map((pitch) => ({ pitch, velocity: 1 }))
    const live = mixMatchedNotes(notes, rate, rate / 4)
    const play = mixMatchedNotes(notes, rate, rate / 4)
    expect(live.voices).toBe(notes.length)
    expect(live.peak).toBeLessThanOrEqual(1)
    expect(play.peak).toBeCloseTo(live.peak, 6)
    let diff = 0
    for (let i = 0; i < live.mix.length; i++) diff = Math.max(diff, Math.abs(live.mix[i] - play.mix[i]))
    expect(diff).toBe(0)
    const hot = mixMatchedNotes(Array.from({ length: 12 }, (_, i) => ({ pitch: 48 + i, velocity: 1 })), rate, 2400)
    expect(hot.peak).toBeLessThanOrEqual(1)
    expect(hot.voices).toBeLessThanOrEqual(16)
  })

  it('drops a double note-on and still retriggers after a release', () => {
    const last = new Map<number, number>()
    expect(acceptNoteOn(last, 60, 1)).toBe(true)
    expect(acceptNoteOn(last, 60, 1.003)).toBe(false)
    expect(acceptNoteOn(last, 64, 1.003)).toBe(true)
    clearNote(last, 60)
    expect(acceptNoteOn(last, 60, 1.004)).toBe(true)
    const mixed = mixMatchedNotes([
      { pitch: 60, velocity: 1, at: 0 },
      { pitch: 60, velocity: 1, at: 0.002 },
    ], 48000, 2400)
    expect(mixed.voices).toBe(1)
  })

  it('limits overs without the old downward jump', () => {
    expect(softClip(0.5)).toBeCloseTo(0.5, 6)
    expect(softClip(0.98)).toBeCloseTo(0.98, 6)
    expect(Math.abs(softClip(0.981) - 0.98)).toBeLessThan(0.01)
    expect(Math.abs(softClip(4))).toBeLessThanOrEqual(1)
    expect(san(0.5)).toBeCloseTo(0.5, 6)
    expect(san(1)).toBeCloseTo(1, 6)
    expect(san(1.2)).toBeGreaterThan(0.99)
    expect(Math.abs(san(1.2) - Math.tanh(1.2))).toBeGreaterThan(0.1)
    expect(continuousCeiling(1)).toBeCloseTo(1, 6)
    expect(transparentLimit(0.2)).toBeCloseTo(0.2, 6)
  })

  it('puts a full-velocity drum near -12 dB', () => {
    const level = drumLevel(1)
    expect(level).toBeCloseTo(DRUM_PEAK, 5)
    expect(20 * Math.log10(level)).toBeGreaterThan(-14)
    expect(20 * Math.log10(level)).toBeLessThan(-10)
    expect(level).toBeLessThan(0.98)
  })
})

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Performer, type PlayedNote } from '../audio/performer'
import type { AudioEngine } from '../audio/engine'
import {
  BEAT_RATES,
  BeatRepeat,
  beatAt,
  beatRepeatHeld,
  blockHitOffsets,
  contextAt,
  firstGridIndex,
  gridInterval,
  hardwareMidiAllowed,
  hitFrame,
  swungGridBeat,
  type RepeatClock,
} from '../model/beatRepeat'
import type { RepeatRate } from '../model/midiClock'

const rate = 48000

function clock(tempo = 120, originContext = 0, originBeat = 0): RepeatClock {
  return { originContext, originBeat, tempo, sampleRate: rate }
}

function arm(machine: BeatRepeat, pitch = 36, velocity = 0.8, fromBeat = 0, interval = 0.25, swing = 50) {
  machine.arm({ pitch, velocity, fromBeat, interval, swing })
}

describe('beat repeat grid', () => {
  it('locks 1/4, 1/8, 1/16, 1/32 and triplets to the transport', () => {
    expect(BEAT_RATES).toEqual(['1/4', '1/8', '1/16', '1/32'])
    expect(gridInterval('1/4', false)).toBe(1)
    expect(gridInterval('1/8', false)).toBe(0.5)
    expect(gridInterval('1/16', false)).toBe(0.25)
    expect(gridInterval('1/32', false)).toBe(0.125)
    expect(gridInterval('1/16', true)).toBeCloseTo(0.25 * (2 / 3))
    expect(gridInterval('1/8', true)).toBeCloseTo(0.5 * (2 / 3))
    const grid = clock()
    const machine = new BeatRepeat()
    arm(machine, 36, 0.8, 0.1, 0.25, 50)
    const { play } = machine.take(grid, 0, 0.5)
    expect(play.map((hit) => hit.beat)).toEqual([0.25, 0.5, 0.75])
    expect(play[0].when).toBeCloseTo(0.125, 12)
    expect(play[0].frame).toBe(hitFrame(0.125, rate))
    expect(play[0].durationBeats).toBeCloseTo(0.225)
  })

  it('keeps the grid time when the look-ahead runs late', () => {
    const grid = clock()
    const machine = new BeatRepeat()
    arm(machine)
    const late = machine.take(grid, 0.05, 0.5)
    const hit = late.play.find((item) => item.beat === 0.25)
    expect(hit?.when).toBeCloseTo(0.125, 12)
    expect(hit?.frame).toBe(6000)
    expect(late.play.some((item) => item.beat === 0)).toBe(false)
    expect(Math.abs((hit?.when ?? 0) - 0.05)).toBeGreaterThan(0.05)
  })

  it('stays within one sample of the musical grid across tempo and rate', () => {
    for (const tempo of [60, 90, 120, 140, 174]) {
      for (const division of BEAT_RATES) {
        for (const triplet of [false, true]) {
          const interval = gridInterval(division, triplet)
          const machine = new BeatRepeat()
          arm(machine, 36, 0.7, 0, interval, 50)
          const grid = clock(tempo, 2.5, 0)
          const horizon = 2.5 + 8 * interval * (60 / tempo) + 0.01
          const { play } = machine.take(grid, 2.5, horizon)
          expect(play.length).toBeGreaterThan(3)
          const ideal = interval * (60 / tempo) * rate
          for (let i = 1; i < play.length; i++) {
            const frames = play[i].frame - play[0].frame
            expect(Math.abs(frames - ideal * i)).toBeLessThan(1)
          }
        }
      }
    }
  })

  it('lines up with a transport that is not at beat zero', () => {
    const grid = clock(120, 10, 4)
    const machine = new BeatRepeat()
    arm(machine, 36, 1, 4.1, 0.25, 50)
    const { play } = machine.take(grid, 10, 10.4)
    expect(play[0].beat).toBeCloseTo(4.25)
    expect(play[0].when).toBeCloseTo(10.125, 12)
    expect(play[0].frame).toBe(Math.round(10.125 * rate))
    expect(Math.abs(play[0].frame - Math.round(contextAt(grid, 4.25) * rate))).toBe(0)
  })

  it('swings only the odd grid points', () => {
    const machine = new BeatRepeat()
    arm(machine, 36, 1, 0, 0.25, 75)
    const { play } = machine.take(clock(), 0, 0.5)
    expect(play.map((hit) => Number(hit.beat.toFixed(6)))).toEqual([0, 0.375, 0.5, 0.875])
    expect(swungGridBeat(1, 0.25, 50)).toBeCloseTo(0.25)
    expect(firstGridIndex(0.25, 0.25, 50)).toBe(1)
  })

  it('repeats several pads at once and keeps each press velocity', () => {
    const machine = new BeatRepeat()
    arm(machine, 36, 0.4, 0, 0.25, 50)
    arm(machine, 42, 0.2, 0, 0.25, 50)
    machine.pressure(36, 0.9, 0.3)
    const { play } = machine.take(clock(), 0, 0.3)
    const kick = play.filter((hit) => hit.pitch === 36)
    const hat = play.filter((hit) => hit.pitch === 42)
    expect(kick.map((hit) => hit.beat)).toEqual(hat.map((hit) => hit.beat))
    expect(kick.find((hit) => hit.beat === 0.25)?.velocity).toBeCloseTo(0.4)
    expect(kick.find((hit) => hit.beat === 0.5)?.velocity).toBeCloseTo(0.9)
    expect(hat[0].velocity).toBeCloseTo(0.2)
    machine.arm({ pitch: 36, velocity: 0.1, fromBeat: 0.2, interval: 0.25, swing: 50 })
    const again = machine.take(clock(), 0.3, 0.6)
    expect(again.play.some((hit) => hit.beat <= 0.5 && hit.pitch === 36)).toBe(false)
  })

  it('records quantized hits and drops the ones after the finger lifts', () => {
    const machine = new BeatRepeat()
    arm(machine, 38, 0.55, 0, gridInterval('1/8', false), 50)
    const grid = clock()
    const first = machine.take(grid, 0, 1)
    expect(first.record.map((hit) => hit.beat)).toEqual([0])
    expect(first.record[0].velocity).toBeCloseTo(0.55)
    machine.release(38, 1.2)
    const rest = machine.take(grid, 1, 1.2)
    expect(rest.record.map((hit) => hit.beat)).toEqual([0.5, 1])
    expect(rest.play).toEqual([])
    expect(rest.record.every((hit) => Math.abs(hit.beat / 0.5 - Math.round(hit.beat / 0.5)) < 1e-9)).toBe(true)
  })

  it('places a hit on the sample inside the audio block', () => {
    expect(blockHitOffsets([-1, 100, 130, 200, 256], 128, 128)).toEqual([
      { offset: 0, frame: 128 },
      { offset: 2, frame: 130 },
      { offset: 72, frame: 200 },
    ])
    const grid = clock(100, 0, 0)
    const when = contextAt(grid, beatAt(grid, 0.2))
    expect(Math.abs(hitFrame(when, rate) - Math.round(0.2 * rate))).toBeLessThan(1)
  })

  it('does not schedule repeats from a timer', () => {
    const source = readFileSync(new URL('../model/beatRepeat.ts', import.meta.url), 'utf8')
    const performer = readFileSync(new URL('../audio/performer.ts', import.meta.url), 'utf8')
    expect(source.includes('setInterval')).toBe(false)
    expect(source.includes('setTimeout')).toBe(false)
    expect(performer.includes('setInterval')).toBe(false)
    const machine = new BeatRepeat()
    arm(machine, 36, 1, 0, gridInterval('1/16', false), 50)
    const { play } = machine.take(clock(), 0, 1)
    for (let i = 1; i < play.length; i++) {
      expect(Math.abs(play[i].when - play[i - 1].when - 0.125)).toBeLessThan(1e-9)
      expect(Math.abs(play[i].when - play[i - 1].when - 0.025)).toBeGreaterThan(0.05)
    }
  })
})

describe('beat repeat latch and midi', () => {
  it('holds while the finger is down and toggles when latched', () => {
    expect(beatRepeatHeld(false, false, 'down')).toBe(true)
    expect(beatRepeatHeld(true, false, 'up')).toBe(false)
    expect(beatRepeatHeld(false, true, 'down')).toBe(true)
    expect(beatRepeatHeld(true, true, 'up')).toBe(true)
    expect(beatRepeatHeld(true, true, 'down')).toBe(false)
  })

  it('hides hardware MIDI on iPhone and keeps it for other devices', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
    expect(hardwareMidiAllowed(iphone)).toBe(false)
    expect(hardwareMidiAllowed('Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)')).toBe(false)
    expect(hardwareMidiAllowed('Mozilla/5.0 (Linux; Android 14; Pixel 8)')).toBe(true)
    expect(hardwareMidiAllowed('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe(true)
    expect(hardwareMidiAllowed('')).toBe(true)
  })
})

describe('pad, keyboard, and MIDI input share the grid', () => {
  it('records repeated hits from a pad, a key, and a MIDI pad on the same clock', async () => {
    let now = 0.01
    const played: { when: number; pitch: number; velocity: number }[] = []
    const recorded: PlayedNote[] = []
    let closed = 0
    const engine = {
      transportPlaying: false,
      tempo: 120,
      sampleRate: rate,
      positionSamples: 0,
      unlock: () => ({ currentTime: now }),
      playOrigin: () => ({ context: 0, beat: 0 }),
      outputStamp: () => ({ contextTime: now, performanceTime: 0 }),
      clockCompensation: () => ({ outputLatency: 0, baseLatency: 0, calibrationSec: 0 }),
      setRepeatWatch: () => undefined,
      cancelPadHits: () => undefined,
      duckPad: () => undefined,
      liveNoteOff: () => undefined,
      liveGain: () => undefined,
      liveDrum: () => undefined,
      liveNoteOn: () => undefined,
      playBuffer: () => undefined,
      schedulePadHit: (when: number, pitch: number, velocity: number) => played.push({ when, pitch, velocity }),
    }
    const performer = new Performer(
      engine as unknown as AudioEngine,
      () => ({ trackId: 'drums', clipId: 'clip', drums: true }),
      (_target, notes) => recorded.push(...notes),
      () => true,
      () => undefined,
      () => { closed += 1 },
    )
    performer.setGrid('1/16' as RepeatRate, false)
    performer.setEngaged(true)
    performer.down(36, 0.8, 0, 1)
    performer.down(42, 0.4, 0, 2)
    performer.midi(new Uint8Array([0x90, 38, 127]), 0, 0)
    await Promise.resolve()
    const kick = played.filter((hit) => hit.pitch === 36)
    expect(kick.length).toBeGreaterThan(1)
    expect(kick[0].when).toBeCloseTo(0.01, 6)
    expect(kick[1].when).toBeCloseTo(0.135, 6)
    expect(played.filter((hit) => hit.pitch === 42).map((hit) => hit.when)).toEqual(kick.map((hit) => hit.when))
    expect(played.filter((hit) => hit.pitch === 38).length).toBe(kick.length)
    expect(recorded.some((note) => note.pitch === 36 && note.startBeat === 0)).toBe(true)
    now = 0.2
    performer.pumpRepeats(now, now + 0.35)
    expect(recorded.some((note) => note.pitch === 42 && note.startBeat === 0.25)).toBe(true)
    performer.up(1, 200)
    performer.up(2, 200)
    performer.midi(new Uint8Array([0x80, 38, 0]), 200, 200)
    expect(closed).toBeGreaterThan(0)
    expect(recorded.every((note) => Math.abs(note.startBeat * 4 - Math.round(note.startBeat * 4)) < 1e-6)).toBe(true)
  })
})

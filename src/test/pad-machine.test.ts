import { describe, expect, it } from 'vitest'
import {
  bankPitch,
  chainSong,
  chokeTargets,
  chopSample,
  doubleLength,
  eraseWhilePlaying,
  gridPitch,
  locksAtBeat,
  noteForPlayback,
  recordTake,
  sixteenLevels,
  stepFires,
  swungRepeats,
  timingCorrect,
  unitHash,
  velocityInRange,
} from '../model/padMachine'
import { repeatIntervalBeats } from '../model/midiClock'

describe('pad deck', () => {
  it('spreads one sample across 16 levels', () => {
    const quiet = sixteenLevels(0, 'velocity')
    const loud = sixteenLevels(15, 'velocity')
    expect(quiet.velocity).toBeCloseTo(1 / 16)
    expect(loud.velocity).toBe(1)
    expect(quiet.tune).toBe(0)
    expect(sixteenLevels(0, 'tune').tune).toBeCloseTo(-12)
    expect(sixteenLevels(15, 'tune').tune).toBeCloseTo(12)
    expect(sixteenLevels(0, 'filter').filter).toBe(0)
    expect(sixteenLevels(15, 'filter').filter).toBe(1)
    expect(sixteenLevels(0, 'decay').decay).toBeCloseTo(1 / 16)
    expect(sixteenLevels(15, 'decay').decay).toBe(1)
    expect(sixteenLevels(0, 'attack').attack).toBe(0)
    expect(sixteenLevels(15, 'attack').attack).toBe(1)
    expect(bankPitch(0, 0)).toBe(36)
    expect(bankPitch(0, 4)).toBe(42)
  })

  it('swings note repeats and leaves straight 50% timing alone', () => {
    expect(repeatIntervalBeats('1/4', false)).toBe(1)
    expect(repeatIntervalBeats('1/16', false)).toBe(0.25)
    expect(swungRepeats(0, 1, 0.25, 50)).toEqual([0, 0.25, 0.5, 0.75])
    const swung = swungRepeats(0, 1, 0.25, 75)
    expect(swung[0]).toBeCloseTo(0)
    expect(swung[1]).toBeCloseTo(0.375)
    expect(swung[2]).toBeCloseTo(0.5)
    expect(swung[3]).toBeCloseTo(0.875)
    expect(timingCorrect(0.2, 0.25, 1, 50, false)).toBeCloseTo(0.2)
    expect(timingCorrect(0.2, 0.25, 1, 50, true)).toBeCloseTo(0.25)
    expect(timingCorrect(0.2, 0.25, 0, 75, true)).toBeCloseTo(0.2)
  })

  it('chokes pads that share a group', () => {
    const pads = [
      { pitch: 36, choke: 0 },
      { pitch: 42, choke: 1 },
      { pitch: 46, choke: 1 },
      { pitch: 38, choke: 2 },
    ]
    expect(chokeTargets(pads, 42)).toEqual([46])
    expect(chokeTargets(pads, 46)).toEqual([42])
    expect(chokeTargets(pads, 36)).toEqual([])
    expect(chokeTargets(pads, 38)).toEqual([])
  })

  it('draws the same seeded probability twice', () => {
    expect(unitHash(7, 3, 1)).toBe(unitHash(7, 3, 1))
    let fires = 0
    const first: boolean[] = []
    for (let step = 0; step < 400; step++) {
      const hit = stepFires(0.5, 'always', 7, step, 0, false)
      first.push(hit)
      if (hit) fires += 1
    }
    const second = Array.from({ length: 400 }, (_, step) => stepFires(0.5, 'always', 7, step, 0, false))
    expect(second).toEqual(first)
    expect(fires).toBeGreaterThan(160)
    expect(fires).toBeLessThan(240)
    for (let bar = 0; bar < 8; bar++) {
      expect(stepFires(1, '1:2', 1, 0, bar, false)).toBe(bar % 2 === 0)
      expect(stepFires(1, '1:4', 1, 0, bar, false)).toBe(bar % 4 === 0)
    }
    expect(stepFires(1, 'fill', 1, 0, 0, false)).toBe(false)
    expect(stepFires(1, 'fill', 1, 0, 0, true)).toBe(true)
    expect(velocityInRange(0.2, 0.8, 0)).toBeCloseTo(0.2)
    expect(velocityInRange(0.2, 0.8, 1)).toBeCloseTo(0.8)
    expect(velocityInRange(0.2, 0.8, 0.5)).toBeCloseTo(0.5)
  })

  it('applies parameter locks on the exact step only', () => {
    const events = [{ step: 4, locks: { filter: 0.25, velocity: 0.4 } }]
    expect(locksAtBeat(events, 1, 0.25)).toEqual({ filter: 0.25, velocity: 0.4 })
    expect(locksAtBeat(events, 0.75, 0.25)).toBeNull()
    expect(locksAtBeat(events, 1 - 1e-4, 0.25)).toBeNull()
    expect(locksAtBeat(events, 1 + 1e-6, 0.25)?.filter).toBe(0.25)
    expect(locksAtBeat([{ step: 4, nudge: 0.01, locks: { tune: 3 } }], 1, 0.25)).toBeNull()
    expect(locksAtBeat([{ step: 4, nudge: 0.01, locks: { tune: 3 } }], 1.01, 0.25)?.tune).toBe(3)
    const onStep = noteForPlayback({ startBeat: 1, velocity: 0.9, locks: { velocity: 0.4 } }, { stepBeats: 0.25, seed: 1, bar: 0, fill: false })
    const offStep = noteForPlayback({ startBeat: 0.9, velocity: 0.9, nudge: 0, locks: { velocity: 0.4 } }, { stepBeats: 0.25, seed: 1, bar: 0, fill: false })
    expect(onStep?.velocity).toBe(0.4)
    expect(offStep?.locks).toBeUndefined()
    expect(offStep?.velocity).toBe(0.9)
  })

  it('erases one pad while the others keep playing', () => {
    const notes = [
      { pitch: 36, startBeat: 0 },
      { pitch: 38, startBeat: 1 },
      { pitch: 36, startBeat: 1.25 },
      { pitch: 36, startBeat: 3 },
    ]
    const left = eraseWhilePlaying(notes, 36, 1, 2)
    expect(left.map((note) => note.startBeat)).toEqual([0, 1, 3])
    expect(left.find((note) => note.startBeat === 1)?.pitch).toBe(38)
  })

  it('chains sequences in song order', () => {
    const spans = chainSong(
      [{ sequenceId: 'A', repeats: 2 }, { sequenceId: 'B', repeats: 1 }, { sequenceId: 'missing', repeats: 1 }],
      [{ id: 'A', lengthBeats: 4 }, { id: 'B', lengthBeats: 8 }],
    )
    expect(spans).toEqual([
      { id: 'A', start: 0, end: 4 },
      { id: 'A', start: 4, end: 8 },
      { id: 'B', start: 8, end: 16 },
    ])
  })

  it('maps an in-key grid from the root', () => {
    const root = gridPitch(0, 0, 0, 'ionian', 'fourths', true)
    const neighbor = gridPitch(0, 1, 0, 'ionian', 'fourths', true)
    const above = gridPitch(1, 0, 0, 'ionian', 'fourths', true)
    expect(root).toEqual({ pitch: 60, isRoot: true })
    expect(neighbor).toEqual({ pitch: 62, isRoot: false })
    expect(above).toEqual({ pitch: 65, isRoot: false })
    expect(gridPitch(0, 1, 60, 'ionian', 'sequential', false).pitch).toBe(61)
    expect(gridPitch(1, 0, 60, 'ionian', 'fourths', false).pitch).toBe(65)
  })

  it('doubles a sequence and replaces a loop range', () => {
    const doubled = doubleLength([{ startBeat: 0 }, { startBeat: 1 }], 4)
    expect(doubled.lengthBeats).toBe(8)
    expect(doubled.notes.map((note) => note.startBeat)).toEqual([0, 1, 4, 5])
    const replaced = recordTake([{ startBeat: 0 }, { startBeat: 1 }, { startBeat: 3 }], [{ startBeat: 1.5 }], 'replace', 1, 2)
    expect(replaced.map((note) => note.startBeat)).toEqual([0, 3, 1.5])
    const data = new Float32Array(100)
    expect(chopSample(data, 1000, 'regions', { regions: 4 }).map((chop) => chop.start)).toEqual([0, 25, 50, 75])
    const clicks = new Float32Array(8000)
    clicks[2000] = 1
    clicks[5000] = 1
    const onsets = chopSample(clicks, 1000, 'transient', { threshold: 0.2 }).map((chop) => chop.start)
    expect(onsets[0]).toBe(0)
    expect(onsets).toContain(2000)
    expect(onsets).toContain(5000)
  })
})

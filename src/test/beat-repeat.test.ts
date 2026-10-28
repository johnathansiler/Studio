import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { Performer, type PlayedNote } from '../audio/performer'
import {
  anchorClock,
  beatRepeatSwitch,
  firstGridIndex,
  gridBeatAt,
  gridRepeatBeats,
  gridSample,
  takeGridHits,
  type GridCursor,
} from '../model/beatRepeat'
import { repeatIntervalBeats } from '../model/midiClock'

const workletUrl = new URL('../../public/worklets/keys.js', import.meta.url)

function workletScheduler() {
  const source = readFileSync(fileURLToPath(workletUrl), 'utf8')
  const start = source.indexOf('// grid-scheduler-start')
  const end = source.indexOf('// grid-scheduler-end')
  const body = source.slice(start, end)
  const load = new Function(`${body}\nreturn { gridBeatAt, firstGridIndex, gridSample, takeGridHits }`) as () => {
    gridBeatAt: typeof gridBeatAt
    firstGridIndex: typeof firstGridIndex
    gridSample: typeof gridSample
    takeGridHits: typeof takeGridHits
  }
  return { source, api: load() }
}

function clockPerformer(recording: boolean) {
  const committed: PlayedNote[][] = []
  const grids: { pitch: number; intervalBeats: number; armedBeat: number; swing: number; tempo: number }[] = []
  const offs: { pitch: number; releaseBeat?: number }[] = []
  const engine = {
    tempo: 120,
    sampleRate: 48000,
    musicalClock: () => ({ originContext: 10, originBeat: 4, tempo: 120 }),
    outputStamp: () => ({ contextTime: 10, performanceTime: 1000 }),
    clockCompensation: () => ({ outputLatency: 0, baseLatency: 0, calibrationSec: 0 }),
    playOrigin: () => ({ context: 10, beat: 4 }),
    liveGridRepeat: (opts: { pitch: number; intervalBeats: number; armedBeat: number; swing: number; tempo: number }) => {
      grids.push({ pitch: opts.pitch, intervalBeats: opts.intervalBeats, armedBeat: opts.armedBeat, swing: opts.swing, tempo: opts.tempo })
    },
    liveDrum: () => undefined,
    liveNoteOn: () => undefined,
    liveNoteOff: (pitch: number, releaseBeat?: number) => offs.push({ pitch, releaseBeat }),
    playBuffer: () => undefined,
    liveGain: () => undefined,
  }
  const performer = new Performer(
    engine as unknown as AudioEngine,
    () => ({ trackId: 'drums', clipId: 'pattern', drums: true }),
    (_target, notes) => committed.push(notes),
    () => recording,
    () => undefined,
  )
  performer.setDeck({
    kit: null,
    swing: 50,
    fullLevel: false,
    accent: false,
    erase: false,
    latch: false,
    levels: null,
    fixedBeats: 0,
    recordMode: 'overdub',
    sampleOf: () => null,
  })
  return { performer, committed, grids, offs }
}

describe('beat repeat locks to the tempo grid', () => {
  it('places 1/16, 1/8, and triplet hits on the bar grid and leaves the release off', () => {
    expect(repeatIntervalBeats('1/16', false)).toBe(0.25)
    expect(repeatIntervalBeats('1/16', true)).toBeCloseTo(0.25 * (2 / 3))
    expect(gridRepeatBeats(0, 0.5, 0.25, 50)).toEqual([0, 0.25])
    expect(gridRepeatBeats(0.1, 1, 0.25, 50)).toEqual([0.25, 0.5, 0.75])
    expect(gridRepeatBeats(0.05, 0.2, 0.25, 50)).toEqual([])
    const triplet = gridRepeatBeats(0, 0.5, 0.25 * (2 / 3), 50)
    expect(triplet).toHaveLength(3)
    expect(triplet[1]).toBeCloseTo(1 / 6)
    expect(triplet[2]).toBeCloseTo(1 / 3)
    const shuffled = gridRepeatBeats(0, 1, 0.25, 75)
    expect(shuffled[0]).toBeCloseTo(0)
    expect(shuffled[1]).toBeCloseTo(0.375)
    expect(shuffled[2]).toBeCloseTo(0.5)
    expect(shuffled[3]).toBeCloseTo(0.875)
  })

  it('schedules those hits on exact audio samples, including a late block', () => {
    expect(gridSample(0.25, 0, 0, 120, 48000)).toBe(6000)
    expect(gridSample(0.5, 0, 0, 120, 48000)).toBe(12000)
    expect(gridSample(0.5, 0, 0, 90, 48000)).toBe(16000)
    expect(gridSample(0.375, 0, 0, 120, 48000)).toBe(9000)
    expect(gridBeatAt(1, 0.25, 0.5)).toBeCloseTo(0.375)

    const onGrid = { nextIndex: firstGridIndex(0.2, 0.25, 0) }
    expect(takeGridHits(onGrid, 6000, 128, 48000, 0, 0, 120, 0.25, 0, 0.2, Infinity)).toEqual([0])
    expect(onGrid.nextIndex).toBe(2)

    const inside = { nextIndex: firstGridIndex(0.2, 0.25, 0) }
    expect(takeGridHits(inside, 5888, 256, 48000, 0, 0, 120, 0.25, 0, 0.2, Infinity)).toEqual([112])

    const late = { nextIndex: firstGridIndex(0.2, 0.25, 0) }
    expect(takeGridHits(late, 6100, 128, 48000, 0, 0, 120, 0.25, 0, 0.2, Infinity)).toEqual([0])
    expect(late.nextIndex).toBe(2)
    const nextBlock = takeGridHits(late, 6228, 128, 48000, 0, 0, 120, 0.25, 0, 0.2, Infinity)
    expect(nextBlock).toEqual([])

    const held = { nextIndex: firstGridIndex(0, 0.25, 0) }
    expect(takeGridHits(held, 0, 20000, 48000, 0, 0, 120, 0.25, 0, 0, 0.5)).toEqual([0, 6000])
  })

  it('keeps one stopped-playhead grid until the playhead or tempo moves', () => {
    const first = anchorClock(null, 0, 0, 120, 3.5)
    expect(anchorClock(first, 0, 0, 120, 9)).toBe(first)
    const sought = anchorClock(first, 48000, 2, 120, 9)
    expect(sought.originContext).toBe(9)
    expect(sought.originBeat).toBe(2)
    expect(anchorClock(sought, 48000, 2, 90, 9).tempo).toBe(90)
  })

  it('reads the momentary MIDI switch and ignores pad notes', () => {
    expect(beatRepeatSwitch(new Uint8Array([0xb0, 119, 127]))).toBe(true)
    expect(beatRepeatSwitch(new Uint8Array([0xb0, 119, 0]))).toBe(false)
    expect(beatRepeatSwitch(new Uint8Array([0x90, 36, 100]))).toBeNull()
  })

  it('uses the same scheduler the audio worklet runs, with no UI timer', () => {
    const { source, api } = workletScheduler()
    expect(source.includes('setTimeout')).toBe(false)
    expect(source.includes('setInterval')).toBe(false)
    const cases: [GridCursor, number, number, number, number][] = [
      [{ nextIndex: 0 }, 0, 128, 0, Infinity],
      [{ nextIndex: 1 }, 6100, 128, 0.2, Infinity],
      [{ nextIndex: 1 }, 5888, 256, 0.2, 1],
      [{ nextIndex: 0 }, 16000, 128, 0, 2],
    ]
    for (const [cursor, frame, frames, armed, release] of cases) {
      const model = { nextIndex: cursor.nextIndex }
      const audio = { nextIndex: cursor.nextIndex }
      const left = takeGridHits(model, frame, frames, 48000, 0, 0, 120, 0.25, 0, armed, release)
      const right = api.takeGridHits(audio, frame, frames, 48000, 0, 0, 120, 0.25, 0, armed, release)
      expect(right).toEqual(left)
      expect(audio.nextIndex).toBe(model.nextIndex)
    }
    expect(api.gridSample(0.25, 0, 0, 120, 48000)).toBe(gridSample(0.25, 0, 0, 120, 48000))
    expect(api.firstGridIndex(0.1, 0.25, 0.5)).toBe(firstGridIndex(0.1, 0.25, 0.5))
  })
})

describe('holding a pad records the grid while Beat Repeat is held', () => {
  it('prints 1/16 notes from the press to the release and stops when the button lets go', () => {
    const { performer, committed, grids, offs } = clockPerformer(true)
    performer.setRepeat('1/16', false, 1000)
    performer.down(36, 1, 1000, 7)
    expect(grids[0]).toMatchObject({ pitch: 36, intervalBeats: 0.25, armedBeat: 4, tempo: 120, swing: 0 })
    performer.up(7, 1500)
    expect(committed).toHaveLength(1)
    expect(committed[0].map((note) => note.startBeat)).toEqual([4, 4.25, 4.5, 4.75])
    expect(offs[0]).toEqual({ pitch: 36, releaseBeat: 5 })

    performer.setRepeat('1/16', false, 2000)
    performer.down(36, 1, 2000, 8)
    performer.setRepeat(null, false, 2500)
    expect(committed).toHaveLength(2)
    expect(committed[1].map((note) => note.startBeat)).toEqual([6, 6.25, 6.5, 6.75])
    performer.up(8, 2800)
    expect(committed).toHaveLength(2)
  })

  it('skips the grid point before the finger and waits out a hold that misses the grid', () => {
    const { performer, committed, grids } = clockPerformer(true)
    performer.setRepeat('1/16', false)
    performer.down(42, 0.8, 1050, 1)
    performer.up(1, 1500)
    expect(grids[0].armedBeat).toBeCloseTo(4.1)
    expect(committed[0].map((note) => note.startBeat)).toEqual([4.25, 4.5, 4.75])

    performer.down(42, 0.8, 1025, 2)
    performer.up(2, 1100)
    expect(committed).toHaveLength(1)
  })

  it('shuffles the odd hits and follows a MIDI pad while recording is off', () => {
    const { performer, committed } = clockPerformer(false)
    performer.setDeck({
      kit: null,
      swing: 75,
      fullLevel: false,
      accent: false,
      erase: false,
      latch: false,
      levels: null,
      fixedBeats: 0,
      recordMode: 'overdub',
      sampleOf: () => null,
    })
    performer.setRepeat('1/16', false)
    performer.down(36, 1, 1000, 3)
    performer.up(3, 1500)
    const swung = performer.capture()
    expect(committed).toHaveLength(0)
    expect(swung.map((note) => note.startBeat)).toEqual([4, 4.375, 4.5, 4.875])

    performer.setDeck({
      kit: null,
      swing: 50,
      fullLevel: false,
      accent: false,
      erase: false,
      latch: false,
      levels: null,
      fixedBeats: 0,
      recordMode: 'overdub',
      sampleOf: () => null,
    })
    performer.setRepeat('1/8', false)
    performer.midi(new Uint8Array([0x90, 38, 96]), 1000, 1000)
    performer.midi(new Uint8Array([0x80, 38, 0]), 1500, 1500)
    expect(performer.capture().map((note) => note.startBeat)).toEqual([4, 4.5])
  })
})

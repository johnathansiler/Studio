import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { emptyTap, formatTempo, noteTapRelease, pushTap, roundTempo, scaleTempo, shownTempo, tempoFromTaps } from '../model/tap'
import { ProjectStore } from '../state/store'

describe('tap tempo', () => {
  it('turns steady 500 ms taps into 120 BPM from the second tap', () => {
    let memory = emptyTap()
    let result = pushTap(memory, 0)
    memory = result.memory
    expect(result.bpm).toBeNull()
    expect(memory.taps).toEqual([0])
    result = pushTap(memory, 500)
    memory = result.memory
    expect(result.bpm).toBe(120)
    result = pushTap(memory, 1000)
    memory = result.memory
    expect(result.bpm).toBe(120)
    result = pushTap(memory, 1510)
    expect(result.bpm).toBe(119.2)
    expect(result.memory.taps).toHaveLength(4)
  })

  it('refreshes the displayed BPM after every tap from the second', () => {
    let memory = emptyTap()
    let display = 90
    const text: string[] = []
    for (const at of [0, 500, 1100, 1600]) {
      const result = pushTap(memory, at)
      memory = result.memory
      display = shownTempo(display, result)
      text.push(formatTempo(display))
    }
    expect(text).toEqual(['90', '120', '109.1', '112.5'])
    expect(text[1]).not.toBe(text[0])
    expect(text[2]).not.toBe(text[1])
    expect(text[3]).not.toBe(text[2])
  })

  it('starts a new sequence after a gap over two seconds', () => {
    let memory = emptyTap()
    for (const at of [0, 500, 1000]) memory = pushTap(memory, at).memory
    const restarted = pushTap(memory, 3500)
    expect(restarted.reset).toBe(true)
    expect(restarted.bpm).toBeNull()
    expect(restarted.memory.taps).toEqual([3500])
    const next = pushTap(restarted.memory, 4000)
    expect(next.bpm).toBe(120)
    expect(shownTempo(90, restarted)).toBe(90)
    expect(shownTempo(90, next)).toBe(120)
  })

  it('rejects taps faster than 0.2 s or slower than 2 s', () => {
    let memory = pushTap(emptyTap(), 0).memory
    const fast = pushTap(memory, 199)
    expect(fast.ignored).toBe(true)
    expect(fast.bpm).toBeNull()
    expect(fast.memory.taps).toEqual([0])
    const quick = pushTap(memory, 200)
    expect(quick.ignored).toBe(false)
    expect(quick.bpm).toBe(300)
    const slow = pushTap(memory, 2001)
    expect(slow.reset).toBe(true)
    expect(slow.bpm).toBeNull()
    expect(slow.memory.taps).toEqual([2001])
    const floor = pushTap(memory, 2000)
    expect(floor.ignored).toBe(false)
    expect(floor.bpm).toBe(30)
  })

  it('keeps a tempo change in the rolling average', () => {
    let memory = emptyTap()
    for (const at of [0, 500, 1000]) memory = pushTap(memory, at).memory
    const next = pushTap(memory, 1700)
    expect(next.ignored).toBe(false)
    expect(next.memory.taps).toEqual([0, 500, 1000, 1700])
    expect(next.bpm).toBe(105.9)
    expect(shownTempo(120, next)).toBe(105.9)
  })

  it('is 60 over the mean of the last eight intervals', () => {
    const gaps = [400, 420, 440, 460, 480, 500, 520, 540, 560]
    let memory = emptyTap()
    let at = 0
    let result = pushTap(memory, at)
    memory = result.memory
    for (const gap of gaps) {
      at += gap
      result = pushTap(memory, at)
      memory = result.memory
    }
    const kept = gaps.slice(-8)
    const mean = kept.reduce((sum, gap) => sum + gap, 0) / kept.length
    expect(memory.taps).toHaveLength(9)
    expect(tempoFromTaps(memory.taps)).toBeCloseTo(60000 / mean, 6)
    expect(result.bpm).toBe(Math.round((60000 / mean) * 10) / 10)
  })

  it('does not count the click that follows a pointer tap', () => {
    let memory = emptyTap()
    let result = pushTap(memory, 0, 'pointer')
    memory = result.memory
    result = pushTap(memory, 500, 'pointer')
    memory = result.memory
    expect(result.bpm).toBe(120)
    const echo = pushTap(memory, 900, 'click')
    expect(echo.ignored).toBe(true)
    expect(echo.memory.taps).toEqual([0, 500])
    expect(shownTempo(120, echo)).toBe(120)
    result = pushTap(echo.memory, 1000, 'pointer')
    expect(result.bpm).toBe(120)
    expect(result.memory.taps).toEqual([0, 500, 1000])
    const keys = pushTap(pushTap(emptyTap(), 0, 'click').memory, 500, 'click')
    expect(keys.bpm).toBe(120)
    const typed = pushTap(pushTap(emptyTap(), 0, 'pointer').memory, 500, 'key')
    expect(typed.bpm).toBe(120)
    let held = pushTap(emptyTap(), 0, 'pointer').memory
    held = noteTapRelease(held, 4000)
    const late = pushTap(held, 4010, 'click')
    expect(late.ignored).toBe(true)
    expect(late.memory.taps).toEqual([0])
    const ghost = pushTap(late.memory, 4500, 'click')
    expect(ghost.ignored).toBe(true)
    expect(ghost.memory.taps).toEqual([0])
    const after = pushTap(ghost.memory, 5600, 'click')
    expect(after.reset).toBe(true)
    expect(after.memory.taps).toEqual([5600])
  })

  it('keeps a rolling average of the last eight intervals', () => {
    let memory = emptyTap()
    let result = pushTap(memory, 0)
    memory = result.memory
    for (let i = 1; i <= 12; i++) {
      result = pushTap(memory, i * 500)
      memory = result.memory
    }
    expect(memory.taps).toHaveLength(9)
    expect(memory.taps[0]).toBe(2000)
    expect(result.bpm).toBe(120)
    let at = memory.taps[memory.taps.length - 1]
    for (let i = 0; i < 8; i++) {
      at += 600
      result = pushTap(memory, at)
      memory = result.memory
    }
    expect(memory.taps).toHaveLength(9)
    expect(result.bpm).toBe(100)
  })

  it('writes each new display tempo onto the project from the second tap', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setTempo(90)
    store.project.tempoMap = [{ beat: 0, bpm: 90 }]
    let memory = emptyTap()
    let display = store.project.tempo
    const seen: number[] = []
    for (const at of [0, 500, 1100, 1600]) {
      const result = pushTap(memory, at)
      memory = result.memory
      display = shownTempo(display, result)
      if (result.bpm != null) store.setTempo(result.bpm, true)
      seen.push(display)
    }
    expect(seen).toEqual([90, 120, 109.1, 112.5])
    expect(store.project.tempo).toBe(112.5)
    expect(store.project.tempoMap?.[0]?.bpm).toBe(112.5)
    expect(seen[2]).not.toBe(seen[1])
    expect(seen[3]).not.toBe(seen[2])
    store.undo()
    expect(store.project.tempo).toBe(90)
    store.undo()
    expect(store.project.tempo).toBe(120)
  })

  it('rounds to a tenth or a whole number inside 30–300 and undoes the group once', () => {
    expect(roundTempo(119.64, false)).toBe(119.6)
    expect(roundTempo(119.64, true)).toBe(120)
    expect(scaleTempo(20, 0.5, false)).toBe(30)
    expect(scaleTempo(200, 2, true)).toBe(300)
    const store = new ProjectStore(createEmptyProject())
    store.setTempo(100, true)
    store.setTempo(110, true)
    store.setTempo(119.6, true)
    expect(store.project.tempo).toBe(119.6)
    store.undo()
    expect(store.project.tempo).toBe(120)
    store.setTempo(90, true)
    store.endTempoGroup()
    store.setTempo(80, true)
    store.undo()
    expect(store.project.tempo).toBe(90)
  })
})

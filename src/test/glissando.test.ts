import { describe, expect, it } from 'vitest'
import { glideNotes, glideUpdate } from '../model/glissando'

describe('keyboard glissando', () => {
  it('turns each entered key on and the key it left off, one note per pointer', () => {
    let held = new Map<number, number>()
    const down = glideUpdate(held, 1, 60, 'down')
    held = down.held
    expect(down.change).toEqual({ pointerId: 1, off: null, on: 60 })
    const slide = glideUpdate(held, 1, 61, 'move')
    held = slide.held
    expect(slide.change).toEqual({ pointerId: 1, off: 60, on: 61 })
    const other = glideUpdate(held, 2, 72, 'down')
    held = other.held
    expect(other.change).toEqual({ pointerId: 2, off: null, on: 72 })
    expect([...held.entries()]).toEqual([[1, 61], [2, 72]])
    const next = glideUpdate(held, 1, 64, 'move')
    held = next.held
    expect(next.change).toEqual({ pointerId: 1, off: 61, on: 64 })
    expect(held.get(2)).toBe(72)
    expect(glideUpdate(held, 1, 64, 'move').change).toBeNull()
    expect(glideUpdate(held, 3, 67, 'move').change).toBeNull()
    const lift = glideUpdate(held, 2, null, 'up')
    expect(lift.change).toEqual({ pointerId: 2, off: 72, on: null })
    expect(lift.held.get(1)).toBe(64)
  })

  it('records each glided key at the pointer time for mouse and touch', () => {
    const notes = glideNotes([
      { pointerId: 4, phase: 'down', pitch: 60, timeMs: 1000 },
      { pointerId: 4, phase: 'move', pitch: 62, timeMs: 1080 },
      { pointerId: 7, phase: 'down', pitch: 72, timeMs: 1100 },
      { pointerId: 4, phase: 'move', pitch: 64, timeMs: 1200 },
      { pointerId: 4, phase: 'up', pitch: null, timeMs: 1300 },
      { pointerId: 7, phase: 'move', pitch: 74, timeMs: 1400 },
      { pointerId: 7, phase: 'up', pitch: null, timeMs: 1550 },
    ])
    expect(notes).toEqual([
      { pointerId: 4, pitch: 60, startMs: 1000, endMs: 1080 },
      { pointerId: 4, pitch: 62, startMs: 1080, endMs: 1200 },
      { pointerId: 4, pitch: 64, startMs: 1200, endMs: 1300 },
      { pointerId: 7, pitch: 72, startMs: 1100, endMs: 1400 },
      { pointerId: 7, pitch: 74, startMs: 1400, endMs: 1550 },
    ])
  })
})

import { describe, expect, it } from 'vitest'
import { emptyTap, pushTap, roundTempo, scaleTempo } from '../model/tap'
import { ProjectStore } from '../state/store'
import { createEmptyProject } from '../model/types'

describe('tap tempo', () => {
  it('averages the last taps and commits on the third', () => {
    let memory = emptyTap()
    let result = pushTap(memory, 0)
    memory = result.memory
    expect(result.commit).toBeNull()
    result = pushTap(memory, 500)
    memory = result.memory
    expect(result.live).toBe(120)
    expect(result.commit).toBeNull()
    result = pushTap(memory, 1000)
    memory = result.memory
    expect(result.commit).toBe(120)
    result = pushTap(memory, 1510)
    expect(result.commit).toBe(119.2)
    const many = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000]
    memory = emptyTap()
    for (const at of many) {
      result = pushTap(memory, at)
      memory = result.memory
    }
    expect(memory.taps).toHaveLength(8)
    expect(result.commit).toBe(120)
  })

  it('drops an outlier and resets after a two second gap', () => {
    let memory = emptyTap()
    for (const at of [0, 500, 1000]) {
      memory = pushTap(memory, at).memory
    }
    const skipped = pushTap(memory, 1100)
    expect(skipped.ignored).toBe(true)
    expect(skipped.commit).toBeNull()
    expect(skipped.memory.taps).toEqual(memory.taps)
    const next = pushTap(memory, 1500)
    expect(next.commit).toBe(120)
    const restarted = pushTap(next.memory, 4000)
    expect(restarted.memory.taps).toEqual([4000])
    expect(restarted.commit).toBeNull()
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
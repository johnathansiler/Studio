import { describe, expect, it } from 'vitest'
import { applySmartDrums, drumRole, mulberry32 } from '../model/smartDrums'
import { ProjectStore } from '../state/store'
import { renderPattern } from '../model/steps'

describe('smart drum random', () => {
  it('keeps kicks on the downbeat, snares on the backbeat, and ghosts quiet', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    for (let seed = 1; seed <= 8; seed += 1) {
      applySmartDrums(pattern, null, mulberry32(seed))
      const kick = pattern.channels.find((channel) => drumRole(channel) === 'kick')!
      const snare = pattern.channels.find((channel) => drumRole(channel) === 'snare')!
      const hat = pattern.channels.find((channel) => drumRole(channel) === 'hat')!
      const open = pattern.channels.find((channel) => drumRole(channel) === 'openhat')
      const count = pattern.steps
      const kickOn = kick.cells.slice(0, count).filter((cell) => cell.on)
      expect(kick.cells[0].on, `seed ${seed}`).toBe(true)
      expect(kick.cells[4].on, `seed ${seed}`).toBe(false)
      expect(kick.cells[12].on, `seed ${seed}`).toBe(false)
      expect(kickOn.length).toBeGreaterThanOrEqual(3)
      expect(kickOn.length).toBeLessThanOrEqual(5)
      expect(snare.cells[4].on).toBe(true)
      expect(snare.cells[12].on).toBe(true)
      const ghosts = snare.cells.slice(0, count).filter((cell, index) => cell.on && index !== 4 && index !== 12)
      expect(ghosts.length).toBeLessThanOrEqual(3)
      for (const ghost of ghosts) expect(ghost.velocity).toBeLessThanOrEqual(0.35)
      const hats = hat.cells.slice(0, count).filter((cell) => cell.on)
      expect(hats.length).toBeGreaterThanOrEqual(4)
      expect(hats.length).toBeLessThanOrEqual(12)
      if (open) {
        const openOn = open.cells.slice(0, count).filter((cell) => cell.on)
        expect(openOn.length).toBeLessThanOrEqual(3)
        for (let step = 0; step < count; step += 1) {
          if (open.cells[step]?.on) expect(hat.cells[step].on).toBe(false)
        }
      }
    }
  })

  it('randomizes only the selected sound and plays those hits from the pattern', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    const kick = pattern.channels.find((channel) => channel.kind === 'kick')!
    const before = kick.cells.map((cell) => cell.on)
    const snare = pattern.channels.find((channel) => channel.kind === 'snare')!
    const snareBefore = snare.cells.map((cell) => cell.on)
    store.selectRackChannel(snare.id)
    store.smartRandomDrums(3)
    expect(kick.cells.map((cell) => cell.on)).toEqual(before)
    expect(store.activePattern()!.channels.find((channel) => channel.kind === 'snare')!.cells[4].on).toBe(true)
    store.undo()
    expect(store.activePattern()!.channels.find((channel) => channel.kind === 'snare')!.cells.map((cell) => cell.on)).toEqual(snareBefore)
    store.smartRandomDrums(4)
    expect(renderPattern(store.activePattern()!, 0, 4).length).toBeGreaterThan(0)
  })
})

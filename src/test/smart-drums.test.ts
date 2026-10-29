import { describe, expect, it } from 'vitest'
import { applySmartDrums, drumRole, mulberry32 } from '../model/smartDrums'
import { ProjectStore } from '../state/store'
import { renderPattern } from '../model/steps'

function lit(store: ProjectStore, name?: string) {
  const pattern = store.activePattern()!
  return pattern.channels
    .filter((channel) => !name || channel.name === name)
    .map((channel) => `${channel.name}:${channel.cells.slice(0, pattern.steps).map((cell) => (cell.on ? '1' : '0')).join('')}`)
    .join('|')
}

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

  it('draws a new variation on every Random press, and one undo undoes one press', () => {
    const store = new ProjectStore()
    const original = lit(store)
    store.smartRandomDrums()
    const first = lit(store)
    expect(first).not.toEqual(original)
    store.smartRandomDrums()
    const second = lit(store)
    expect(second).not.toEqual(first)
    const pattern = store.activePattern()!
    const kick = pattern.channels.find((channel) => channel.kind === 'kick')!
    const snare = pattern.channels.find((channel) => channel.kind === 'snare')!
    const clap = pattern.channels.find((channel) => channel.kind === 'clap')!
    const hat = pattern.channels.find((channel) => channel.kind === 'hat')!
    const perc = pattern.channels.find((channel) => channel.kind === 'perc')!
    expect(kick.cells[0].on).toBe(true)
    expect(kick.cells[4].on).toBe(false)
    expect(kick.cells[12].on).toBe(false)
    expect(snare.cells[4].on).toBe(true)
    expect(snare.cells[12].on).toBe(true)
    expect(clap.cells[4].on).toBe(true)
    expect(clap.cells[12].on).toBe(true)
    const hats = hat.cells.slice(0, pattern.steps).filter((cell) => cell.on)
    expect(hats.length).toBeGreaterThanOrEqual(4)
    expect(hats.length).toBeLessThanOrEqual(12)
    const percOn = perc.cells.slice(0, pattern.steps).filter((cell) => cell.on)
    expect(percOn.length).toBeGreaterThanOrEqual(1)
    expect(percOn.length).toBeLessThanOrEqual(4)
    store.undo()
    expect(lit(store)).toEqual(first)
    store.undo()
    expect(lit(store)).toEqual(original)
  })

  it('changes only the selected row, and that row is a different variation', () => {
    const store = new ProjectStore()
    const kick = store.activePattern()!.channels.find((channel) => channel.kind === 'kick')!
    store.selectRackChannel(kick.id)
    const others = () => lit(store).split('|').filter((row) => !row.startsWith('Kick:')).join('|')
    const beforeOthers = others()
    store.smartRandomDrums()
    const first = lit(store, 'Kick')
    expect(others()).toEqual(beforeOthers)
    store.smartRandomDrums()
    const second = lit(store, 'Kick')
    expect(second).not.toEqual(first)
    expect(others()).toEqual(beforeOthers)
    store.undo()
    expect(lit(store, 'Kick')).toEqual(first)
    expect(others()).toEqual(beforeOthers)
  })

  it('repeats a pattern only when the test injects the same seed', () => {
    const store = new ProjectStore()
    store.smartRandomDrums(11)
    const first = lit(store)
    store.undo()
    store.smartRandomDrums(11)
    expect(lit(store)).toEqual(first)
    store.smartRandomDrums(12)
    expect(lit(store)).not.toEqual(first)
  })
})

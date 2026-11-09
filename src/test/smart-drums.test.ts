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

  it('follows the loaded sound when rows are reordered or renamed, and a plain downbeat when the role is unknown', () => {
    const store = new ProjectStore()
    const pattern = store.activePattern()!
    const kick = pattern.channels.find((channel) => channel.kind === 'kick')!
    const snare = pattern.channels.find((channel) => channel.kind === 'snare')!
    const rest = pattern.channels.filter((channel) => channel !== kick && channel !== snare)
    pattern.channels = [snare, kick, ...rest]
    expect(pattern.channels[0].kind).toBe('snare')
    applySmartDrums(pattern, null, mulberry32(5))
    expect(snare.cells[4].on).toBe(true)
    expect(snare.cells[12].on).toBe(true)
    expect(kick.cells[0].on).toBe(true)
    expect(kick.cells[4].on).toBe(false)
    expect(kick.cells[12].on).toBe(false)
    expect(drumRole({ name: 'Dusty Kick', kind: 'note' })).toBe('kick')
    expect(drumRole({ name: 'Room Tone', kind: 'note' })).toBe('other')
    expect(drumRole({ name: 'Upright Piano', kind: 'note' })).toBe('melodic')
    expect(drumRole({ name: 'Closed Hat', kind: 'kick' })).toBe('hat')

    const custom = store.addPatternChannel({ name: 'Dusty Kick', kind: 'note', note: 36, color: '#eee', sampleId: 'lib_dust' })
    const piano = store.addPatternChannel({ name: 'Upright Piano', kind: 'note', note: 60, color: '#ddd', sampleId: 'lib_piano' })
    const noise = store.addPatternChannel({ name: 'Room Tone', kind: 'note', note: 64, color: '#ccc', sampleId: 'lib_room' })
    const swingBefore = store.activePattern()!.swing
    store.setPatternSwing(0.22)
    store.setPatternLength(32)
    store.smartRandomDrums(6)
    const next = store.activePattern()!
    const dusty = next.channels.find((channel) => channel.id === custom)!
    const keys = next.channels.find((channel) => channel.id === piano)!
    const room = next.channels.find((channel) => channel.id === noise)!
    expect(dusty.sampleId).toBe('lib_dust')
    expect(keys.sampleId).toBe('lib_piano')
    expect(room.sampleId).toBe('lib_room')
    expect(dusty.name).toBe('Dusty Kick')
    expect(next.swing).toBe(0.22)
    expect(next.steps).toBe(32)
    expect(dusty.cells[0].on).toBe(true)
    expect(dusty.cells[4].on).toBe(false)
    expect(dusty.cells[16].on).toBe(true)
    expect(dusty.cells[20].on).toBe(false)
    expect(keys.cells.slice(0, 32).some((cell) => cell.on)).toBe(true)
    expect(keys.cells.slice(0, 32).every((cell) => cell.on)).toBe(false)
    const pitches = new Set(keys.cells.slice(0, 32).filter((cell) => cell.on).map((cell) => cell.pitch))
    expect(pitches.size).toBeGreaterThan(1)
    for (let step = 0; step < 32; step += 1) {
      if (room.cells[step].on) expect(step % 16 === 0 || step % 16 === 8).toBe(true)
    }
    expect(room.cells[0].on).toBe(true)
    expect(room.cells.filter((cell, index) => index < 16 && cell.on).length).toBeLessThanOrEqual(2)
    const saved = JSON.parse(JSON.stringify(store.project))
    const opened = new ProjectStore(saved)
    const kept = opened.activePattern()!
    expect(kept.steps).toBe(32)
    expect(kept.swing).toBe(0.22)
    expect(kept.channels.find((channel) => channel.sampleId === 'lib_dust')!.cells[0].on).toBe(true)
    expect(kept.channels.find((channel) => channel.sampleId === 'lib_piano')!.cells.some((cell) => cell.on && cell.pitch !== 0)).toBe(true)
    const beforeUndo = lit(store, 'Dusty Kick')
    const pianoBefore = lit(store, 'Upright Piano')
    store.selectRackChannel(custom!)
    store.smartRandomDrums()
    expect(lit(store, 'Upright Piano')).toEqual(pianoBefore)
    expect(lit(store, 'Dusty Kick')).not.toEqual(beforeUndo)
    store.undo()
    expect(lit(store, 'Dusty Kick')).toEqual(beforeUndo)
    expect(store.activePattern()!.channels.find((channel) => channel.id === custom)!.sampleId).toBe('lib_dust')
    expect(store.activePattern()!.steps).toBe(32)
    expect(store.activePattern()!.swing).toBe(0.22)
    expect(swingBefore).toBe(0)
  })

  it('keeps a loaded sample on the hits Smart Pattern writes for the sequencer', () => {
    const store = new ProjectStore()
    const tone = new Float32Array(480)
    tone.fill(0.6)
    store.addAsset({ id: 'lib_loaded', name: 'Loaded Kick', sampleRate: 48000, channels: [tone] })
    const id = store.addPatternChannel({ name: 'Loaded Kick', kind: 'note', note: 36, color: '#ef6b6b', sampleId: 'lib_loaded' })
    store.selectRackChannel(id!)
    store.smartRandomDrums(4)
    const channel = store.activePattern()!.channels.find((row) => row.id === id)!
    expect(channel.sampleId).toBe('lib_loaded')
    expect(channel.kind).toBe('note')
    expect(channel.cells[0].on).toBe(true)
    expect(channel.cells[4].on).toBe(false)
    expect(store.buffers.get('lib_loaded')?.channels[0]?.length).toBe(480)
    const hits = renderPattern(store.activePattern()!, 0, 4).filter((hit) => hit.channelId === id)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.sampleId === 'lib_loaded' && hit.kind === 'note')).toBe(true)
  })

  it('keeps swing and writes only the steps a short pattern can play', () => {
    const store = new ProjectStore()
    store.setPatternSwing(0.15)
    store.setPatternLength(7)
    store.smartRandomDrums(2)
    const pattern = store.activePattern()!
    const kick = pattern.channels.find((channel) => channel.kind === 'kick')!
    expect(pattern.steps).toBe(7)
    expect(pattern.swing).toBe(0.15)
    expect(kick.steps).toBe(7)
    expect(kick.cells[0].on).toBe(true)
    expect(kick.cells[4].on).toBe(false)
    const hits = renderPattern(pattern, 0, 7 * 0.25)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((hit) => hit.startBeat < 2)).toBe(true)
    store.undo()
    expect(store.activePattern()!.steps).toBe(7)
    expect(store.activePattern()!.channels.find((channel) => channel.kind === 'kick')!.cells[0].on).toBe(true)
    store.undo()
    expect(store.activePattern()!.steps).toBe(16)
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

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSoundScoutCatalog } from '../sounds/catalog'
import { factoryPresets } from '../presets/factory'
import { INIT_NAME } from '../presets/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import {
  BEAT_KITS,
  beatKitByPreset,
  dedicatedRoleEntries,
  resolveBeatKit,
  voiceDecay,
  voiceLevel,
  voiceMatchesRole,
} from '../instruments/pads/kits'
import { pickDefaultKit } from '../instruments/pads/record'

const catalog = parseSoundScoutCatalog(JSON.parse(readFileSync(new URL('./fixtures/soundscout-2026-11-09.json', import.meta.url), 'utf8')))
const byId = new Map(catalog.map((entry) => [entry.id, entry]))

describe('beat machine kits', () => {
  it('keeps the kick at the preset level and decay', () => {
    expect(voiceLevel(0.85, 1)).toBeCloseTo(0.85)
    expect(voiceDecay(0.45, 1)).toBeCloseTo(0.45)
    expect(voiceDecay(1, 0.2)).toBeCloseTo(0.2)
    expect(voiceDecay(0.45, 0.2)).toBeGreaterThan(0.2)
    expect(voiceDecay(0.45, 0.2)).toBeLessThan(0.45)
  })

  it('gives every factory preset a unique, catalog-backed, role-matched kit', () => {
    const factoryNames = factoryPresets('pads').map((preset) => preset.name)
    expect(factoryNames.length).toBeGreaterThan(0)
    for (const name of [INIT_NAME, ...factoryNames]) {
      const kit = beatKitByPreset(name)
      expect(kit, name).toBeTruthy()
      const voices = resolveBeatKit(kit!, catalog)
      expect(voices, name).toBeTruthy()
      expect(voices).toHaveLength(16)
      expect(new Set(voices!.map((voice) => voice.id)).size).toBe(16)
      const shas = voices!.map((voice) => byId.get(voice.id)?.sha256)
      expect(shas.every(Boolean)).toBe(true)
      expect(new Set(shas).size).toBe(16)
      for (const voice of voices!) {
        const entry = byId.get(voice.id)
        expect(entry, voice.id).toBeTruthy()
        expect(entry!.type).toBe('one-shot')
        expect(entry!.license).toBe('CC0-1.0')
        expect(entry!.origin).not.toBe('private')
        expect(`${entry!.name} ${entry!.path} ${entry!.pack ?? ''} ${entry!.source}`).not.toMatch(/goldbaby|sampleradar/i)
        expect(entry!.durationSec).toBeGreaterThan(0)
        expect(entry!.durationSec).toBeLessThan(2.5)
        const dedicated = dedicatedRoleEntries(catalog, voice.role)
        if (voice.role !== 'kick' && voice.role !== 'rim') expect(dedicated).toEqual([])
        expect(voiceMatchesRole(voice.role, entry!, dedicated)).toBe(true)
      }
      expect(voices![0].role).toBe('kick')
      expect(voices!.find((voice) => voice.role === 'rim')).toBeTruthy()
    }
    expect(beatKitByPreset('Init')?.id).toBe('808')
    expect(BEAT_KITS.map((kit) => kit.preset)).toEqual([
      'Init',
      'Tight Kit',
      'Room Kit',
      'Boom Bap',
      'Trap',
      'House',
      'Lo-fi',
      'Rock',
      'Dry Close',
    ])
  })

  it('loads the 808 set as the default kit', () => {
    const picks = pickDefaultKit(catalog)
    expect(picks.map((pick) => pick.id)).toEqual(resolveBeatKit(beatKitByPreset('Init')!, catalog)!.map((voice) => voice.id))
    expect(picks[0].name).toBe('01 808 - C1')
    expect(byId.get(picks[0].id)?.tags).toContain('808')
    expect(byId.get(picks.find((pick) => pick.index === 2)!.id)?.tags).toContain('rim')
  })

  it('places a kit in one step without moving pad pitches', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const before = store.trackKit(id).banks[0].map((pad) => pad.pitch)
    store.placePadKit(id, 0, [
      { index: 0, name: '01 808 - C1', samples: new Float32Array([0.2, -0.2]), sampleRate: 48000, level: 0.8, tune: 0, decay: 1 },
      { index: 4, name: '17 808 - E2', samples: new Float32Array([0.1, -0.1, 0.05]), sampleRate: 48000, level: 0.52, tune: 0, decay: 0.2 },
    ])
    const kit = store.trackKit(id)
    expect(kit.banks[0].map((pad) => pad.pitch)).toEqual(before)
    expect(kit.banks[0][0].name).toBe('Kick')
    expect(kit.banks[0][0].sampleName).toBe('01 808 - C1')
    expect(kit.banks[0][0].level).toBeCloseTo(0.8)
    expect(kit.banks[0][0].decay).toBeCloseTo(1)
    expect(kit.banks[0][4].sampleName).toBe('17 808 - E2')
    expect(kit.banks[0][4].level).toBeCloseTo(0.52)
    expect(kit.banks[0][4].decay).toBeCloseTo(0.2)
    expect(kit.banks[0][4].pitch).toBe(42)
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.trackKit(id).banks[0][0].sampleName).toBeUndefined()
  })
})

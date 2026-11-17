import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseSoundScoutCatalog } from '../sounds/catalog'
import { factoryPresets } from '../presets/factory'
import { INIT_NAME } from '../presets/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { planPads } from '../audio/voices/program'
import { residentDrums } from '../model/drums'
import { createKit, padAllowsResidentDrum } from '../model/padMachine'
import {
  BEAT_KITS,
  DEFAULT_BEAT_PRESET,
  beatKitByPreset,
  factoryKitSampleIssues,
  resolveBeatKit,
  voiceDecay,
  voiceLevel,
} from '../instruments/pads/kits'
import { pickDefaultKit } from '../instruments/pads/record'

const catalog = parseSoundScoutCatalog(JSON.parse(readFileSync(new URL('../../catalogs/soundscout-2026-11-17-4.json', import.meta.url), 'utf8')))
const byId = new Map(catalog.map((entry) => [entry.id, entry]))

describe('beat machine kits', () => {
  it('keeps the kick at the preset level and decay', () => {
    expect(voiceLevel(0.85, 1)).toBeCloseTo(0.85)
    expect(voiceDecay(0.45, 1)).toBeCloseTo(0.45)
    expect(voiceDecay(1, 0.2)).toBeCloseTo(0.2)
    expect(voiceDecay(0.45, 0.2)).toBeGreaterThan(0.2)
    expect(voiceDecay(0.45, 0.2)).toBeLessThan(0.45)
  })

  it('gives every factory preset a unique catalog drum and never a synthesized voice', () => {
    const factoryNames = factoryPresets('pads').map((preset) => preset.name)
    expect(factoryNames).toEqual([
      'Tight Kit',
      'Room Kit',
      'Boom Bap',
      'Trap',
      'House',
      'Lo-fi',
      'Rock',
      'Dry Close',
      'Boom Bap Trap',
      'Classic 909',
      'Jazz Kit',
    ])
    expect(BEAT_KITS.map((kit) => kit.preset)).toEqual([INIT_NAME, ...factoryNames])
    expect(DEFAULT_BEAT_PRESET).toBe('Boom Bap Trap')
    expect(factoryKitSampleIssues(BEAT_KITS, catalog)).toEqual([])
    const loader = readFileSync(new URL('../instruments/pads/load.ts', import.meta.url), 'utf8')
    const data = readFileSync(new URL('../instruments/pads/kitData.ts', import.meta.url), 'utf8')
    expect(loader).not.toContain('renderDrum')
    expect(data).not.toContain('renderDrum')
    for (const name of [INIT_NAME, ...factoryNames]) {
      const kit = beatKitByPreset(name)
      expect(kit, name).toBeTruthy()
      const voices = resolveBeatKit(kit!, catalog)
      expect(voices, name).toHaveLength(16)
      expect(new Set(voices!.map((voice) => voice.id)).size).toBe(16)
      expect(voices![0].role.toLowerCase()).toContain('kick')
      expect(voices![0].levelScale).toBe(1)
      for (const voice of voices!) {
        const entry = byId.get(voice.id)
        expect(entry, voice.id).toBeTruthy()
        expect(entry!.type).toBe('one-shot')
        expect(entry!.origin).not.toBe('private')
        expect(`${entry!.name} ${entry!.path} ${entry!.pack ?? ''} ${entry!.source}`).not.toMatch(/goldbaby|sampleradar/i)
        expect(entry!.drumRole?.replace(/_/g, '-')).toBe(voice.role.replace(/_/g, '-'))
        if (entry!.attributionRequired) expect(entry!.attributionText).toBeTruthy()
      }
    }
    expect(beatKitByPreset('Init')?.id).toBe('classic-808')
    expect(beatKitByPreset('Rock')?.family).toMatch(/Muldjord/i)
    expect(beatKitByPreset('Room Kit')?.family).toMatch(/DRS/i)
    expect(beatKitByPreset('Jazz Kit')?.family).toMatch(/AVL/i)
    expect(beatKitByPreset('Classic 909')?.family).toMatch(/Baker/i)
    const resident = residentDrums(48000).map((drum) => ({ pitch: drum.pitch, samples: drum.samples, sampleRate: 48000 }))
    const fresh = createKit().banks[0][1]
    expect(fresh.catalogPad).toBe(true)
    expect(padAllowsResidentDrum(fresh)).toBe(false)
    expect(planPads({ pads: [fresh], buffers: [], sampleRate: 48000, tempo: 120, resident }).slots).toHaveLength(0)
    const legacy = { ...fresh, catalogPad: false }
    expect(padAllowsResidentDrum(legacy)).toBe(true)
    expect(planPads({ pads: [legacy], buffers: [], sampleRate: 48000, tempo: 120, resident }).slots).toHaveLength(1)
  })

  it('loads Boom Bap Trap as the default kit and keeps Init on the classic 808', () => {
    const picks = pickDefaultKit(catalog)
    expect(picks.map((pick) => pick.id)).toEqual(resolveBeatKit(beatKitByPreset(DEFAULT_BEAT_PRESET)!, catalog)!.map((voice) => voice.id))
    expect(picks[0].name).toBe('Boombap Fuego 2 Kick 03')
    expect(byId.get(picks[0].id)?.drumRole).toBe('kick')
    expect(beatKitByPreset('Init')?.voices[0].soundId).toMatch(/fischer|808/i)
    const baker = byId.get(beatKitByPreset('Classic 909')!.voices[0].soundId)!
    expect(baker.unaltered).toBe(true)
    expect(baker.leadSilenceMs).toBeGreaterThan(0)
  })

  it('keeps an unaltered file intact and skips its lead-in at the pad start', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const samples = new Float32Array([0, 0, 0.4, -0.2])
    store.placePadKit(id, 0, [{
      index: 0,
      name: 'Baker kick',
      samples,
      sampleRate: 44100,
      preserve: true,
      catalog: true,
      start: 0.00029,
      credit: 'Jason Baker credit',
    }])
    const pad = store.trackKit(id).banks[0][0]
    expect(pad.region?.start).toBeGreaterThan(0)
    expect(pad.sampleCredit).toContain('Baker')
    expect(pad.catalogPad).toBe(true)
    const stored = store.buffers.get(pad.layers[0].bufferId!)!.channels[0]
    expect(Array.from(stored)).toEqual(Array.from(samples))
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

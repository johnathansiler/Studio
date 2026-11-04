import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { createKit } from '../model/padMachine'
import { starterPattern } from '../model/steps'
import { ProjectStore } from '../state/store'
import { applyBeatMachinePreset } from '../presets/beatMachine'
import { applyGroove, scalerPatch } from '../presets/apply'
import { boundsFor, resolveParams } from '../presets/bounds'
import { allFactoryPresets, factoryPresets, PRESET_PLUGINS } from '../presets/factory'
import { importPresetDocument, presetDocument, readPresetDocument } from '../presets/files'
import {
  commitChoice,
  deleteUserPreset,
  describePreset,
  duplicatePreset,
  presetByName,
  renameUserPreset,
  saveUserPreset,
} from '../presets/library'
import { memoryPresetBook } from '../presets/memory'
import { commitPluginPreset } from '../presets/project'
import { INIT_NAME } from '../presets/types'

describe('shared plugin presets', () => {
  it('loads every factory preset inside its parameter range', () => {
    const all = allFactoryPresets()
    expect(all.length).toBeGreaterThan(PRESET_PLUGINS.length * 6)
    for (const pluginId of PRESET_PLUGINS) {
      const presets = factoryPresets(pluginId)
      expect(presets.length).toBeGreaterThanOrEqual(6)
      expect(presets.length).toBeLessThanOrEqual(12)
      const names = new Set(presets.map((item) => item.name))
      expect(names.size).toBe(presets.length)
      for (const preset of presets) {
        expect(preset.source).toBe('factory')
        const resolved = resolveParams(pluginId, preset.params)
        for (const bound of boundsFor(pluginId)) {
          expect(Number.isFinite(resolved[bound.id]), `${pluginId} ${preset.name} ${bound.id}`).toBe(true)
          expect(resolved[bound.id], `${pluginId} ${preset.name} ${bound.id}`).toBeGreaterThanOrEqual(bound.min)
          expect(resolved[bound.id], `${pluginId} ${preset.name} ${bound.id}`).toBeLessThanOrEqual(bound.max)
        }
        if (pluginId === 'steps') expect(() => applyGroove(starterPattern(), resolved)).not.toThrow()
        if (pluginId === 'pads') expect(() => applyBeatMachinePreset(createKit(), { ...preset, params: resolved })).not.toThrow()
        if (pluginId === 'scaler') expect(() => scalerPatch(resolved, preset.text)).not.toThrow()
      }
    }
  })

  it('saves, renames, duplicates, and deletes user presets without touching factory ones', async () => {
    const book = memoryPresetBook()
    const saved = saveUserPreset([], 'eq', 'My Vocal', { midG: 2.5 })
    expect(saved.preset.id).not.toBe('')
    await book.write({ id: saved.preset.id, pluginId: 'eq', name: saved.preset.name, params: saved.preset.params })
    expect((await book.list()).map((item) => item.name)).toEqual(['My Vocal'])
    const renamed = renameUserPreset(saved.presets, 'eq', saved.preset.id, 'Lead Vocal')
    expect(renamed?.find((item) => item.id === saved.preset.id)?.name).toBe('Lead Vocal')
    const copied = duplicatePreset(renamed!, 'eq', presetByName('eq', renamed!, 'Lead Vocal')!)
    expect(copied.preset.name).toBe('Lead Vocal copy')
    const removed = deleteUserPreset(copied.presets, 'eq', saved.preset.id)
    expect(removed?.some((item) => item.id === saved.preset.id)).toBe(false)
    expect(deleteUserPreset(copied.presets, 'eq', 'factory:eq:Vocal Presence')).toBeNull()
    expect(renameUserPreset(copied.presets, 'eq', 'factory:eq:Vocal Presence', 'Nope')).toBeNull()
    expect(saveUserPreset([], 'eq', 'Vocal Presence', { midG: 1 }).preset.id).toBe('')
    await book.remove(saved.preset.id)
    expect(await book.list()).toEqual([])
  })

  it('marks a preset changed when a parameter moves, and revert matches the saved baseline', () => {
    const chosen = presetByName('compressor', [], 'Vocal Leveling')!
    const loaded = commitChoice([], 'comp-1', chosen)
    const clean = describePreset('compressor', loaded.params, undefined, loaded.presets, 'comp-1')
    expect(clean).toMatchObject({ name: 'Vocal Leveling', changed: false, source: 'factory', readOnly: true })
    const tweaked = { ...loaded.params, threshold: loaded.params.threshold - 4 }
    const dirty = describePreset('compressor', tweaked, undefined, loaded.presets, 'comp-1')
    expect(dirty.changed).toBe(true)
    expect(dirty.name).toBe('Vocal Leveling')
    const reverted = commitChoice(loaded.presets, 'comp-1', chosen)
    expect(describePreset('compressor', reverted.params, undefined, reverted.presets, 'comp-1').changed).toBe(false)
  })

  it('embeds the preset in the project and keeps it after a reload', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'eq')
    const eq = store.track(track.id)!.plugins.find((plugin) => plugin.pluginId === 'eq')!
    const chosen = presetByName('eq', [], 'Kick Punch')!
    const loaded = commitChoice(store.project.presets, eq.id, chosen)
    commitPluginPreset(store, track.id, eq.id, loaded.params, loaded.presets)
    expect(eq.params.lowG).toBeGreaterThan(0)
    const stamp = store.project.presets.find((item) => item.id === `active:${eq.id}`)
    expect(stamp?.pluginId).toBe('__active')
    expect(stamp?.name).toContain('Kick Punch')
    const saved = saveUserPreset(store.project.presets, 'eq', 'Room Kick', eq.params)
    commitPluginPreset(store, track.id, eq.id, eq.params, saved.presets)
    const reloaded = JSON.parse(JSON.stringify(store.project)) as typeof store.project
    expect(reloaded.presets.some((item) => item.pluginId === 'eq' && item.name === 'Room Kick')).toBe(true)
    expect(reloaded.presets.some((item) => item.id === `active:${eq.id}`)).toBe(true)
    expect(reloaded.tracks[0].plugins.find((plugin) => plugin.id === eq.id)?.params.lowG).toBeGreaterThan(0)
  })

  it('imports and exports a small JSON preset file', () => {
    const raw = presetDocument('delay', [{ name: 'My Slap', params: { time: 90, feedback: 0.1 } }])
    expect(raw.length).toBeLessThan(400)
    const file = readPresetDocument(raw, 'delay')
    expect(file.presets[0].name).toBe('My Slap')
    const imported = importPresetDocument([], 'delay', raw)
    expect(imported.some((item) => item.pluginId === 'delay' && item.name === 'My Slap')).toBe(true)
    expect(() => readPresetDocument('{"cueharbor":1,"pluginId":"eq","presets":[]}', 'delay')).toThrow(/different plugin/)
  })

  it('starts from Init and walks to the next factory preset', () => {
    const first = describePreset('reverb', resolveParams('reverb', {}), undefined, [], 'room')
    expect(first.name).toBe(INIT_NAME)
    expect(first.changed).toBe(false)
    const next = commitChoice([], 'room', presetByName('reverb', [], 'Small Room')!)
    expect(describePreset('reverb', next.params, undefined, next.presets, 'room').name).toBe('Small Room')
  })
})

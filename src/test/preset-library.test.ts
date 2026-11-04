import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { createKit } from '../model/padMachine'
import { starterPattern } from '../model/steps'
import { ProjectStore } from '../state/store'
import { applyBeatMachinePreset } from '../presets/beatMachine'
import { applyGroove, readKit, scalerPatch } from '../presets/apply'
import { boundsFor, resolveParams, sameParams } from '../presets/bounds'
import { DEVICE_PRESET_IDS } from '../presets/devices'
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
import { commitAmpPreset, commitPadPreset, commitPluginPreset } from '../presets/project'
import { INIT_NAME } from '../presets/types'

const PLUGIN_IDS = [...PRESET_PLUGINS, ...DEVICE_PRESET_IDS]

describe('shared plugin presets', () => {
  it('loads every factory preset inside its parameter range', () => {
    const all = allFactoryPresets()
    expect(all.length).toBe(PLUGIN_IDS.length * 8)
    const names = ['Vocal Presence', 'Kick Punch', 'Low Cut 80 Hz', 'Telephone', 'Vocal Leveling', 'Drum Bus Glue', 'Parallel Smash', 'Bass Control', 'Small Room', 'Plate Vocal', 'Large Hall', 'Slapback', '1/4 Ping-Pong', 'Dub Throw', 'Studio Clean', 'Tight Kit']
    for (const name of names) expect(all.some((item) => item.name === name)).toBe(true)
    for (const pluginId of PLUGIN_IDS) {
      const presets = factoryPresets(pluginId)
      expect(presets.length).toBe(8)
      const seen = new Set(presets.map((item) => item.name))
      expect(seen.size).toBe(presets.length)
      const init = resolveParams(pluginId, {})
      const resolvedList: Record<string, number>[] = []
      for (const preset of presets) {
        expect(preset.source).toBe('factory')
        const resolved = resolveParams(pluginId, preset.params)
        expect(sameParams(resolved, init), `${pluginId} ${preset.name} matches Init`).toBe(false)
        for (const other of resolvedList) expect(sameParams(resolved, other), `${pluginId} ${preset.name} matches another preset`).toBe(false)
        resolvedList.push(resolved)
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

  it('keeps scaler words with the saved preset', () => {
    const saved = saveUserPreset([], 'scaler', 'My Pop', { root: 5 }, { scale: 'dorian', group: 'seventh' })
    expect(saved.presets.some((item) => item.pluginId === '__text' && item.name.includes('dorian'))).toBe(true)
    expect(presetByName('scaler', saved.presets, 'My Pop')?.text?.scale).toBe('dorian')
    const loaded = commitChoice(saved.presets, 'scaler-1', presetByName('scaler', saved.presets, 'My Pop')!)
    expect(loaded.text?.scale).toBe('dorian')
    const raw = presetDocument('scaler', [{ name: 'Night', params: { root: 2 }, text: { scale: 'aeolian' } }])
    const imported = importPresetDocument([], 'scaler', raw)
    expect(presetByName('scaler', imported, 'Night')?.text?.scale).toBe('aeolian')
    const removed = deleteUserPreset(saved.presets, 'scaler', saved.preset.id)
    expect(removed?.some((item) => item.id === `text:${saved.preset.id}`)).toBe(false)
  })

  it('applies an amp rig and a beat machine kit through the shared library', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'saturator')
    const amp = store.track(track.id)!.plugins.find((plugin) => plugin.pluginId === 'saturator')!
    const rig = presetByName('amp', [], 'Studio Clean')!
    const loaded = commitChoice([], amp.id, rig)
    commitAmpPreset(store, track.id, amp.id, loaded.params, loaded.presets)
    expect(amp.params.kind).toBe(5)
    expect(amp.params.gain).toBeCloseTo(0.16)
    expect(describePreset('amp', amp.params, undefined, store.project.presets, amp.id).changed).toBe(false)
    const kitPreset = presetByName('pads', [], 'Tight Kit')!
    const kitLoad = commitChoice(store.project.presets, `pads:${track.id}`, kitPreset)
    commitPadPreset(store, track.id, kitLoad.params, kitLoad.presets)
    expect(readKit(store.track(track.id)!.padKit!).tune).toBeCloseTo(2)
    expect(readKit(store.track(track.id)!.padKit!).decay).toBeCloseTo(0.45)
  })
})

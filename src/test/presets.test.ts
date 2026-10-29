import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { CATALOG, FACTORY, activePresetName, defaultParams, presetParams } from '../audio/plugins/catalog'
import { glideValue } from '../audio/paramCurve'
import { createEmptyProject } from '../model/types'
import { DEVICE_KINDS, FACTORY_PRESETS, activeDevicePreset, defaults, makeDevice } from '../model/rack'
import { ProjectStore } from '../state/store'

function merged(base: Record<string, number>, patch: Record<string, number>) {
  return { ...base, ...patch }
}

function differs(base: Record<string, number>, patch: Record<string, number>) {
  const full = merged(base, patch)
  return Object.keys(base).some((key) => Math.abs((full[key] ?? 0) - (base[key] ?? 0)) > 0.001)
}

function same(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > 0.001) return false
  return true
}

describe('factory presets', () => {
  it('changes every plugin preset away from the defaults and keeps them distinct', () => {
    for (const plugin of CATALOG) {
      const base = defaultParams(plugin.id)
      const presets = FACTORY[plugin.id] ?? []
      if (!Object.keys(base).length) {
        expect(presets, plugin.id).toEqual([])
        continue
      }
      const seen: { name: string; params: Record<string, number> }[] = []
      for (const preset of presets) {
        const full = merged(base, preset.params)
        expect(differs(base, preset.params), `${plugin.id} ${preset.name}`).toBe(true)
        for (const other of seen) expect(same(full, other.params), `${plugin.id} ${preset.name} matches ${other.name}`).toBe(false)
        seen.push({ name: preset.name, params: full })
        if (/air/i.test(preset.name)) {
          const high = full.highG ?? full.g2 ?? full.high ?? full.highBoost ?? full.hfG
          const origin = base.highG ?? base.g2 ?? base.high ?? base.highBoost ?? base.hfG
          if (high != null && origin != null) expect(high, preset.name).toBeGreaterThan(origin)
        }
        if (/big hall|hall/i.test(preset.name)) {
          const size = full.size ?? full.decay
          if (size != null) expect(size, `${plugin.id} ${preset.name}`).toBeGreaterThan(0.65)
        }
      }
    }
  })

  it('changes every instrument preset away from the defaults and keeps bass presets low', () => {
    for (const kind of DEVICE_KINDS) {
      const base = defaults(kind)
      const seen: { name: string; params: Record<string, number> }[] = []
      for (const preset of FACTORY_PRESETS[kind]) {
        const full = merged(base, preset.params)
        expect(differs(base, preset.params), `${kind} ${preset.name}`).toBe(true)
        for (const other of seen) expect(same(full, other.params), `${kind} ${preset.name} matches ${other.name}`).toBe(false)
        seen.push({ name: preset.name, params: full })
        if ((kind === 'sub' || kind === 'fm' || kind === 'wave') && (preset.category === 'Bass' || /^bass$/i.test(preset.name))) {
          if ('cutoff' in base) expect(full.cutoff, `${kind} ${preset.name}`).toBeLessThan(800)
        }
      }
    }
  })

  it('applies a preset to the plugin, the live engine params, and one undo step', async () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const engine = new AudioEngine()
    const stop = store.subscribe(() => engine.sync(store.project, () => undefined))
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'eq')
    store.addPlugin(track.id, 'reverb')
    const eq = store.track(track.id)!.plugins.find((plugin) => plugin.pluginId === 'eq')!
    const reverb = store.track(track.id)!.plugins.find((plugin) => plugin.pluginId === 'reverb')!
    const before = { ...eq.params }
    expect(activePresetName('eq', eq.params)).toBe('')
    store.applyPluginPreset(track.id, eq.id, 'Vocal Air')
    expect(eq.params.highG).toBeGreaterThan(before.highG ?? 0)
    expect(activePresetName('eq', eq.params)).toBe('Vocal Air')
    expect(presetParams('eq', 'Vocal Air', [])!.highG).toBe(eq.params.highG)
    store.applyPluginPreset(track.id, reverb.id, 'Big Hall')
    expect(reverb.params.size).toBeGreaterThan(0.9)
    expect(reverb.params.size).toBeGreaterThan(presetParams('reverb', 'Room', [])!.size)
    expect((engine as unknown as { project: unknown }).project).toBe(store.project)
    store.undo()
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === reverb.id)!.params.size).not.toBeCloseTo(0.96)
    store.undo()
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === eq.id)!.params.highG).toBeCloseTo(before.highG ?? 0)

    const device = makeDevice('sub')
    store.project.tracks.find((item) => item.type === 'midi')!.rack!.devices[0] = device
    const host = store.project.tracks.find((item) => item.rack?.devices.some((itemDevice) => itemDevice.id === device.id))!
    store.applyDevicePreset(host.id, device.id, 'Bass')
    expect(device.params.cutoff).toBeLessThan(800)
    expect(activeDevicePreset('sub', device.params)).toBe('Bass')
    expect(glideValue(0, 1, 480, 48000)).toBeGreaterThan(0)
    expect(glideValue(0, 1, 480, 48000)).toBeLessThan(1)
    stop()
  })
})

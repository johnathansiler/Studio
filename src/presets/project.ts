import { normalizeScaler } from '../instruments/scaler/model'
import type { ScalerState } from '../instruments/scaler/types'
import type { ProjectStore } from '../state/store'
import { selectPlugin } from '../state/select'
import type { UserPreset } from '../model/types'
import { applyGroove } from './apply'

type Editable = { mutate: (fn: () => void, label?: string) => void }

function edit(store: ProjectStore, fn: () => void) {
  ;(store as unknown as Editable).mutate(fn, 'Preset')
}

export function commitPluginPreset(
  store: ProjectStore,
  trackId: string | 'master',
  instanceId: string,
  params: Record<string, number>,
  presets: UserPreset[],
  steps = false,
) {
  edit(store, () => {
    const plugin = selectPlugin(store, trackId, instanceId)
    if (!plugin) return
    plugin.params = { ...params }
    if (steps && plugin.steps) {
      const active = plugin.steps.patterns.find((item) => item.id === plugin.steps?.activeId) ?? plugin.steps.patterns[0]
      if (active) {
        const next = applyGroove(active, params)
        plugin.steps = {
          ...plugin.steps,
          patterns: plugin.steps.patterns.map((item) => item.id === next.id ? next : item),
        }
        if (store.project.beats?.activeId === plugin.steps.activeId) store.project.beats = plugin.steps
      }
    }
    store.project.presets = presets
  })
}

export function commitScalerPreset(store: ProjectStore, trackId: string, patch: Partial<ScalerState>, presets: UserPreset[]) {
  edit(store, () => {
    const track = store.track(trackId)
    if (!track) return
    track.scaler = normalizeScaler({ ...normalizeScaler(track.scaler), ...patch })
    store.project.presets = presets
  })
}

export function commitDevicePreset(store: ProjectStore, trackId: string, deviceId: string, params: Record<string, number>, presets: UserPreset[]) {
  edit(store, () => {
    const device = store.track(trackId)?.rack?.devices.find((item) => item.id === deviceId)
    if (device) device.params = { ...params }
    store.project.presets = presets
  })
}

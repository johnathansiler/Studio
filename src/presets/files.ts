import type { UserPreset } from '../model/types'
import { saveUserPreset } from './library'
import { PRESET_FILE_VERSION, type PresetFile } from './types'

export function presetDocument(pluginId: string, presets: Array<{ name: string; params: Record<string, number>; text?: Record<string, string> }>): string {
  const file: PresetFile = {
    cueharbor: PRESET_FILE_VERSION,
    pluginId,
    presets: presets.map((item) => ({ name: item.name, params: { ...item.params }, text: item.text ? { ...item.text } : undefined })),
  }
  return JSON.stringify(file)
}

export function readPresetDocument(raw: string, pluginId: string): PresetFile {
  const parsed = JSON.parse(raw) as Partial<PresetFile>
  if (!parsed || parsed.cueharbor !== PRESET_FILE_VERSION || !Array.isArray(parsed.presets)) {
    throw new Error('This file is not a CueHarbor preset.')
  }
  const target = parsed.pluginId || pluginId
  if (target !== pluginId) throw new Error('That preset file is for a different plugin.')
  return {
    cueharbor: PRESET_FILE_VERSION,
    pluginId,
    presets: parsed.presets.map((item) => ({
      name: String(item?.name || '').trim(),
      params: item?.params && typeof item.params === 'object' ? { ...item.params } : {},
      text: item?.text && typeof item.text === 'object' ? { ...item.text } : undefined,
    })).filter((item) => item.name),
  }
}

/** Imported presets become user presets. Factory names are kept by adding a suffix. */
export function importPresetDocument(stored: UserPreset[], pluginId: string, raw: string): UserPreset[] {
  const file = readPresetDocument(raw, pluginId)
  let next = stored
  for (const item of file.presets) {
    const saved = saveUserPreset(next, pluginId, item.name, item.params, item.text)
    if (!saved.preset.id) {
      const retry = saveUserPreset(next, pluginId, `${item.name} user`, item.params, item.text)
      if (retry.preset.id) next = retry.presets
      continue
    }
    next = saved.presets
  }
  return next
}

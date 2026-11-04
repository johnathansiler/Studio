import type { UserPreset } from '../model/types'

/** Where a preset came from. Factory and Init cannot be renamed or deleted. */
export type PresetSource = 'init' | 'factory' | 'user'

export interface PresetText {
  [key: string]: string
}

export interface CuePreset {
  id: string
  pluginId: string
  name: string
  source: PresetSource
  params: Record<string, number>
  text?: PresetText
}

export interface StampBody {
  key: string
  name: string
  source: PresetSource
  text?: PresetText
}

export const PRESET_FILE_VERSION = 1

export interface PresetFile {
  cueharbor: typeof PRESET_FILE_VERSION
  pluginId: string
  presets: Array<{ name: string; params: Record<string, number>; text?: PresetText }>
}

export const INIT_NAME = 'Init'

export function isLibraryPreset(preset: UserPreset): boolean {
  return !preset.pluginId.startsWith('__')
}

export function stampId(key: string): string {
  return `active:${key}`
}

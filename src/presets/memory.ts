import type { UserPreset } from '../model/types'

/** In-memory stand-in for the preset library. Tests use this instead of IndexedDB. */
export function memoryPresetBook() {
  let rows: UserPreset[] = []
  return {
    async list(): Promise<UserPreset[]> {
      return rows.map((item) => ({ ...item, params: { ...item.params } }))
    },
    async write(preset: UserPreset): Promise<void> {
      rows = rows.filter((item) => item.id !== preset.id)
      rows.push({ ...preset, params: { ...preset.params } })
    },
    async remove(id: string): Promise<void> {
      rows = rows.filter((item) => item.id !== id)
    },
  }
}

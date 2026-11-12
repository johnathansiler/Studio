import type { UserPreset } from '../model/types'
import { baseParams, resolveParams, sameParams, sameText } from './bounds'
import { factoryPresets, initPreset } from './factory'
import { INIT_NAME, isLibraryPreset, stampId, type CuePreset, type PresetSource, type PresetText, type StampBody } from './types'

export interface PresetView {
  name: string
  source: PresetSource
  changed: boolean
  readOnly: boolean
}

const ACTIVE_PLUGIN = '__active'
const TEXT_PLUGIN = '__text'

function textRowId(id: string): string {
  return `text:${id}`
}

function readText(stored: readonly UserPreset[], id: string): PresetText | undefined {
  const row = stored.find((item) => item.id === textRowId(id) && item.pluginId === TEXT_PLUGIN)
  if (!row?.name) return undefined
  try {
    const parsed = JSON.parse(row.name) as Record<string, unknown>
    const text: PresetText = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') text[key] = value
    }
    return Object.keys(text).length ? text : undefined
  } catch {
    return undefined
  }
}

function withText(stored: UserPreset[], id: string, text?: PresetText): UserPreset[] {
  const next = stored.filter((item) => item.id !== textRowId(id))
  if (!id || !text || !Object.keys(text).length) return next
  next.push({ id: textRowId(id), pluginId: TEXT_PLUGIN, name: JSON.stringify(text), params: {} })
  return next
}

/** User presets for one plugin, plus the text rows that belong to them. */
export function rowsForPlugin(stored: readonly UserPreset[], pluginId: string): UserPreset[] {
  const mine = stored.filter((item) => isLibraryPreset(item) && item.pluginId === pluginId)
  const ids = new Set(mine.map((item) => item.id))
  const text = stored.filter((item) => item.pluginId === TEXT_PLUGIN && ids.has(item.id.slice(5)))
  return [...mine, ...text]
}

export function userPresets(pluginId: string, stored: readonly UserPreset[]): CuePreset[] {
  return stored.filter((item) => isLibraryPreset(item) && item.pluginId === pluginId).map((item) => ({
    id: item.id,
    pluginId: item.pluginId,
    name: item.name,
    source: 'user' as const,
    params: { ...item.params },
    text: readText(stored, item.id),
  }))
}

export function presetChoices(pluginId: string, stored: readonly UserPreset[]): CuePreset[] {
  const seen = new Set<string>()
  const list = [initPreset(pluginId), ...factoryPresets(pluginId), ...userPresets(pluginId, stored)]
  return list.filter((item) => {
    const key = item.name.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function readStamp(stored: readonly UserPreset[], key: string): StampBody | null {
  const row = stored.find((item) => item.id === stampId(key) && item.pluginId === ACTIVE_PLUGIN)
  if (!row) return null
  try {
    const body = JSON.parse(row.name) as StampBody
    if (!body || typeof body.name !== 'string' || !body.source) return null
    return { key, name: body.name, source: body.source, text: body.text }
  } catch {
    return null
  }
}

export function stampParams(stored: readonly UserPreset[], key: string): Record<string, number> | null {
  const row = stored.find((item) => item.id === stampId(key) && item.pluginId === ACTIVE_PLUGIN)
  return row ? { ...row.params } : null
}

export function writeStamp(stored: readonly UserPreset[], key: string, body: StampBody, params: Record<string, number>): UserPreset[] {
  const next = stored.filter((item) => item.id !== stampId(key))
  next.push({
    id: stampId(key),
    pluginId: ACTIVE_PLUGIN,
    name: JSON.stringify({ key, name: body.name, source: body.source, text: body.text }),
    params: { ...params },
  })
  return next
}

export function describePreset(pluginId: string, values: Record<string, number>, text: PresetText | undefined, stored: readonly UserPreset[], key: string): PresetView {
  const stamp = readStamp(stored, key)
  const baseline = stampParams(stored, key)
  if (stamp && baseline) {
    const changed = !sameParams(resolveParams(pluginId, values), resolveParams(pluginId, baseline)) || !sameText(text, stamp.text)
    return { name: stamp.name, source: stamp.source, changed, readOnly: stamp.source !== 'user' }
  }
  const match = presetChoices(pluginId, stored).find((item) => {
    const resolved = resolveParams(pluginId, item.params)
    return sameParams(resolveParams(pluginId, values), resolved) && sameText(text, item.text)
  })
  if (match) return { name: match.name, source: match.source, changed: false, readOnly: match.source !== 'user' }
  const init = resolveParams(pluginId, {})
  return { name: INIT_NAME, source: 'init', changed: !sameParams(resolveParams(pluginId, values), init) || !sameText(text, undefined), readOnly: true }
}

export function cyclePreset(pluginId: string, stored: readonly UserPreset[], name: string, direction: -1 | 1): CuePreset {
  const list = presetChoices(pluginId, stored)
  const index = list.findIndex((item) => item.name === name)
  const next = index < 0 ? (direction > 0 ? 0 : list.length - 1) : (index + direction + list.length) % list.length
  return list[next]
}

function freshId(name: string): string {
  return `user:${name}:${Math.random().toString(36).slice(2, 8)}`
}

export function uniqueName(pluginId: string, stored: readonly UserPreset[], wanted: string): string {
  const taken = new Set(presetChoices(pluginId, stored).map((item) => item.name.toLowerCase()))
  const base = wanted.trim() || 'Preset'
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base} ${index}`.toLowerCase())) index += 1
  return `${base} ${index}`
}

export function saveUserPreset(stored: UserPreset[], pluginId: string, name: string, params: Record<string, number>, text?: PresetText): { presets: UserPreset[]; preset: CuePreset } {
  const clean = name.trim()
  const factory = factoryPresets(pluginId).some((item) => item.name.toLowerCase() === clean.toLowerCase())
  const init = clean.toLowerCase() === INIT_NAME.toLowerCase()
  if (!clean || factory || init) {
    const preset = { id: '', pluginId, name: clean, source: 'user' as const, params }
    return { presets: stored, preset }
  }
  const existing = stored.find((item) => isLibraryPreset(item) && item.pluginId === pluginId && item.name.toLowerCase() === clean.toLowerCase())
  if (existing) {
    const presets = withText(
      stored.map((item) => item.id === existing.id ? { ...item, params: { ...params } } : item),
      existing.id,
      text,
    )
    return { presets, preset: { id: existing.id, pluginId, name: existing.name, source: 'user', params: { ...params }, text } }
  }
  const preset: CuePreset = { id: freshId(clean), pluginId, name: clean, source: 'user', params: { ...params }, text }
  return {
    presets: withText([...stored, { id: preset.id, pluginId, name: clean, params: { ...params } }], preset.id, text),
    preset,
  }
}

export function renameUserPreset(stored: UserPreset[], pluginId: string, id: string, name: string): UserPreset[] | null {
  const target = stored.find((item) => item.id === id && item.pluginId === pluginId && isLibraryPreset(item))
  if (!target) return null
  const clean = uniqueName(pluginId, stored.filter((item) => item.id !== id), name)
  if (clean.toLowerCase() === INIT_NAME.toLowerCase()) return null
  if (factoryPresets(pluginId).some((item) => item.name.toLowerCase() === clean.toLowerCase())) return null
  return stored.map((item) => item.id === id ? { ...item, name: clean } : item)
}

export function deleteUserPreset(stored: UserPreset[], pluginId: string, id: string): UserPreset[] | null {
  const target = stored.find((item) => item.id === id && item.pluginId === pluginId && isLibraryPreset(item))
  if (!target) return null
  return stored.filter((item) => item.id !== id && item.id !== textRowId(id))
}

export function duplicatePreset(stored: UserPreset[], pluginId: string, source: CuePreset): { presets: UserPreset[]; preset: CuePreset } {
  const name = uniqueName(pluginId, stored, `${source.name} copy`)
  return saveUserPreset(stored, pluginId, name, resolveParams(pluginId, source.params), source.text)
}

export function commitChoice(stored: UserPreset[], key: string, preset: CuePreset): { presets: UserPreset[]; params: Record<string, number>; text?: PresetText } {
  const params = resolveParams(preset.pluginId, preset.params)
  const body: StampBody = { key, name: preset.name, source: preset.source, text: preset.text }
  return { presets: writeStamp(stored, key, body, params), params, text: preset.text }
}

export function presetByName(pluginId: string, stored: readonly UserPreset[], name: string): CuePreset | null {
  return presetChoices(pluginId, stored).find((item) => item.name === name) ?? null
}

export function exportablePresets(pluginId: string, stored: readonly UserPreset[]): CuePreset[] {
  return userPresets(pluginId, stored)
}

export { baseParams }

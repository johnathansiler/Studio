/**
 * Reset values for knobs, sliders, and faders.
 * A double tap asks here once. Call sites that already pass a declared
 * default win, except mixer faders (0 dB) and pan (center).
 */

import { pluginSpecs } from '../audio/plugins/catalog'
import { DEVICE_PARAMS } from '../model/rack'

/** Linear gain. gainToDb(1) is 0.0 dB. */
export const FADER_0_DB = 1

/** Pan center. */
export const PAN_CENTER = 0

/** Gain stored when a channel send is created. */
export const SEND_LEVEL = 0.25

export interface DefaultQuery {
  label?: string
  title?: string
  className?: string
  param?: string
  target?: string
  min: number
  max: number
  /** Default passed by the control. Ignored for mixer faders and pan. */
  fallback?: number | null
  /** data-fallback on a native slider. This is an explicit declaration. */
  declared?: number | null
}

interface NamedDefault {
  label: string
  value: number
  min?: number
  max?: number
}

/** Controls that never grew a default on the widget itself. */
const NAMED: NamedDefault[] = [
  { label: 'pad tune', value: 0 },
  { label: 'filter', value: 1, min: 0, max: 1 },
  { label: 'vintage', value: 0, min: 0, max: 1 },
  { label: 'pad volume', value: 0.8, min: 0, max: 1 },
  { label: 'pad decay', value: 1, min: 0.05, max: 1 },
  { label: 'pad cents', value: 0, min: -100, max: 100 },
  { label: 'pad swing', value: 50, min: 50, max: 75 },
  { label: 'pad high pass', value: 0, min: 0, max: 1 },
  { label: 'velocity sensitivity', value: 1, min: 0, max: 1 },
  { label: 'quantize strength', value: 100, min: 0, max: 100 },
  { label: 'record threshold', value: 0.08, min: 0.01, max: 0.5 },
  { label: 'humanize timing', value: 0, min: 0, max: 0.25 },
  { label: 'humanize velocity', value: 0, min: 0, max: 1 },
  { label: 'velocity scale', value: 1, min: 0, max: 1 },
  { label: 'velocity minimum', value: 0, min: 0, max: 1 },
  { label: 'velocity maximum', value: 1, min: 0, max: 1 },
  { label: 'fixed velocity', value: 0.85, min: 0.01, max: 1 },
  { label: 'swing', value: 50, min: 50, max: 75 },
  { label: 'send', value: 0, min: 0, max: 1 },
  { label: 'attack', value: 0, min: 0, max: 1 },
  { label: 'tape wow and flutter', value: 0, min: 0, max: 1 },
  { label: 'vinyl noise and crackle', value: 0, min: 0, max: 1 },
  { label: 'low-pass cutoff', value: 0, min: 0, max: 1 },
  { label: 'bit depth', value: 0, min: 0, max: 1 },
  { label: 'sample-rate reduction', value: 0, min: 0, max: 1 },
  { label: 'position', value: 0.35, min: 0, max: 1 },
  { label: 'size', value: 90, min: 10, max: 400 },
  { label: 'density', value: 18, min: 1, max: 40 },
  { label: 'spray', value: 0.12, min: 0, max: 1 },
  { label: 'pitch', value: 0, min: -24, max: 24 },
  { label: 'macro 1', value: 0, min: 0, max: 1 },
  { label: 'macro 2', value: 0, min: 0, max: 1 },
  { label: 'depth', value: 0, min: -1, max: 1 },
  { label: 'lfo 1', value: 0.35, min: 0.05, max: 12 },
  { label: 'lfo 2', value: 2.2, min: 0.05, max: 12 },
  { label: 'attack', value: 12, min: 1, max: 2000 },
  { label: 'release', value: 320, min: 5, max: 4000 },
  { label: 'wheel', value: 0, min: 0, max: 1 },
  { label: 'pressure', value: 0, min: 0, max: 1 },
  { label: 'level', value: 0.8, min: 0, max: 1 },
  { label: 'cutoff', value: 3200, min: 40, max: 16000 },
  { label: 'resonance', value: 0.08, min: 0, max: 0.9 },
  { label: 'low key', value: 0, min: 0, max: 127 },
  { label: 'high key', value: 127, min: 0, max: 127 },
  { label: 'soft', value: 0, min: 0, max: 1 },
  { label: 'hard', value: 1, min: 0, max: 1 },
  { label: 'root', value: 60, min: 0, max: 127 },
  { label: 'scaler follow', value: 1, min: 0, max: 1 },
  { label: 'scaler root', value: 0, min: 0, max: 11 },
  { label: 'scaler scale', value: 0, min: 0, max: 1 },
]

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function norm(text: string): string {
  return tokens(text).join(' ')
}

function clamp(value: number, min: number, max: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return null
  return Math.max(min, Math.min(max, value))
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.02)
}

/** Mixer gain fader. Unity is 0 dB, including when a call site still says 0.8 or 0.9. */
export function isMixerFader(q: DefaultQuery): boolean {
  const label = tokens(q.label || '')
  const klass = tokens(q.className || '')
  const param = (q.param || '').toLowerCase()
  const target = (q.target || '').toLowerCase()
  if (label.includes('pad') && label.includes('volume')) return false
  if (!(q.min >= 0 && q.max >= FADER_0_DB && q.max <= 2)) return false
  if (target === 'volume' || param === 'volume' || param === 'mastervolume') return true
  if (klass.includes('volume')) return true
  if (label.includes('volume') || label.includes('vol')) return true
  return false
}

function isPan(q: DefaultQuery): boolean {
  if (!(q.min < 0 && q.max > 0)) return false
  const words = tokens(`${q.label || ''} ${q.className || ''} ${q.param || ''} ${q.target || ''}`)
  return words.includes('pan')
}

function isSendLevel(q: DefaultQuery): boolean {
  const label = (q.label || '').toLowerCase()
  if (q.min < -1e-6 || q.max + 1e-6 < SEND_LEVEL || q.max > 1.01) return false
  if (label.includes('send level')) return true
  return /\bsend\s+[a-h]\b/.test(label)
}

function namedDefault(q: DefaultQuery): number | null {
  const label = norm(q.label || '')
  if (!label) return null
  const hits = NAMED.filter((item) => item.label === label || label.startsWith(`${item.label} `))
  hits.sort((a, b) => b.label.length - a.label.length)
  for (const item of hits) {
    if (item.value < q.min - 1e-6 || item.value > q.max + 1e-6) continue
    if (item.min == null || item.max == null) return item.value
    if (near(q.min, item.min) && near(q.max, item.max)) return item.value
  }
  return null
}

interface CatalogDefault {
  plugin: string
  id: string
  name: string
  min: number
  max: number
  value: number
}

let catalogIndex: CatalogDefault[] | null = null

function catalogRows() {
  if (catalogIndex) return catalogIndex
  const rows: CatalogDefault[] = []
  for (const plugin of pluginSpecs()) {
    for (const param of plugin.params) {
      rows.push({
        plugin: norm(plugin.name),
        id: norm(param.id),
        name: norm(param.name),
        min: param.min,
        max: param.max,
        value: param.default,
      })
    }
  }
  for (const params of Object.values(DEVICE_PARAMS)) {
    for (const param of params) {
      rows.push({
        plugin: '',
        id: norm(param.id),
        name: norm(param.name),
        min: param.min,
        max: param.max,
        value: param.default,
      })
    }
  }
  catalogIndex = rows
  return rows
}

function rangeMatches(row: { min: number; max: number }, q: DefaultQuery): boolean {
  const span = Math.max(1, Math.abs(row.max - row.min))
  return Math.abs(row.min - q.min) <= Math.max(0.02, span * 0.002) && Math.abs(row.max - q.max) <= Math.max(0.02, span * 0.002)
}

function hasPhrase(hay: string, phrase: string): boolean {
  if (!phrase) return false
  return ` ${hay} `.includes(` ${phrase} `)
}

function catalogDefault(q: DefaultQuery): number | null {
  const text = norm(`${q.label || ''} ${q.title || ''}`)
  if (!text) return null
  const hits: number[] = []
  for (const row of catalogRows()) {
    if (!rangeMatches(row, q)) continue
    const exact = text === row.id || text === row.name
    const qualified = row.plugin !== '' && hasPhrase(text, row.plugin) && (hasPhrase(text, row.name) || hasPhrase(text, row.id))
    if (exact || qualified) hits.push(row.value)
  }
  if (!hits.length) return null
  const first = hits[0]
  return hits.every((value) => Math.abs(value - first) < 1e-6) ? first : null
}

/** Value a double tap should write. Null means this control has no default yet. */
export function controlDefault(q: DefaultQuery): number | null {
  if (q.declared != null && Number.isFinite(q.declared)) return clamp(q.declared, q.min, q.max)
  if (isMixerFader(q)) return clamp(FADER_0_DB, q.min, q.max)
  if (isPan(q)) return clamp(PAN_CENTER, q.min, q.max)
  if (q.fallback != null && Number.isFinite(q.fallback)) return clamp(q.fallback, q.min, q.max)
  if (isSendLevel(q)) return clamp(SEND_LEVEL, q.min, q.max)
  const named = namedDefault(q)
  if (named != null) return clamp(named, q.min, q.max)
  const fromCatalog = catalogDefault(q)
  if (fromCatalog != null) return clamp(fromCatalog, q.min, q.max)
  return null
}

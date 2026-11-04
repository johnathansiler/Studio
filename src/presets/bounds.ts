import { defaultParams, descriptor } from '../audio/plugins/catalog'
import { DEVICE_KINDS, DEVICE_PARAMS, defaults, type DeviceKind } from '../model/rack'

export interface ParamBound {
  id: string
  min: number
  max: number
  fallback: number
}

const STEP_BOUNDS: ParamBound[] = [{ id: 'swing', min: 0, max: 0.66, fallback: 0 }]
for (let step = 0; step < 16; step += 1) {
  for (const prefix of ['k', 's', 'h']) STEP_BOUNDS.push({ id: `${prefix}${step}`, min: 0, max: 1, fallback: 0 })
}

const SCALER_BOUNDS: ParamBound[] = [
  { id: 'root', min: 0, max: 11, fallback: 0 },
  { id: 'inversion', min: 0, max: 3, fallback: 0 },
  { id: 'gate', min: 0.25, max: 1, fallback: 0.8 },
  { id: 'rate', min: 0.125, max: 1, fallback: 0.5 },
  { id: 'swing', min: 0, max: 0.33, fallback: 0 },
  { id: 'octaves', min: 1, max: 3, fallback: 1 },
  { id: 'snap', min: 0, max: 1, fallback: 0 },
  { id: 'voiceLead', min: 0, max: 1, fallback: 1 },
]

const PAD_BOUNDS: ParamBound[] = [
  { id: 'tune', min: -24, max: 24, fallback: 0 },
  { id: 'decay', min: 0.05, max: 1, fallback: 1 },
  { id: 'attack', min: 0, max: 1, fallback: 0 },
  { id: 'swing', min: 50, max: 75, fallback: 50 },
  { id: 'humanize', min: 0, max: 0.25, fallback: 0 },
  { id: 'level', min: 0, max: 1, fallback: 0.8 },
]

function deviceKind(pluginId: string): DeviceKind | null {
  if (pluginId === 'synth') return 'sub'
  if (!pluginId.startsWith('device:')) return null
  const kind = pluginId.slice('device:'.length)
  return (DEVICE_KINDS as string[]).includes(kind) ? kind as DeviceKind : null
}

export function boundsFor(pluginId: string): ParamBound[] {
  const kind = deviceKind(pluginId)
  if (kind) return DEVICE_PARAMS[kind].map((item) => ({ id: item.id, min: item.min, max: item.max, fallback: item.default }))
  if (pluginId === 'master') return (descriptor('limiter')?.params ?? []).map((item) => ({ id: item.id, min: item.min, max: item.max, fallback: item.default }))
  if (pluginId === 'steps') return STEP_BOUNDS
  if (pluginId === 'scaler') return SCALER_BOUNDS
  if (pluginId === 'pads') return PAD_BOUNDS
  return (descriptor(pluginId)?.params ?? []).map((item) => ({ id: item.id, min: item.min, max: item.max, fallback: item.default }))
}

export function baseParams(pluginId: string): Record<string, number> {
  const kind = deviceKind(pluginId)
  if (kind) return defaults(kind)
  if (pluginId === 'master') return defaultParams('limiter')
  const bounds = boundsFor(pluginId)
  if (pluginId === 'steps' || pluginId === 'scaler' || pluginId === 'pads') {
    const params: Record<string, number> = {}
    for (const bound of bounds) params[bound.id] = bound.fallback
    return params
  }
  return defaultParams(pluginId)
}

/** Merge a partial preset onto the init patch and keep every value inside its range. */
export function resolveParams(pluginId: string, partial: Record<string, number>): Record<string, number> {
  const base = baseParams(pluginId)
  const next: Record<string, number> = {}
  for (const bound of boundsFor(pluginId)) {
    const raw = partial[bound.id]
    const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : (base[bound.id] ?? bound.fallback)
    next[bound.id] = Math.min(bound.max, Math.max(bound.min, value))
  }
  return next
}

export function sameParams(a: Record<string, number>, b: Record<string, number>, tolerance = 0.001): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (Math.abs((a[key] ?? 0) - (b[key] ?? 0)) > tolerance) return false
  }
  return true
}

export function sameText(a: Record<string, string> | undefined, b: Record<string, string> | undefined): boolean {
  const left = a ?? {}
  const right = b ?? {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) if ((left[key] ?? '') !== (right[key] ?? '')) return false
  return true
}

import {
  GLOBAL_PARAMS,
  LAYER_PARAMS,
  sourceParamList,
  type LayerPatch,
  type ModRoute,
} from './types'

export interface ParamRange {
  min: number
  max: number
}

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

export function clampRange(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/** Bilinear weights for corners A (0,0), B (1,0), C (0,1), D (1,1). */
export function morphWeights(x: number, y: number): [number, number, number, number] {
  const px = clamp01(x)
  const py = clamp01(y)
  return [(1 - px) * (1 - py), px * (1 - py), (1 - px) * py, px * py]
}

function cornerValue(bag: Record<string, number> | undefined, key: string, fallback: Record<string, number>) {
  const value = bag?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const base = fallback[key]
  return typeof base === 'number' && Number.isFinite(base) ? base : 0
}

/** Blend four parameter snapshots. Missing keys use `fallback`. */
export function morphValues(
  corners: readonly Record<string, number>[],
  x: number,
  y: number,
  fallback: Record<string, number>,
): Record<string, number> {
  const weights = morphWeights(x, y)
  const keys = new Set<string>(Object.keys(fallback))
  for (const corner of corners) if (corner) for (const key of Object.keys(corner)) keys.add(key)
  const out: Record<string, number> = {}
  for (const key of keys) {
    let sum = 0
    for (let i = 0; i < 4; i++) sum += weights[i] * cornerValue(corners[i], key, fallback)
    out[key] = sum
  }
  return out
}

/**
 * Move one sounding value. The corner under the pad absorbs the edit when it
 * owns at least half the blend. In the middle, every corner shifts together.
 */
export function writeSounding(
  corners: Record<string, number>[],
  x: number,
  y: number,
  fallback: Record<string, number>,
  key: string,
  target: number,
) {
  const weights = morphWeights(x, y)
  let dominant = 0
  for (let i = 1; i < 4; i++) if (weights[i] > weights[dominant]) dominant = i
  const current = morphValues(corners, x, y, fallback)[key] ?? 0
  if (weights[dominant] >= 0.5) {
    let rest = 0
    for (let i = 0; i < 4; i++) {
      if (i === dominant) continue
      rest += weights[i] * cornerValue(corners[i], key, fallback)
    }
    const bag = corners[dominant] ?? (corners[dominant] = {})
    bag[key] = weights[dominant] > 1e-6 ? (target - rest) / weights[dominant] : target
    return
  }
  const delta = target - current
  for (let i = 0; i < 4; i++) {
    const bag = corners[i] ?? (corners[i] = {})
    bag[key] = cornerValue(bag, key, fallback) + delta
  }
}

export function flattenPatch(patch: LayerPatch): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of GLOBAL_PARAMS) {
    const value = patch.globals?.[item.id]
    out[`g:${item.id}`] = typeof value === 'number' && Number.isFinite(value) ? value : item.default
  }
  for (const layer of patch.layers ?? []) {
    for (const item of LAYER_PARAMS) {
      const value = layer.params?.[item.id]
      out[`${layer.id}:${item.id}`] = typeof value === 'number' && Number.isFinite(value) ? value : item.default
    }
    for (const item of sourceParamList(layer.source)) {
      const value = layer.source?.params?.[item.id]
      out[`${layer.id}:s:${item.id}`] = typeof value === 'number' && Number.isFinite(value) ? value : item.default
    }
  }
  return out
}

export function soundingFlat(patch: LayerPatch): Record<string, number> {
  const corners = (patch.corners ?? []).map((corner) => corner?.values ?? {})
  return morphValues(corners, patch.xy?.x ?? 0, patch.xy?.y ?? 0, flattenPatch(patch))
}

export function rangeMap(patch: LayerPatch): Record<string, ParamRange> {
  const map: Record<string, ParamRange> = {}
  for (const item of GLOBAL_PARAMS) map[`g:${item.id}`] = item
  for (const layer of patch.layers ?? []) {
    for (const item of LAYER_PARAMS) map[`${layer.id}:${item.id}`] = item
    for (const item of sourceParamList(layer.source)) map[`${layer.id}:s:${item.id}`] = item
  }
  return map
}

function readSource(sources: Record<string, number>, id: string) {
  const value = sources[id]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Add each route onto its destination. Sources are whatever the caller measured. */
export function applyRoutes(
  base: Record<string, number>,
  routes: readonly ModRoute[],
  sources: Record<string, number>,
  ranges: Record<string, ParamRange>,
): Record<string, number> {
  const out: Record<string, number> = {}
  applyRoutesInto(base, routes, () => sources, ranges, out)
  return out
}

export function applyRoutesInto(
  base: Record<string, number>,
  routes: readonly ModRoute[],
  sourcesFor: (destination: string) => Record<string, number>,
  ranges: Record<string, ParamRange>,
  out: Record<string, number>,
) {
  for (const key of Object.keys(out)) delete out[key]
  for (const key of Object.keys(base)) out[key] = base[key]
  for (const route of routes) {
    const range = ranges[route.destination]
    if (!range || !Number.isFinite(route.amount)) continue
    const src = readSource(sourcesFor(route.destination), route.source)
    const span = range.max - range.min
    const current = out[route.destination]
    const start = typeof current === 'number' && Number.isFinite(current) ? current : range.min
    out[route.destination] = clampRange(start + route.amount * src * span, range.min, range.max)
  }
  return out
}

export function parseFlatKey(key: string): { scope: 'global' | 'layer' | 'source'; layerId: string; param: string } | null {
  if (key.startsWith('g:')) return { scope: 'global', layerId: '', param: key.slice(2) }
  const parts = key.split(':')
  if (parts.length === 3 && parts[1] === 's') return { scope: 'source', layerId: parts[0], param: parts[2] }
  if (parts.length === 2) return { scope: 'layer', layerId: parts[0], param: parts[1] }
  return null
}

export function assignFlat(patch: LayerPatch, key: string, value: number) {
  const parsed = parseFlatKey(key)
  if (!parsed || !Number.isFinite(value)) return
  if (parsed.scope === 'global') {
    patch.globals[parsed.param] = value
    return
  }
  const layer = patch.layers.find((item) => item.id === parsed.layerId)
  if (!layer) return
  if (parsed.scope === 'source') layer.source.params[parsed.param] = value
  else layer.params[parsed.param] = value
}

import { uid } from '../../model/types'
import { clamp } from './dsp'
import {
  BIPOLAR_SOURCES,
  FIELD_RANGE,
  MAX_LAYERS,
  MAX_ROUTES,
  MORPH_PARAM_KEYS,
  PARAM_RANGE,
  type FieldRange,
  type GranularSettings,
  type LayerKind,
  type LayerNumbers,
  type ModRoute,
  type ModSourceId,
  type MorphCorner,
  type OmniPatch,
  type PatchLayer,
  type PatchNumbers,
} from './types'

const CORNER_NAMES = ['A', 'B', 'C', 'D'] as const
const SOURCES: ModSourceId[] = ['lfo1', 'lfo2', 'env1', 'env2', 'velocity', 'aftertouch', 'modwheel', 'macro1', 'macro2', 'x', 'y']
const KINDS: LayerKind[] = ['analog', 'wavetable', 'fm', 'sampler', 'granular']

export function emptyGranular(): GranularSettings {
  return { position: 0.35, size: 90, density: 18, spray: 0.12, pitch: 0, freeze: true }
}

export function emptyLayer(kind: LayerKind = 'analog', nameSeed = ''): PatchLayer {
  return {
    id: uid(nameSeed || 'lyr'),
    kind,
    enabled: true,
    keyLo: 0,
    keyHi: 127,
    velLo: 0,
    velHi: 1,
    level: 0.8,
    pan: 0,
    cutoff: 3200,
    resonance: 0.08,
    filterMode: 0,
    fxSend: 0,
    bufferId: '',
    root: 60,
    granular: emptyGranular(),
    params: {},
  }
}

function corner(index: number, values: PatchNumbers): MorphCorner {
  return { id: uid('corner'), name: CORNER_NAMES[index] || 'A', captured: false, values: cloneNumbers(values) }
}

export function emptyOmni(name = 'Patch'): OmniPatch {
  const layer = emptyLayer('analog')
  const patch: OmniPatch = {
    id: uid('omni'),
    name,
    enabled: true,
    layers: [layer],
    routes: [],
    lfo1Rate: 0.35,
    lfo2Rate: 2.2,
    env1Attack: 12,
    env1Decay: 240,
    env1Sustain: 0.7,
    env1Release: 320,
    env2Attack: 40,
    env2Decay: 480,
    env2Sustain: 0.35,
    env2Release: 640,
    modWheel: 0,
    aftertouch: 0,
    macro1: 0,
    macro2: 0,
    morph: { x: 0, y: 0, corners: [] as unknown as OmniPatch['morph']['corners'] },
  }
  const numbers = captureNumbers(patch)
  patch.morph.corners = [0, 1, 2, 3].map((index) => corner(index, numbers)) as OmniPatch['morph']['corners']
  return patch
}

export function captureNumbers(patch: OmniPatch): PatchNumbers {
  return {
    layers: patch.layers.map((layer) => ({
      enabled: layer.enabled ? 1 : 0,
      keyLo: layer.keyLo,
      keyHi: layer.keyHi,
      velLo: layer.velLo,
      velHi: layer.velHi,
      level: layer.level,
      pan: layer.pan,
      cutoff: layer.cutoff,
      resonance: layer.resonance,
      filterMode: layer.filterMode,
      fxSend: layer.fxSend,
      root: layer.root,
      position: layer.granular.position,
      size: layer.granular.size,
      density: layer.granular.density,
      spray: layer.granular.spray,
      pitch: layer.granular.pitch,
      freeze: layer.granular.freeze ? 1 : 0,
      params: { ...layer.params },
    })),
    routes: patch.routes.map((route) => route.depth),
    lfo1Rate: patch.lfo1Rate,
    lfo2Rate: patch.lfo2Rate,
    env1Attack: patch.env1Attack,
    env1Decay: patch.env1Decay,
    env1Sustain: patch.env1Sustain,
    env1Release: patch.env1Release,
    env2Attack: patch.env2Attack,
    env2Decay: patch.env2Decay,
    env2Sustain: patch.env2Sustain,
    env2Release: patch.env2Release,
  }
}

export function cloneNumbers(values: PatchNumbers): PatchNumbers {
  return {
    ...values,
    layers: values.layers.map((layer) => ({ ...layer, params: { ...layer.params } })),
    routes: [...values.routes],
  }
}

export function cloneOmni(patch: OmniPatch, newId = false): OmniPatch {
  const copy: OmniPatch = {
    ...patch,
    id: newId ? uid('omni') : patch.id,
    layers: patch.layers.map((layer) => ({
      ...layer,
      granular: { ...layer.granular },
      params: { ...layer.params },
    })),
    routes: patch.routes.map((route) => ({ ...route })),
    morph: {
      x: patch.morph.x,
      y: patch.morph.y,
      corners: patch.morph.corners.map((item) => ({
        ...item,
        values: cloneNumbers(item.values),
      })) as OmniPatch['morph']['corners'],
    },
  }
  return copy
}

export function bilinear(a: number, b: number, c: number, d: number, x: number, y: number) {
  const top = a + (b - a) * x
  const bottom = c + (d - c) * x
  return top + (bottom - top) * y
}

function num(values: PatchNumbers | undefined, index: number, key: keyof LayerNumbers, fallback: number) {
  const layer = values?.layers[index]
  const value = layer ? layer[key] : fallback
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function nearestCorner(x: number, y: number) {
  const points = [[0, 0], [1, 0], [0, 1], [1, 1]]
  let best = 0
  let dist = Infinity
  points.forEach(([px, py], index) => {
    const next = (px - x) ** 2 + (py - y) ** 2
    if (next < dist) {
      dist = next
      best = index
    }
  })
  return best
}

export function morphActive(patch: OmniPatch) {
  return patch.morph.corners.some((item) => item.captured)
}

export function followCorners(patch: OmniPatch) {
  const current = captureNumbers(patch)
  for (const item of patch.morph.corners) {
    if (!item.captured) item.values = cloneNumbers(current)
  }
}

/** The sound the pad is playing. Kinds and audio files stay on the base layer. */
export function morphedPatch(patch: OmniPatch): OmniPatch {
  const next = cloneOmni(patch)
  const x = clamp(patch.morph.x, 0, 1)
  const y = clamp(patch.morph.y, 0, 1)
  const corners = patch.morph.corners
  next.layers.forEach((layer, index) => {
    const pick = (key: keyof LayerNumbers, fallback: number) => bilinear(
      num(corners[0]?.values, index, key, fallback),
      num(corners[1]?.values, index, key, fallback),
      num(corners[2]?.values, index, key, fallback),
      num(corners[3]?.values, index, key, fallback),
      x,
      y,
    )
    layer.enabled = pick('enabled', layer.enabled ? 1 : 0) >= 0.5
    layer.keyLo = Math.round(pick('keyLo', layer.keyLo))
    layer.keyHi = Math.round(pick('keyHi', layer.keyHi))
    layer.velLo = pick('velLo', layer.velLo)
    layer.velHi = pick('velHi', layer.velHi)
    layer.level = pick('level', layer.level)
    layer.pan = pick('pan', layer.pan)
    layer.cutoff = pick('cutoff', layer.cutoff)
    layer.resonance = pick('resonance', layer.resonance)
    layer.filterMode = Math.round(pick('filterMode', layer.filterMode))
    layer.fxSend = pick('fxSend', layer.fxSend)
    layer.root = Math.round(pick('root', layer.root))
    layer.granular.position = pick('position', layer.granular.position)
    layer.granular.size = pick('size', layer.granular.size)
    layer.granular.density = pick('density', layer.granular.density)
    layer.granular.spray = pick('spray', layer.granular.spray)
    layer.granular.pitch = pick('pitch', layer.granular.pitch)
    layer.granular.freeze = pick('freeze', layer.granular.freeze ? 1 : 0) >= 0.5
    const paramKeys = new Set<string>([
      ...MORPH_PARAM_KEYS,
      ...Object.keys(layer.params),
      ...corners.flatMap((item) => Object.keys(item.values.layers[index]?.params ?? {})),
    ])
    for (const key of paramKeys) {
      const samples = corners.map((item) => item.values.layers[index]?.params?.[key])
      if (samples.every((value) => typeof value !== 'number') && typeof layer.params[key] !== 'number') continue
      const fallback = layer.params[key] ?? 0
      layer.params[key] = bilinear(
        typeof samples[0] === 'number' ? samples[0] : fallback,
        typeof samples[1] === 'number' ? samples[1] : fallback,
        typeof samples[2] === 'number' ? samples[2] : fallback,
        typeof samples[3] === 'number' ? samples[3] : fallback,
        x,
        y,
      )
    }
    if (layer.keyLo > layer.keyHi) [layer.keyLo, layer.keyHi] = [layer.keyHi, layer.keyLo]
    if (layer.velLo > layer.velHi) [layer.velLo, layer.velHi] = [layer.velHi, layer.velLo]
  })
  next.routes.forEach((route, index) => {
    route.depth = bilinear(
      corners[0]?.values.routes[index] ?? route.depth,
      corners[1]?.values.routes[index] ?? route.depth,
      corners[2]?.values.routes[index] ?? route.depth,
      corners[3]?.values.routes[index] ?? route.depth,
      x,
      y,
    )
  })
  const rate = (key: keyof PatchNumbers, fallback: number) => bilinear(
    typeof corners[0]?.values[key] === 'number' ? corners[0].values[key] as number : fallback,
    typeof corners[1]?.values[key] === 'number' ? corners[1].values[key] as number : fallback,
    typeof corners[2]?.values[key] === 'number' ? corners[2].values[key] as number : fallback,
    typeof corners[3]?.values[key] === 'number' ? corners[3].values[key] as number : fallback,
    x,
    y,
  )
  next.lfo1Rate = rate('lfo1Rate', patch.lfo1Rate)
  next.lfo2Rate = rate('lfo2Rate', patch.lfo2Rate)
  next.env1Attack = rate('env1Attack', patch.env1Attack)
  next.env1Decay = rate('env1Decay', patch.env1Decay)
  next.env1Sustain = rate('env1Sustain', patch.env1Sustain)
  next.env1Release = rate('env1Release', patch.env1Release)
  next.env2Attack = rate('env2Attack', patch.env2Attack)
  next.env2Decay = rate('env2Decay', patch.env2Decay)
  next.env2Sustain = rate('env2Sustain', patch.env2Sustain)
  next.env2Release = rate('env2Release', patch.env2Release)
  return next
}

function publishField(patch: OmniPatch, apply: (values: LayerNumbers, index: number) => void, layerIndex: number) {
  if (!morphActive(patch)) {
    followCorners(patch)
    return
  }
  const corner = patch.morph.corners[nearestCorner(patch.morph.x, patch.morph.y)]
  const slot = corner.values.layers[layerIndex]
  if (!slot) {
    corner.values = captureNumbers(patch)
    corner.captured = true
    followCorners(patch)
    return
  }
  apply(slot, layerIndex)
  corner.captured = true
  followCorners(patch)
}

export function editLayer(patch: OmniPatch, layerId: string, partial: Partial<PatchLayer> & { granular?: Partial<GranularSettings> }) {
  const index = patch.layers.findIndex((layer) => layer.id === layerId)
  const layer = patch.layers[index]
  if (!layer) return
  const { granular, params, ...rest } = partial
  Object.assign(layer, rest)
  if (granular) Object.assign(layer.granular, granular)
  if (params) layer.params = { ...layer.params, ...params }
  clampLayer(layer)
  publishField(patch, (slot) => {
    slot.enabled = layer.enabled ? 1 : 0
    slot.keyLo = layer.keyLo
    slot.keyHi = layer.keyHi
    slot.velLo = layer.velLo
    slot.velHi = layer.velHi
    slot.level = layer.level
    slot.pan = layer.pan
    slot.cutoff = layer.cutoff
    slot.resonance = layer.resonance
    slot.filterMode = layer.filterMode
    slot.fxSend = layer.fxSend
    slot.root = layer.root
    slot.position = layer.granular.position
    slot.size = layer.granular.size
    slot.density = layer.granular.density
    slot.spray = layer.granular.spray
    slot.pitch = layer.granular.pitch
    slot.freeze = layer.granular.freeze ? 1 : 0
    slot.params = { ...layer.params }
  }, index)
}

export function setLayerKind(patch: OmniPatch, layerId: string, kind: LayerKind) {
  editLayer(patch, layerId, { kind })
}

export function addLayer(patch: OmniPatch, kind: LayerKind = 'analog') {
  if (patch.layers.length >= MAX_LAYERS) return null
  const layer = emptyLayer(kind)
  if (kind === 'granular') layer.level = 0.7
  patch.layers.push(layer)
  for (const item of patch.morph.corners) {
    const numbers = captureNumbers(patch)
    const added = numbers.layers[patch.layers.length - 1]
    if (item.captured) item.values.layers.push({ ...added, params: { ...added.params } })
  }
  followCorners(patch)
  return layer
}

export function removeLayer(patch: OmniPatch, layerId: string) {
  if (patch.layers.length <= 1) return
  const index = patch.layers.findIndex((layer) => layer.id === layerId)
  if (index < 0) return
  patch.layers.splice(index, 1)
  for (const item of patch.morph.corners) item.values.layers.splice(index, 1)
  followCorners(patch)
}

export function addRoute(patch: OmniPatch): ModRoute | null {
  if (patch.routes.length >= MAX_ROUTES) return null
  const route: ModRoute = { id: uid('mod'), source: 'lfo1', target: 'layer:0:cutoff', depth: 0 }
  patch.routes.push(route)
  for (const item of patch.morph.corners) {
    if (item.captured) item.values.routes.push(0)
  }
  followCorners(patch)
  return route
}

export function editRoute(patch: OmniPatch, routeId: string, partial: Partial<ModRoute>) {
  const index = patch.routes.findIndex((route) => route.id === routeId)
  const route = patch.routes[index]
  if (!route) return
  if (partial.source && SOURCES.includes(partial.source)) route.source = partial.source
  if (typeof partial.target === 'string') route.target = partial.target
  if (typeof partial.depth === 'number') route.depth = clamp(partial.depth, -1, 1)
  if (!morphActive(patch)) {
    followCorners(patch)
    return
  }
  const corner = patch.morph.corners[nearestCorner(patch.morph.x, patch.morph.y)]
  if (corner.values.routes.length <= index) corner.values.routes.push(route.depth)
  else corner.values.routes[index] = route.depth
  corner.captured = true
  followCorners(patch)
}

export function removeRoute(patch: OmniPatch, routeId: string) {
  const index = patch.routes.findIndex((route) => route.id === routeId)
  if (index < 0) return
  patch.routes.splice(index, 1)
  for (const item of patch.morph.corners) item.values.routes.splice(index, 1)
  followCorners(patch)
}

export function setRates(patch: OmniPatch, partial: Partial<Pick<OmniPatch, 'lfo1Rate' | 'lfo2Rate' | 'env1Attack' | 'env1Release' | 'env2Attack' | 'env2Release'>>) {
  if (partial.lfo1Rate != null) patch.lfo1Rate = clamp(partial.lfo1Rate, 0.02, 20)
  if (partial.lfo2Rate != null) patch.lfo2Rate = clamp(partial.lfo2Rate, 0.02, 20)
  if (partial.env1Attack != null) patch.env1Attack = clamp(partial.env1Attack, 1, 4000)
  if (partial.env1Release != null) patch.env1Release = clamp(partial.env1Release, 5, 8000)
  if (partial.env2Attack != null) patch.env2Attack = clamp(partial.env2Attack, 1, 4000)
  if (partial.env2Release != null) patch.env2Release = clamp(partial.env2Release, 5, 8000)
  if (!morphActive(patch)) {
    followCorners(patch)
    return
  }
  const corner = patch.morph.corners[nearestCorner(patch.morph.x, patch.morph.y)]
  corner.values.lfo1Rate = patch.lfo1Rate
  corner.values.lfo2Rate = patch.lfo2Rate
  corner.values.env1Attack = patch.env1Attack
  corner.values.env1Release = patch.env1Release
  corner.values.env2Attack = patch.env2Attack
  corner.values.env2Release = patch.env2Release
  corner.captured = true
  followCorners(patch)
}

export function setPerformance(patch: OmniPatch, partial: { modWheel?: number; aftertouch?: number; macro1?: number; macro2?: number; x?: number; y?: number }) {
  if (partial.modWheel != null) patch.modWheel = clamp(partial.modWheel, 0, 1)
  if (partial.aftertouch != null) patch.aftertouch = clamp(partial.aftertouch, 0, 1)
  if (partial.macro1 != null) patch.macro1 = clamp(partial.macro1, 0, 1)
  if (partial.macro2 != null) patch.macro2 = clamp(partial.macro2, 0, 1)
  if (partial.x != null) patch.morph.x = clamp(partial.x, 0, 1)
  if (partial.y != null) patch.morph.y = clamp(partial.y, 0, 1)
}

export function captureCorner(patch: OmniPatch, index: number) {
  const cornerItem = patch.morph.corners[index]
  if (!cornerItem) return
  cornerItem.values = captureNumbers(morphedPatch(patch))
  cornerItem.captured = true
  cornerItem.name = CORNER_NAMES[index] || cornerItem.name
}

export function inRange(layer: PatchLayer, note: number, velocity: number) {
  const midi = Math.round(note)
  return midi >= layer.keyLo && midi <= layer.keyHi && velocity >= layer.velLo - 1e-4 && velocity <= layer.velHi + 1e-4
}

export function parseTarget(target: string) {
  const param = /^layer:(\d+):param:([A-Za-z][A-Za-z0-9_]*)$/.exec(target)
  if (param) return { index: Number(param[1]), field: param[2], param: true }
  const match = /^layer:(\d+):([A-Za-z][A-Za-z0-9_]*)$/.exec(target)
  if (!match) return null
  return { index: Number(match[1]), field: match[2], param: false }
}

const PARAM_DEFAULTS: Record<string, Record<string, number>> = {
  analog: { detune: 4, attack: 8, release: 280, wave1: 0, cutoff: 14000 },
  wavetable: { position: 0, attack: 8, release: 280 },
  fm: { index: 1.1, ratio: 2, feedback: 0.08, attack: 6 },
  sampler: { pitch: 0, attack: 4, release: 180 },
  granular: {},
}

export function rangeFor(field: string, base: number): FieldRange {
  if (FIELD_RANGE[field]) return FIELD_RANGE[field]
  if (PARAM_RANGE[field]) return PARAM_RANGE[field]
  const span = Math.max(1, Math.abs(base))
  return { min: base - span, max: base + span }
}

export function paramBase(kind: string, field: string, params: Record<string, number>) {
  if (typeof params[field] === 'number' && Number.isFinite(params[field])) return params[field]
  return PARAM_DEFAULTS[kind]?.[field] ?? 0
}

export function fieldOf(layer: PatchLayer, field: string) {
  if (field === 'position') return layer.granular.position
  if (field === 'size') return layer.granular.size
  if (field === 'density') return layer.granular.density
  if (field === 'spray') return layer.granular.spray
  if (field === 'pitch') return layer.granular.pitch
  if (field === 'level') return layer.level
  if (field === 'pan') return layer.pan
  if (field === 'cutoff') return layer.cutoff
  if (field === 'resonance') return layer.resonance
  if (field === 'fxSend') return layer.fxSend
  return null
}

export function modulate(base: number, range: FieldRange, depth: number, source: number, bipolar: boolean) {
  const span = range.max - range.min
  const delta = bipolar ? depth * source * span * 0.5 : depth * source * span
  return clamp(base + delta, range.min, range.max)
}

export function sourceIsBipolar(id: ModSourceId) {
  return BIPOLAR_SOURCES.has(id)
}

const KIND_PARAMS: Record<string, { id: string; name: string }[]> = {
  analog: [
    { id: 'detune', name: 'detune' },
    { id: 'wave1', name: 'wave' },
    { id: 'attack', name: 'attack' },
    { id: 'release', name: 'release' },
    { id: 'cutoff', name: 'synth cutoff' },
  ],
  wavetable: [
    { id: 'position', name: 'table position' },
    { id: 'attack', name: 'attack' },
    { id: 'release', name: 'release' },
  ],
  fm: [
    { id: 'index', name: 'FM index' },
    { id: 'ratio', name: 'ratio' },
    { id: 'feedback', name: 'feedback' },
    { id: 'attack', name: 'attack' },
  ],
  sampler: [
    { id: 'pitch', name: 'pitch' },
    { id: 'attack', name: 'attack' },
    { id: 'release', name: 'release' },
  ],
  granular: [],
}

export function destinationsFor(patch: OmniPatch) {
  const out: { id: string; name: string }[] = []
  patch.layers.forEach((layer, index) => {
    const label = `L${index + 1}`
    out.push({ id: `layer:${index}:level`, name: `${label} level` })
    out.push({ id: `layer:${index}:pan`, name: `${label} pan` })
    out.push({ id: `layer:${index}:cutoff`, name: `${label} cutoff` })
    out.push({ id: `layer:${index}:resonance`, name: `${label} resonance` })
    out.push({ id: `layer:${index}:fxSend`, name: `${label} send` })
    if (layer.kind === 'granular') {
      out.push({ id: `layer:${index}:position`, name: `${label} position` })
      out.push({ id: `layer:${index}:size`, name: `${label} size` })
      out.push({ id: `layer:${index}:density`, name: `${label} density` })
      out.push({ id: `layer:${index}:spray`, name: `${label} spray` })
      out.push({ id: `layer:${index}:pitch`, name: `${label} pitch` })
    }
    const seen = new Set<string>()
    for (const item of KIND_PARAMS[layer.kind] ?? []) {
      seen.add(item.id)
      out.push({ id: `layer:${index}:param:${item.id}`, name: `${label} ${item.name}` })
    }
    for (const key of Object.keys(layer.params)) {
      if (seen.has(key)) continue
      out.push({ id: `layer:${index}:param:${key}`, name: `${label} ${key}` })
    }
  })
  return out
}

export function patchBufferIds(project: { tracks: { omniPatch?: OmniPatch | null }[]; omniLibrary?: OmniPatch[] }) {
  const ids = new Set<string>()
  const patches = [...(project.omniLibrary ?? [])]
  for (const track of project.tracks) if (track.omniPatch) patches.push(track.omniPatch)
  for (const patch of patches) for (const layer of patch.layers) if (layer.bufferId) ids.add(layer.bufferId)
  return [...ids]
}

function clampLayer(layer: PatchLayer) {
  layer.keyLo = clamp(Math.round(layer.keyLo), 0, 127)
  layer.keyHi = clamp(Math.round(layer.keyHi), 0, 127)
  if (layer.keyLo > layer.keyHi) [layer.keyLo, layer.keyHi] = [layer.keyHi, layer.keyLo]
  layer.velLo = clamp(layer.velLo, 0, 1)
  layer.velHi = clamp(layer.velHi, 0, 1)
  if (layer.velLo > layer.velHi) [layer.velLo, layer.velHi] = [layer.velHi, layer.velLo]
  layer.level = clamp(layer.level, 0, 1)
  layer.pan = clamp(layer.pan, -1, 1)
  layer.cutoff = clamp(layer.cutoff, 40, 16000)
  layer.resonance = clamp(layer.resonance, 0, 0.92)
  layer.filterMode = clamp(Math.round(layer.filterMode), 0, 2)
  layer.fxSend = clamp(layer.fxSend, 0, 1)
  layer.root = clamp(Math.round(layer.root), 0, 127)
  layer.granular.position = clamp(layer.granular.position, 0, 1)
  layer.granular.size = clamp(layer.granular.size, 10, 400)
  layer.granular.density = clamp(layer.granular.density, 1, 40)
  layer.granular.spray = clamp(layer.granular.spray, 0, 1)
  layer.granular.pitch = clamp(layer.granular.pitch, -24, 24)
  layer.granular.freeze = !!layer.granular.freeze
  if (!KINDS.includes(layer.kind)) layer.kind = 'analog'
}

function numOr(value: unknown, fallback: number, min: number, max: number) {
  const next = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return clamp(next, min, max)
}

function normalizeLayer(input: unknown, index: number): PatchLayer {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<PatchLayer>
  const grain = (raw.granular && typeof raw.granular === 'object' ? raw.granular : {}) as Partial<GranularSettings>
  const layer = emptyLayer(KINDS.includes(raw.kind as LayerKind) ? raw.kind as LayerKind : 'analog')
  layer.id = typeof raw.id === 'string' && raw.id ? raw.id : layer.id
  layer.enabled = raw.enabled !== false
  layer.keyLo = numOr(raw.keyLo, 0, 0, 127)
  layer.keyHi = numOr(raw.keyHi, 127, 0, 127)
  layer.velLo = numOr(raw.velLo, 0, 0, 1)
  layer.velHi = numOr(raw.velHi, 1, 0, 1)
  layer.level = numOr(raw.level, 0.8, 0, 1)
  layer.pan = numOr(raw.pan, index === 1 ? -0.15 : index === 2 ? 0.15 : 0, -1, 1)
  layer.cutoff = numOr(raw.cutoff, 3200, 40, 16000)
  layer.resonance = numOr(raw.resonance, 0.08, 0, 0.92)
  layer.filterMode = numOr(raw.filterMode, 0, 0, 2)
  layer.fxSend = numOr(raw.fxSend, 0, 0, 1)
  layer.bufferId = typeof raw.bufferId === 'string' ? raw.bufferId : ''
  layer.root = numOr(raw.root, 60, 0, 127)
  layer.granular = {
    position: numOr(grain.position, 0.35, 0, 1),
    size: numOr(grain.size, 90, 10, 400),
    density: numOr(grain.density, 18, 1, 40),
    spray: numOr(grain.spray, 0.12, 0, 1),
    pitch: numOr(grain.pitch, 0, -24, 24),
    freeze: grain.freeze !== false,
  }
  layer.params = {}
  if (raw.params && typeof raw.params === 'object') {
    for (const [key, value] of Object.entries(raw.params)) {
      if (typeof value === 'number' && Number.isFinite(value)) layer.params[key] = value
    }
  }
  clampLayer(layer)
  return layer
}

function normalizeNumbers(input: unknown, fallback: PatchNumbers): PatchNumbers {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<PatchNumbers>
  const layers = Array.isArray(raw.layers) ? raw.layers : []
  const base = cloneNumbers(fallback)
  base.layers = base.layers.map((layer, index) => {
    const item = layers[index]
    if (!item || typeof item !== 'object') return layer
    return {
      ...layer,
      ...Object.fromEntries(Object.entries(item).filter(([key, value]) => key !== 'params' && typeof value === 'number' && Number.isFinite(value))),
      params: {
        ...layer.params,
        ...(item.params && typeof item.params === 'object'
          ? Object.fromEntries(Object.entries(item.params).filter((entry) => typeof entry[1] === 'number' && Number.isFinite(entry[1])))
          : {}),
      },
    }
  })
  if (Array.isArray(raw.routes)) base.routes = raw.routes.map((value, index) => numOr(value, base.routes[index] ?? 0, -1, 1))
  base.lfo1Rate = numOr(raw.lfo1Rate, base.lfo1Rate, 0.02, 20)
  base.lfo2Rate = numOr(raw.lfo2Rate, base.lfo2Rate, 0.02, 20)
  base.env1Attack = numOr(raw.env1Attack, base.env1Attack, 1, 4000)
  base.env1Decay = numOr(raw.env1Decay, base.env1Decay, 5, 8000)
  base.env1Sustain = numOr(raw.env1Sustain, base.env1Sustain, 0, 1)
  base.env1Release = numOr(raw.env1Release, base.env1Release, 5, 8000)
  base.env2Attack = numOr(raw.env2Attack, base.env2Attack, 1, 4000)
  base.env2Decay = numOr(raw.env2Decay, base.env2Decay, 5, 8000)
  base.env2Sustain = numOr(raw.env2Sustain, base.env2Sustain, 0, 1)
  base.env2Release = numOr(raw.env2Release, base.env2Release, 5, 8000)
  return base
}

export function normalizeOmni(input: unknown): OmniPatch | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Partial<OmniPatch>
  const patch = emptyOmni(typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 64) : 'Patch')
  patch.id = typeof raw.id === 'string' && raw.id ? raw.id : patch.id
  patch.enabled = raw.enabled !== false
  const layers = Array.isArray(raw.layers) ? raw.layers.slice(0, MAX_LAYERS).map((layer, index) => normalizeLayer(layer, index)) : patch.layers
  patch.layers = layers.length ? layers : patch.layers
  const routes = Array.isArray(raw.routes) ? raw.routes : []
  patch.routes = routes.slice(0, MAX_ROUTES).map((route) => {
    const item = (route && typeof route === 'object' ? route : {}) as Partial<ModRoute>
    const source = SOURCES.includes(item.source as ModSourceId) ? item.source as ModSourceId : 'lfo1'
    return {
      id: typeof item.id === 'string' && item.id ? item.id : uid('mod'),
      source,
      target: typeof item.target === 'string' ? item.target : 'layer:0:cutoff',
      depth: numOr(item.depth, 0, -1, 1),
    }
  })
  patch.lfo1Rate = numOr(raw.lfo1Rate, patch.lfo1Rate, 0.02, 20)
  patch.lfo2Rate = numOr(raw.lfo2Rate, patch.lfo2Rate, 0.02, 20)
  patch.env1Attack = numOr(raw.env1Attack, patch.env1Attack, 1, 4000)
  patch.env1Decay = numOr(raw.env1Decay, patch.env1Decay, 5, 8000)
  patch.env1Sustain = numOr(raw.env1Sustain, patch.env1Sustain, 0, 1)
  patch.env1Release = numOr(raw.env1Release, patch.env1Release, 5, 8000)
  patch.env2Attack = numOr(raw.env2Attack, patch.env2Attack, 1, 4000)
  patch.env2Decay = numOr(raw.env2Decay, patch.env2Decay, 5, 8000)
  patch.env2Sustain = numOr(raw.env2Sustain, patch.env2Sustain, 0, 1)
  patch.env2Release = numOr(raw.env2Release, patch.env2Release, 5, 8000)
  patch.modWheel = numOr(raw.modWheel, 0, 0, 1)
  patch.aftertouch = numOr(raw.aftertouch, 0, 0, 1)
  patch.macro1 = numOr(raw.macro1, 0, 0, 1)
  patch.macro2 = numOr(raw.macro2, 0, 0, 1)
  const morph = raw.morph
  patch.morph.x = numOr(morph?.x, 0, 0, 1)
  patch.morph.y = numOr(morph?.y, 0, 0, 1)
  const numbers = captureNumbers(patch)
  const incoming = morph?.corners
  patch.morph.corners = [0, 1, 2, 3].map((index) => {
    const item = incoming?.[index]
    const values = normalizeNumbers(item?.values, numbers)
    values.layers = numbers.layers.map((layer, layerIndex) => values.layers[layerIndex] ?? layer)
    values.routes = patch.routes.map((_, routeIndex) => values.routes[routeIndex] ?? patch.routes[routeIndex].depth)
    return {
      id: typeof item?.id === 'string' && item.id ? item.id : uid('corner'),
      name: CORNER_NAMES[index],
      captured: item?.captured === true,
      values,
    }
  }) as OmniPatch['morph']['corners']
  return patch
}

export function normalizeOmniProject(project: { tracks: { type: string; omniPatch?: unknown }[]; omniLibrary?: unknown }) {
  const library = Array.isArray(project.omniLibrary) ? project.omniLibrary : []
  project.omniLibrary = library.map((item) => normalizeOmni(item)).filter((item): item is OmniPatch => !!item).slice(0, 64)
  for (const track of project.tracks) {
    if (track.type !== 'midi') {
      track.omniPatch = undefined
      continue
    }
    if (track.omniPatch == null) continue
    track.omniPatch = normalizeOmni(track.omniPatch) ?? undefined
  }
}

import type { Project } from '../model/types'

/** One field write. Values are musical data, never samples. */
export interface ProjectOp {
  /** Device that wrote the change. */
  a: string
  /** Per-device sequence. Gaps are buffered, not applied early. */
  s: number
  /** Lamport time. The later stamp wins a conflict. */
  l: number
  /** Id path. `tracks/<id>/volume`. A trailing `@order` reorders a list. */
  p: string
  /** `null` deletes a list item or field. */
  v: unknown
}

export interface Stamp {
  l: number
  a: string
}

/** Compact stamp wire form: `[path, lamport, actor]`. */
export type StampWire = [string, number, string]

export interface SyncHello {
  actor: string
  seq: number
  lamport: number
  digest: string
  seen: Record<string, number>
}

interface Schema {
  lists?: Record<string, Schema | null>
  objects?: Record<string, Schema>
  maps?: string[]
}

const PLUGIN_SCHEMA: Schema = { maps: ['params'] }
const DEVICE_SCHEMA: Schema = { maps: ['params'] }
const TRACK_SCHEMA: Schema = {
  lists: {
    inserts: null,
    plugins: PLUGIN_SCHEMA,
    sends: null,
    clips: null,
    midiClips: { lists: { notes: null } },
  },
  objects: {
    rack: { lists: { devices: DEVICE_SCHEMA } },
  },
}

const PROJECT_SCHEMA: Schema = {
  lists: {
    tracks: TRACK_SCHEMA,
    masterInserts: null,
    masterPlugins: PLUGIN_SCHEMA,
    automation: null,
    presets: null,
    devicePresets: null,
    rackPatches: null,
    rackAutomation: null,
    patternClips: null,
  },
  objects: {
    beats: { lists: { patterns: { lists: { channels: {} } } } },
    padKit: { lists: { sequences: null } },
  },
}

const LIST_KEYS = new Set([
  'tracks',
  'inserts',
  'plugins',
  'sends',
  'clips',
  'midiClips',
  'notes',
  'masterInserts',
  'masterPlugins',
  'automation',
  'presets',
  'devicePresets',
  'rackPatches',
  'rackAutomation',
  'patternClips',
  'patterns',
  'channels',
  'devices',
  'sequences',
])

const AUDIO_KEYS = new Set(['wav', 'channels', 'pcm', 'samples'])

export interface RawChange {
  p: string
  v: unknown
}

export function digestProject(project: Project): string {
  return fnv(stableStringify(musicalClone(project)))
}

export function musicalClone(project: Project): Project {
  const copy = JSON.parse(JSON.stringify(project)) as Project
  delete copy.waveforms
  return copy
}

export function diffProject(before: Project | null, after: Project): RawChange[] {
  const out: RawChange[] = []
  diffAny(before ? musicalClone(before) : {}, musicalClone(after), PROJECT_SCHEMA, '', out)
  return out
}

export function packStamps(stamps: Map<string, Stamp>): StampWire[] {
  return [...stamps].map(([path, stamp]) => [path, stamp.l, stamp.a])
}

export function unpackStamps(wire: StampWire[] | undefined): Map<string, Stamp> {
  const stamps = new Map<string, Stamp>()
  if (!Array.isArray(wire)) return stamps
  for (const item of wire) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue
    stamps.set(item[0], { l: Number(item[1]) || 0, a: String(item[2] || '') })
  }
  return stamps
}

export function validOp(op: ProjectOp): boolean {
  return Boolean(
    op &&
      typeof op.a === 'string' &&
      op.a.length > 0 &&
      op.a.length < 80 &&
      typeof op.p === 'string' &&
      op.p.length > 0 &&
      op.p.length < 400 &&
      !op.p.includes('..') &&
      Number.isInteger(op.s) &&
      op.s > 0 &&
      Number.isFinite(op.l),
  )
}

/** Reject payloads that smuggle audio. Musical JSON stays. */
export function containsAudio(value: unknown, depth = 0): boolean {
  if (depth > 16) return false
  if (typeof value === 'string') return value.length > 20000
  if (Array.isArray(value)) {
    if (value.length > 4000 && value.every((item) => typeof item === 'number')) return true
    return value.some((item) => containsAudio(item, depth + 1))
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (AUDIO_KEYS.has(key)) return true
      if (containsAudio(child, depth + 1)) return true
    }
  }
  return false
}

export function syncMessageOk(msg: { t?: string; ops?: unknown; project?: unknown; [key: string]: unknown }): boolean {
  if (!msg || (msg.t !== 'sync-hello' && msg.t !== 'sync-ops' && msg.t !== 'sync-checkpoint')) return false
  let text = ''
  try {
    text = JSON.stringify(msg)
  } catch {
    return false
  }
  if (containsAudio(msg)) return false
  if (msg.t === 'sync-hello') return text.length <= 16_000
  if (msg.t === 'sync-ops') return text.length <= 96_000 && Array.isArray(msg.ops) && msg.ops.length <= 80
  return text.length <= 400_000
}

export function setPath(root: object, path: string, value: unknown) {
  const parts = path.split('/')
  let node: any = root
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]
    const next = parts[i + 1]
    if (next === '@order' && i + 1 === parts.length - 1) {
      reorder(ensureList(node, key), value)
      return
    }
    if (LIST_KEYS.has(key)) {
      const list = ensureList(node, key)
      if (i + 1 === parts.length - 1) {
        upsert(list, next, value)
        return
      }
      node = ensureItem(list, next)
      i += 1
      continue
    }
    if (node[key] == null || typeof node[key] !== 'object' || Array.isArray(node[key])) node[key] = {}
    node = node[key]
  }
  const leaf = parts[parts.length - 1]
  if (leaf === '@order' && Array.isArray(node)) {
    reorder(node, value)
    return
  }
  if (value == null) delete node[leaf]
  else node[leaf] = value
}

export function getPath(root: object, path: string): unknown {
  const parts = path.split('/')
  let node: any = root
  for (const key of parts) {
    if (node == null) return undefined
    if (Array.isArray(node)) node = node.find((item) => item?.id === key)
    else node = node[key]
  }
  return node
}

function diffAny(before: any, after: any, schema: Schema | null, path: string, out: RawChange[]) {
  if (schema == null) {
    if (!same(before, after)) out.push({ p: path, v: after === undefined ? null : after })
    return
  }
  const left = before && typeof before === 'object' && !Array.isArray(before) ? before : {}
  const right = after && typeof after === 'object' && !Array.isArray(after) ? after : {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (key === 'waveforms') continue
    const child = path ? `${path}/${key}` : key
    if (schema.lists && key in schema.lists) {
      diffList(left[key], right[key], schema.lists[key], child, out)
      continue
    }
    if (schema.objects && key in schema.objects) {
      if (left[key] == null && right[key] == null) continue
      if (left[key] == null || right[key] == null) {
        out.push({ p: child, v: right[key] === undefined ? null : right[key] })
        continue
      }
      diffAny(left[key], right[key], schema.objects[key], child, out)
      continue
    }
    if (schema.maps?.includes(key)) {
      diffMap(left[key], right[key], child, out)
      continue
    }
    if (!same(left[key], right[key])) out.push({ p: child, v: right[key] === undefined ? null : right[key] })
  }
}

function diffList(before: any, after: any, itemSchema: Schema | null, path: string, out: RawChange[]) {
  const left = Array.isArray(before) ? before : []
  const right = Array.isArray(after) ? after : []
  if (left.some((item) => !item?.id) || right.some((item) => !item?.id)) {
    if (!same(left, right)) out.push({ p: path, v: right })
    return
  }
  const beforeById = new Map(left.map((item) => [item.id as string, item]))
  const afterById = new Map(right.map((item) => [item.id as string, item]))
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) out.push({ p: `${path}/${id}`, v: null })
  }
  for (const [id, item] of afterById) {
    if (!beforeById.has(id)) out.push({ p: `${path}/${id}`, v: item })
    else diffAny(beforeById.get(id), item, itemSchema, `${path}/${id}`, out)
  }
  const sameMembers = left.length === right.length && left.every((item) => afterById.has(item.id))
  if (sameMembers && left.some((item, index) => item.id !== right[index]?.id)) {
    out.push({ p: `${path}/@order`, v: right.map((item) => item.id) })
  }
}

function diffMap(before: any, after: any, path: string, out: RawChange[]) {
  const left = before && typeof before === 'object' ? before : {}
  const right = after && typeof after === 'object' ? after : {}
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (key.includes('/')) continue
    if (!same(left[key], right[key])) out.push({ p: `${path}/${key}`, v: right[key] === undefined ? null : right[key] })
  }
}

function same(left: unknown, right: unknown) {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`
}

function fnv(text: string) {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h1 ^= text.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= text.charCodeAt(text.length - 1 - i)
    h2 = Math.imul(h2, 0x01000193)
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)
}

function ensureList(node: any, key: string) {
  if (!Array.isArray(node[key])) node[key] = []
  return node[key] as any[]
}

function ensureItem(list: any[], id: string) {
  let item = list.find((entry) => entry?.id === id)
  if (!item) {
    item = { id }
    list.push(item)
  }
  return item
}

function upsert(list: any[], id: string, value: unknown) {
  const index = list.findIndex((entry) => entry?.id === id)
  if (value == null) {
    if (index >= 0) list.splice(index, 1)
    return
  }
  if (index >= 0) list[index] = value
  else list.push(value)
}

function reorder(list: any[], value: unknown) {
  if (!Array.isArray(value)) return
  const rank = new Map(value.map((id, index) => [String(id), index]))
  list.sort((left, right) => (rank.get(String(left?.id)) ?? 0) - (rank.get(String(right?.id)) ?? 0))
}

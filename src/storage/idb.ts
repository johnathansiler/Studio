import type { AudioAsset, Project } from '../model/types'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { migrateProject } from '../model/schema'
import { chooseCurrent, contentHash, dedupeBlobs, longestPeaks, planCommit, type AssetRef, type ProjectDoc, type SnapshotDoc, type WorkspaceSnapshot } from './content'
import { mirrorBlob, mirrorProject, removeMirror } from './opfs'

const DB_NAME = 'cueharbor'
const PROJECTS = 'projects'
const META = 'meta'
const BLOBS = 'blobs'
const SNAPSHOTS = 'snapshots'
const STAGING = 'staging'

export type { WorkspaceSnapshot } from './content'

export interface ProjectListItem {
  id: string
  name: string
  savedAt: number
  peaks: number[]
  bytes: number
}

const emptyWorkspace: WorkspaceSnapshot = {
  view: 'arrange',
  transportMode: 'arrangement',
  positionSamples: 0,
  selectedTrackId: null,
  surface: 'studio',
  phonePane: 'edit',
}

let cached: IDBDatabase | null = null
let opening: Promise<IDBDatabase> | null = null
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function openDb(): Promise<IDBDatabase> {
  if (cached) return Promise.resolve(cached)
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 3)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'hash' })
        if (!db.objectStoreNames.contains(SNAPSHOTS)) db.createObjectStore(SNAPSHOTS, { keyPath: 'key' })
        if (!db.objectStoreNames.contains(STAGING)) db.createObjectStore(STAGING, { keyPath: 'id' })
      }
      req.onsuccess = () => {
        cached = req.result
        cached.onversionchange = () => {
          cached?.close()
          cached = null
          opening = null
        }
        void recoverStaging(cached).then(() => resolve(cached as IDBDatabase), () => resolve(cached as IDBDatabase))
      }
      req.onerror = () => {
        opening = null
        reject(req.error)
      }
    })
  }
  return opening
}

export function isQuotaError(error: unknown) {
  return error instanceof DOMException && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')
}

export async function requestPersistentStorage() {
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* the browser may refuse persistence; the save still lands in IndexedDB */
  }
}

export async function storageReport(): Promise<{ used: number; quota: number | null; persisted: boolean }> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    const persisted = (await navigator.storage?.persisted?.()) === true
    return { used: estimate?.usage ?? 0, quota: estimate?.quota ?? null, persisted }
  } catch {
    return { used: 0, quota: null, persisted: false }
  }
}

export async function saveProject(project: Project, buffers: Map<string, AudioAsset>, workspace: WorkspaceSnapshot = emptyWorkspace, options: { snapshot?: boolean } = {}): Promise<'ok' | 'quota'> {
  try {
    return await enqueue(() => writeProject(project, buffers, workspace, options.snapshot === true))
  } catch (error) {
    if (isQuotaError(error)) return 'quota'
    throw error
  }
}

async function writeProject(project: Project, buffers: Map<string, AudioAsset>, workspace: WorkspaceSnapshot, snapshot: boolean) {
  const db = await openDb()
  const migrated = migrateProject(project)
  const stored: { hash: string; wav: Uint8Array }[] = []
  const assets: AssetRef[] = []
  for (const asset of buffers.values()) {
    const wav = new Uint8Array(encodeWav(asset.channels, asset.sampleRate, { bits: 32 }))
    const hash = await contentHash(wav)
    assets.push({ id: asset.id, name: asset.name, sampleRate: asset.sampleRate, hash })
    stored.push({ hash, wav })
  }
  const blobs = dedupeBlobs(stored)
  for (const [hash, wav] of blobs) {
    await putBlob(db, hash, wav)
    void mirrorBlob(hash, wav)
  }
  const doc: ProjectDoc = {
    id: migrated.id,
    name: migrated.name,
    savedAt: Date.now(),
    project: migrated,
    workspace,
    assets,
    peaks: longestPeaks([...buffers.values()]),
    bytes: [...blobs.values()].reduce((sum, wav) => sum + wav.byteLength, 0),
  }
  await idbPut(db, STAGING, doc)
  const current = (await idbGet<ProjectDoc>(db, PROJECTS, doc.id)) ?? null
  const snaps = (await idbAll<SnapshotDoc>(db, SNAPSHOTS)).filter((item) => item.projectId === doc.id || item.id === doc.id)
  const plan = planCommit({ next: doc, current, snapshots: snaps, snapshot: snapshot && current != null })
  await swap(db, plan.current, snaps, plan.snapshots)
  void mirrorProject(doc.id, doc)
  return 'ok' as const
}

async function swap(db: IDBDatabase, current: ProjectDoc, previous: SnapshotDoc[], next: SnapshotDoc[]) {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([PROJECTS, SNAPSHOTS, STAGING, META], 'readwrite')
    tx.objectStore(PROJECTS).put(current)
    for (const snap of previous) tx.objectStore(SNAPSHOTS).delete(snap.key)
    for (const snap of next) tx.objectStore(SNAPSHOTS).put(snap)
    tx.objectStore(STAGING).delete(current.id)
    tx.objectStore(META).put(current.id, 'last')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

async function recoverStaging(db: IDBDatabase) {
  const staged = await idbAll<ProjectDoc>(db, STAGING)
  for (const doc of staged) {
    const current = (await idbGet<ProjectDoc>(db, PROJECTS, doc.id)) ?? null
    const chosen = chooseCurrent(doc, current)
    if (chosen) await swap(db, chosen, [], (await idbAll<SnapshotDoc>(db, SNAPSHOTS)).filter((item) => item.projectId === doc.id))
    else await idbDelete(db, STAGING, doc.id)
  }
}

async function putBlob(db: IDBDatabase, hash: string, wav: Uint8Array) {
  const existing = await idbGet<{ hash: string }>(db, BLOBS, hash)
  if (existing) return
  const copy = new ArrayBuffer(wav.byteLength)
  new Uint8Array(copy).set(wav)
  await idbPut(db, BLOBS, { hash, bytes: wav.byteLength, wav: new Blob([copy], { type: 'audio/wav' }) })
}

export async function listProjects(): Promise<ProjectListItem[]> {
  const db = await openDb()
  const rows = await idbAll<ProjectDoc>(db, PROJECTS)
  return rows
    .filter((row) => row?.id)
    .map((row) => ({ id: row.id, name: row.name || 'Untitled', savedAt: row.savedAt || 0, peaks: row.peaks ?? [], bytes: row.bytes ?? 0 }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function listSnapshots(projectId: string): Promise<{ key: string; savedAt: number }[]> {
  const db = await openDb()
  const rows = await idbAll<SnapshotDoc>(db, SNAPSHOTS)
  return rows
    .filter((row) => row.projectId === projectId)
    .map((row) => ({ key: row.key, savedAt: row.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function loadProject(id: string) {
  const row = await readDoc(id, PROJECTS)
  if (!row) return null
  return { project: row.project, buffers: row.buffers, workspace: row.workspace }
}

export async function loadSnapshot(key: string) {
  const row = await readDoc(key, SNAPSHOTS)
  if (!row) return null
  return { project: row.project, buffers: row.buffers, workspace: row.workspace }
}

export async function loadLastProject(): Promise<{ project: Project; buffers: Map<string, AudioAsset>; workspace: WorkspaceSnapshot } | null> {
  const db = await openDb()
  const id = await idbGet<string>(db, META, 'last')
  if (!id) {
    const listed = await listProjects()
    if (!listed[0]) return null
    return readProject(listed[0].id)
  }
  return readProject(id)
}

export async function deleteProject(id: string) {
  await enqueue(async () => {
    const db = await openDb()
    const snaps = (await idbAll<SnapshotDoc>(db, SNAPSHOTS)).filter((item) => item.projectId === id)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([PROJECTS, SNAPSHOTS, STAGING, META], 'readwrite')
      tx.objectStore(PROJECTS).delete(id)
      tx.objectStore(STAGING).delete(id)
      for (const snap of snaps) tx.objectStore(SNAPSHOTS).delete(snap.key)
      tx.oncomplete = () => resolve()
      tx.onabort = () => reject(tx.error)
      tx.onerror = () => reject(tx.error)
    })
    const last = await idbGet<string>(db, META, 'last')
    if (last === id) {
      const listed = await listProjects()
      if (listed[0]) await idbPut(db, META, listed[0].id, 'last')
    }
    await collectBlobs(db)
    void removeMirror(id)
  })
}

async function collectBlobs(db: IDBDatabase) {
  const projects = await idbAll<ProjectDoc>(db, PROJECTS)
  const snaps = await idbAll<SnapshotDoc>(db, SNAPSHOTS)
  const used = new Set<string>()
  for (const doc of [...projects, ...snaps]) for (const asset of doc.assets ?? []) if (asset.hash) used.add(asset.hash)
  const blobs = await idbAll<{ hash: string }>(db, BLOBS)
  for (const blob of blobs) {
    if (!used.has(blob.hash)) await idbDelete(db, BLOBS, blob.hash)
  }
}

async function readProject(id: string) {
  return readDoc(id, PROJECTS)
}

async function readDoc(key: string, store: string) {
  const db = await openDb()
  const row = await idbGet<ProjectDoc & { assets: Array<AssetRef | { id: string; name: string; sampleRate: number; wav?: Blob; channels?: Float32Array[] }> }>(db, store, key)
  if (!row) return null
  const buffers = new Map<string, AudioAsset>()
  for (const asset of row.assets ?? []) {
    if (!asset) continue
    if ('wav' in asset && asset.wav instanceof Blob) {
      const decoded = decodeWavPCM(await asset.wav.arrayBuffer())
      buffers.set(asset.id, { id: asset.id, name: asset.name, sampleRate: decoded.sampleRate || asset.sampleRate, channels: decoded.channels })
    } else if ('channels' in asset && asset.channels) {
      buffers.set(asset.id, asset as AudioAsset)
    } else if ('hash' in asset && asset.hash) {
      const blob = await idbGet<{ wav: Blob }>(db, BLOBS, asset.hash)
      if (!blob?.wav) continue
      const decoded = decodeWavPCM(await blob.wav.arrayBuffer())
      buffers.set(asset.id, { id: asset.id, name: asset.name, sampleRate: decoded.sampleRate || asset.sampleRate, channels: decoded.channels })
    }
  }
  const project = migrateProject(row.project)
  return { project, buffers, workspace: { ...emptyWorkspace, ...row.workspace } }
}

function idbGet<T>(db: IDBDatabase, store: string, key: IDBValidKey): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve(undefined)
      return
    }
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

function idbAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve([])
      return
    }
    const tx = db.transaction(store, 'readonly')
    const req = tx.objectStore(store).getAll()
    req.onsuccess = () => resolve((req.result as T[]) ?? [])
    req.onerror = () => reject(req.error)
  })
}

function idbPut(db: IDBDatabase, store: string, value: unknown, key?: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

function idbDelete(db: IDBDatabase, store: string, key: IDBValidKey) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite')
    tx.objectStore(store).delete(key)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const size = 0x2000
  for (let i = 0; i < bytes.length; i += size) {
    const slice = bytes.subarray(i, i + size)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

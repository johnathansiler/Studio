import type { AudioAsset, Project } from '../model/types'
import { decodeWavPCM, encodeWav } from '../model/wav'

const DB_NAME = 'cueharbor'
const STORE = 'projects'
const META = 'meta'

export interface WorkspaceSnapshot {
  view: 'arrange' | 'mix' | 'session'
  transportMode: 'arrangement' | 'session'
  positionSamples: number
  selectedTrackId: string | null
  surface: 'studio' | 'artist'
  phonePane: 'edit' | 'room'
}

export interface SavedProject {
  id: string
  name: string
  savedAt: number
  project: Project
  workspace?: WorkspaceSnapshot
  assets: Array<AudioAsset | { id: string; name: string; sampleRate: number; wav: Blob }>
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

function openDb(): Promise<IDBDatabase> {
  if (cached) return Promise.resolve(cached)
  if (!opening) {
    opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META)
      }
      req.onsuccess = () => {
        cached = req.result
        cached.onversionchange = () => {
          cached?.close()
          cached = null
          opening = null
        }
        resolve(cached)
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

function projectRecord(project: Project, buffers: Map<string, AudioAsset>, workspace: WorkspaceSnapshot): SavedProject {
  return {
    id: project.id,
    name: project.name,
    savedAt: Date.now(),
    project,
    workspace,
    assets: [...buffers.values()].map((asset) => ({
      id: asset.id,
      name: asset.name,
      sampleRate: asset.sampleRate,
      wav: new Blob([encodeWav(asset.channels, asset.sampleRate)], { type: 'audio/wav' }),
    })),
  }
}

function putRecord(db: IDBDatabase, record: SavedProject) {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META], 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.objectStore(META).put(record.id, 'last')
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
    tx.onerror = () => reject(tx.error)
  })
}

export async function saveProject(project: Project, buffers: Map<string, AudioAsset>, workspace: WorkspaceSnapshot = emptyWorkspace): Promise<'ok' | 'quota'> {
  try {
    const record = projectRecord(project, buffers, workspace)
    if (cached) {
      await putRecord(cached, record)
      return 'ok'
    }
    await putRecord(await openDb(), record)
    return 'ok'
  } catch (error) {
    if (isQuotaError(error)) return 'quota'
    throw error
  }
}

export async function listProjects(): Promise<{ id: string; name: string; savedAt: number }[]> {
  const db = await openDb()
  const rows = await new Promise<SavedProject[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result as SavedProject[])
    req.onerror = () => reject(req.error)
  })
  return rows
    .map((row) => ({ id: row.id, name: row.name, savedAt: row.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

async function readProject(id: string): Promise<{ project: Project; buffers: Map<string, AudioAsset>; workspace: WorkspaceSnapshot } | null> {
  const db = await openDb()
  const row = await new Promise<SavedProject | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result as SavedProject | undefined)
    req.onerror = () => reject(req.error)
  })
  if (!row) return null
  const buffers = new Map<string, AudioAsset>()
  for (const asset of row.assets) {
    if (asset && 'wav' in asset && asset.wav instanceof Blob) {
      const decoded = decodeWavPCM(await asset.wav.arrayBuffer())
      buffers.set(asset.id, { id: asset.id, name: asset.name, sampleRate: decoded.sampleRate || asset.sampleRate, channels: decoded.channels })
    } else if (asset && 'channels' in asset) {
      buffers.set(asset.id, asset)
    }
  }
  return { project: row.project, buffers, workspace: { ...emptyWorkspace, ...row.workspace } }
}

export async function loadProject(id: string): Promise<{ project: Project; buffers: Map<string, AudioAsset> } | null> {
  const row = await readProject(id)
  if (!row) return null
  return { project: row.project, buffers: row.buffers }
}

export async function loadLastProject(): Promise<{ project: Project; buffers: Map<string, AudioAsset>; workspace: WorkspaceSnapshot } | null> {
  const db = await openDb()
  const id = await new Promise<string | undefined>((resolve, reject) => {
    if (!db.objectStoreNames.contains(META)) {
      resolve(undefined)
      return
    }
    const tx = db.transaction(META, 'readonly')
    const req = tx.objectStore(META).get('last')
    req.onsuccess = () => resolve(req.result as string | undefined)
    req.onerror = () => reject(req.error)
  })
  if (!id) {
    const listed = await listProjects()
    if (!listed[0]) return null
    return readProject(listed[0].id)
  }
  return readProject(id)
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

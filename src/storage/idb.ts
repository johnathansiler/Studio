import type { AudioAsset, Project } from '../model/types'

const DB_NAME = 'cueharbor'
const STORE = 'projects'

export interface SavedProject {
  id: string
  name: string
  savedAt: number
  project: Project
  assets: AudioAsset[]
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveProject(project: Project, buffers: Map<string, AudioAsset>): Promise<void> {
  const db = await openDb()
  const record: SavedProject = {
    id: project.id,
    name: project.name,
    savedAt: Date.now(),
    project,
    assets: [...buffers.values()].map((asset) => ({
      ...asset,
      channels: asset.channels.map((channel) => channel.slice()),
    })),
  }
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

export async function listProjects(): Promise<{ id: string; name: string; savedAt: number }[]> {
  const db = await openDb()
  const rows = await new Promise<SavedProject[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).getAll()
    req.onsuccess = () => resolve(req.result as SavedProject[])
    req.onerror = () => reject(req.error)
  })
  db.close()
  return rows
    .map((row) => ({ id: row.id, name: row.name, savedAt: row.savedAt }))
    .sort((a, b) => b.savedAt - a.savedAt)
}

export async function loadProject(id: string): Promise<{ project: Project; buffers: Map<string, AudioAsset> } | null> {
  const db = await openDb()
  const row = await new Promise<SavedProject | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(id)
    req.onsuccess = () => resolve(req.result as SavedProject | undefined)
    req.onerror = () => reject(req.error)
  })
  db.close()
  if (!row) return null
  const buffers = new Map<string, AudioAsset>()
  for (const asset of row.assets) buffers.set(asset.id, asset)
  return { project: row.project, buffers }
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

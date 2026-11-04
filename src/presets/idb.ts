import type { UserPreset } from '../model/types'

const DB_NAME = 'cueharbor-presets'
const STORE = 'presets'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadStoredPresets(): Promise<UserPreset[]> {
  if (typeof indexedDB === 'undefined') return []
  try {
    const db = await openDb()
    const rows = await new Promise<UserPreset[]>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      request.onsuccess = () => resolve((request.result as UserPreset[]) ?? [])
      request.onerror = () => reject(request.error)
    })
    db.close()
    return rows
  } catch {
    return []
  }
}

export async function writeStoredPreset(preset: UserPreset): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(preset)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch {
    /* the project copy still holds the preset */
  }
}

export async function removeStoredPreset(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
    db.close()
  } catch {
    /* ignore a closed browser database */
  }
}

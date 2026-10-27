import { requestPersistentStorage } from './idb'

const DB_NAME = 'cueharbor-library'
const STORE = 'files'

function safeName(id: string) {
  return id.replace(/[^a-z0-9._-]+/gi, '_')
}

async function openFiles(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return null
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
  })
}

/** Write one library file to OPFS, then IndexedDB. Never touches the app server. */
export async function writeLibraryFile(id: string, data: Uint8Array) {
  if (typeof navigator === 'undefined') return
  await requestPersistentStorage()
  const name = safeName(id)
  try {
    const root = await navigator.storage?.getDirectory?.()
    if (root) {
      const dir = await root.getDirectoryHandle('library', { create: true })
      const handle = await dir.getFileHandle(name, { create: true })
      const writable = await handle.createWritable()
      const copy = new Uint8Array(data.byteLength)
      copy.set(data)
      await writable.write(copy)
      await writable.close()
      return
    }
  } catch {
    /* OPFS can be unavailable in a private window. IndexedDB still holds the file. */
  }
  const db = await openFiles()
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(data, name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

export async function deleteLibraryFile(id: string) {
  if (typeof navigator === 'undefined') return
  const name = safeName(id)
  try {
    const root = await navigator.storage?.getDirectory?.()
    if (root) {
      const dir = await root.getDirectoryHandle('library')
      await dir.removeEntry(name)
    }
  } catch {
    /* already gone */
  }
  const db = await openFiles()
  if (!db) return
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(name)
    tx.oncomplete = () => resolve()
    tx.onerror = () => resolve()
  })
}

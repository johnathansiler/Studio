import type { LibraryFileRef, Project } from '../model/types'
import { LIBRARY_UNLOCKED, readLibraryAccessKey } from './access'
import { fetchLibraryBytes, libraryAudioCache } from './audio'
import { decodeSlotFile } from '../audio/sample/slot'
import type { ProjectStore } from '../state/store'

export function cleanLibraryFiles(input: unknown): LibraryFileRef[] | undefined {
  if (!Array.isArray(input)) return undefined
  const out: LibraryFileRef[] = []
  const seen = new Set<string>()
  for (const item of input) {
    if (!item || typeof item !== 'object') continue
    const row = item as { bufferId?: unknown; key?: unknown; url?: unknown }
    const bufferId = typeof row.bufferId === 'string' ? row.bufferId.trim() : ''
    const key = typeof row.key === 'string' ? row.key.trim() : ''
    if (!bufferId || !key || seen.has(bufferId)) continue
    if (row.url || /^https?:/i.test(key) || key.includes('X-Amz-') || key.includes('://')) continue
    seen.add(bufferId)
    out.push({ bufferId, key })
  }
  return out.length ? out : undefined
}

export function libraryFilesOf(project: Project) {
  return cleanLibraryFiles(project.libraryFiles) ?? []
}

/** True when the saved document keeps object keys and no expiring links. */
export function projectKeepsLibraryKeys(project: Project) {
  const json = JSON.stringify(project.libraryFiles ?? [])
  return !json.includes('X-Amz-') && !json.includes('r2.cloudflarestorage.com') && !json.includes('://')
}

/**
 * Fill buffers that point at the private library.
 * Cached audio plays with no network. A miss asks for a new signature.
 * Saved projects never store those signatures.
 */
export async function restoreLibraryFiles(store: ProjectStore, fetchImpl: typeof fetch = fetch) {
  const missing = libraryFilesOf(store.project).filter((item) => !store.buffers.has(item.bufferId))
  if (!missing.length) return
  const cache = libraryAudioCache()
  for (const item of missing) {
    if (store.buffers.has(item.bufferId)) continue
    try {
      const cached = await cache.get(item.key).catch(() => null)
      const bytes = cached ?? (readLibraryAccessKey() ? await fetchLibraryBytes(item.key, fetchImpl, cache) : null)
      if (!bytes) continue
      const decoded = await decodeSlotFile(bytes)
      const lead = decoded.channels[0]
      if (!lead?.length || store.buffers.has(item.bufferId)) continue
      const name = item.key.split('/').pop() || 'Library sound'
      store.addAsset({ id: item.bufferId, name, sampleRate: decoded.sampleRate, channels: decoded.channels })
    } catch {
      /* the rest of the project still opens */
    }
  }
}

export function watchLibraryProject(store: ProjectStore, fetchImpl: typeof fetch = fetch) {
  let busy = false
  const failed = new Set<string>()
  const run = () => {
    if (busy) return
    const todo = libraryFilesOf(store.project).filter((item) => !store.buffers.has(item.bufferId) && !failed.has(item.bufferId))
    if (!todo.length) return
    busy = true
    void restoreLibraryFiles(store, fetchImpl).catch(() => undefined).finally(() => {
      for (const item of todo) if (!store.buffers.has(item.bufferId)) failed.add(item.bufferId)
      busy = false
    })
  }
  const onUnlock = () => {
    failed.clear()
    run()
  }
  const stop = store.subscribe(run)
  if (typeof document !== 'undefined') document.addEventListener(LIBRARY_UNLOCKED, onUnlock)
  run()
  return () => {
    stop()
    if (typeof document !== 'undefined') document.removeEventListener(LIBRARY_UNLOCKED, onUnlock)
  }
}

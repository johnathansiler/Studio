export const LIBRARY_ACCESS_STORAGE = 'cueharbor-library-access'
export const LIBRARY_UNLOCKED = 'cueharbor-library-unlocked'
export const LIBRARY_NOT_READY = 'My Library is not set up on this server.'

const memory: { key: string } = { key: '' }

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function readLibraryAccessKey() {
  if (memory.key) return memory.key
  const saved = storage()?.getItem(LIBRARY_ACCESS_STORAGE) ?? ''
  memory.key = saved
  return saved
}

export function writeLibraryAccessKey(key: string) {
  memory.key = key
  try { storage()?.setItem(LIBRARY_ACCESS_STORAGE, key) } catch { /* the session still holds it */ }
  if (typeof document !== 'undefined') document.dispatchEvent(new Event(LIBRARY_UNLOCKED))
}

export function clearLibraryAccessKey() {
  memory.key = ''
  try { storage()?.removeItem(LIBRARY_ACCESS_STORAGE) } catch { /* already gone */ }
}

export class LibraryAuthError extends Error {
  constructor(message = 'That passphrase does not unlock the library.') {
    super(message)
    this.name = 'LibraryAuthError'
  }
}

export async function libraryStatus(fetchImpl: typeof fetch = fetch): Promise<{ ready: boolean; message: string }> {
  try {
    const response = await fetchImpl('/api/library')
    const body = await response.json().catch(() => null) as { ready?: boolean; message?: string } | null
    if (body?.ready === true) return { ready: true, message: '' }
    return { ready: false, message: body?.message || LIBRARY_NOT_READY }
  } catch {
    return { ready: false, message: LIBRARY_NOT_READY }
  }
}

export interface SignedLibraryUrl {
  key: string
  url: string
}

/** Ask the server for short-lived GET links. The passphrase stays on this device. */
export async function signLibraryKeys(keys: string[], accessKey: string, fetchImpl: typeof fetch = fetch): Promise<{ expiresIn: number; urls: SignedLibraryUrl[] }> {
  const response = await fetchImpl('/api/library/sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-library-key': accessKey },
    body: JSON.stringify({ keys }),
  })
  const body = await response.json().catch(() => null) as { error?: string; expiresIn?: number; urls?: SignedLibraryUrl[] } | null
  if (response.status === 401) {
    clearLibraryAccessKey()
    throw new LibraryAuthError(body?.error || 'That passphrase does not unlock the library.')
  }
  if (response.status === 429) throw new Error(body?.error || 'Too many library requests. Wait a minute and try again.')
  if (!response.ok || !Array.isArray(body?.urls)) throw new Error(body?.error || LIBRARY_NOT_READY)
  return { expiresIn: body.expiresIn || 900, urls: body.urls.filter((item) => item && typeof item.key === 'string' && typeof item.url === 'string' && !item.url.includes(accessKey)) }
}

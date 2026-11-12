/**
 * Private-library samples are named `library-key:<instrument>:<object key>`.
 * The bytes come from a short-lived R2 link. The app host never streams the audio.
 */

const PREFIX = 'library-key:'

export function librarySampleUrl(instrumentId: string, objectKey: string) {
  return `${PREFIX}${instrumentId}:${encodeURIComponent(objectKey)}`
}

export function parseLibrarySampleUrl(url: string): { id: string; key: string } | null {
  if (!url.startsWith(PREFIX)) return null
  const rest = url.slice(PREFIX.length)
  const split = rest.indexOf(':')
  if (split < 1) return null
  try {
    return { id: rest.slice(0, split), key: decodeURIComponent(rest.slice(split + 1)) }
  } catch {
    return null
  }
}

type Loader = (instrumentId: string, objectKey: string) => Promise<ArrayBuffer>

let loader: Loader | null = null

export function setLibrarySampleLoader(next: Loader | null) {
  loader = next
}

export function loadLibrarySampleBytes(url: string) {
  const parsed = parseLibrarySampleUrl(url)
  if (!parsed || !loader) return Promise.reject(new Error('Unlock My Library on this device first.'))
  return loader(parsed.id, parsed.key)
}

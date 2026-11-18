import { SOUND_DATASET_BASE, SOUND_DATASET_COMMIT } from './contract'

const PREFIX = `${SOUND_DATASET_BASE}/`

/**
 * The dataset `resolve/` URL 307s to this host, then the file redirects again.
 * Asking the resolve cache directly skips that first round trip.
 * The path is still the pinned commit. Nothing is uploaded.
 */
export function directDatasetUrl(url: string) {
  if (!url.startsWith(PREFIX)) return url
  const rest = url.slice(PREFIX.length)
  let path = rest
  try {
    path = rest.split('/').map((part) => decodeURIComponent(part)).join('/')
  } catch {
    path = rest
  }
  return `https://huggingface.co/api/resolve-cache/datasets/cueharbor/sound-library/${SOUND_DATASET_COMMIT}/${encodeURIComponent(path)}`
}

/** Browser fetch for library URLs. Tests pass their own fetch and keep the canonical URL. */
export function libraryFetch(input: string, init?: RequestInit) {
  return fetch(directDatasetUrl(input), init)
}

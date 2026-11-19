/** Stable cache key for a private-library object. The signed GET link is never stored. */
export const LIBRARY_OBJECT_PREFIX = 'https://cueharbor.local/library-object/'

export function libraryObjectUrl(key: string) {
  return `${LIBRARY_OBJECT_PREFIX}${encodeURIComponent(key)}`
}

export function libraryObjectKeyFromUrl(url: string) {
  if (!url.startsWith(LIBRARY_OBJECT_PREFIX)) return ''
  try {
    return decodeURIComponent(url.slice(LIBRARY_OBJECT_PREFIX.length))
  } catch {
    return ''
  }
}

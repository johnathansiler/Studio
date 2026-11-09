import { assertHuggingFaceUrl, libraryFileUrl } from '../audio/multisample/source'
import { LEGACY_ROOT, SOUND_CATALOG_URL, SOUND_DATASET_BASE, SOUND_VERSION_PREFIX } from './contract'

const DATASET_PREFIX = `${SOUND_DATASET_BASE}/`

function relativeLibraryPath(path: string) {
  const clean = path.trim().replace(/\\/g, '/')
  if (!clean || clean.includes('..') || clean.startsWith('/') || /^https?:/i.test(clean) || clean.includes('://')) return ''
  return clean.replace(/^\/+/, '')
}

/** Active SoundScout audio. Legacy root paths are rejected here. */
export function soundFileUrl(path: string) {
  const clean = relativeLibraryPath(path)
  if (!clean || !clean.startsWith(SOUND_VERSION_PREFIX)) {
    throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
  }
  const url = libraryFileUrl(SOUND_DATASET_BASE, clean)
  assertSoundUrl(url)
  return url
}

/**
 * A path already stored from the previous library root.
 * Browse and defaults do not call this.
 */
export function legacySoundFileUrl(path: string) {
  const clean = relativeLibraryPath(path)
  if (!clean || clean.startsWith(SOUND_VERSION_PREFIX) || !LEGACY_ROOT.test(clean)) {
    throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
  }
  const url = libraryFileUrl(SOUND_DATASET_BASE, clean)
  assertSoundUrl(url)
  return url
}

/** The versioned catalog document. This is not the legacy index.json. */
export function soundCatalogUrl() {
  return SOUND_CATALOG_URL
}

/** Hugging Face dataset files only: the versioned tree, or a legacy root path. */
export function assertSoundUrl(url: string) {
  assertHuggingFaceUrl(url)
  if (!url.startsWith(DATASET_PREFIX)) throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
  const rest = decodeURIComponent(url.slice(DATASET_PREFIX.length))
  if (rest.startsWith(SOUND_VERSION_PREFIX) || LEGACY_ROOT.test(rest)) return
  throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
}

import { assertHuggingFaceUrl, libraryFileUrl } from '../audio/multisample/source'

/** Files are fetched from this dataset. Nothing is proxied through Render or Cloudflare. */
export const SOUND_LIBRARY_BASE = 'https://huggingface.co/datasets/cueharbor/sound-library/resolve/main'

const BASE_PREFIX = `${SOUND_LIBRARY_BASE}/`

export function soundFileUrl(path: string) {
  const clean = path.trim()
  if (!clean || /^https?:/i.test(clean) || clean.includes('://')) {
    throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
  }
  const url = libraryFileUrl(SOUND_LIBRARY_BASE, clean)
  assertSoundUrl(url)
  return url
}

/** Refuse any host other than this dataset, including the app server. */
export function assertSoundUrl(url: string) {
  assertHuggingFaceUrl(url)
  if (!url.startsWith(BASE_PREFIX)) throw new Error('Sounds load from the CueHarbor library on Hugging Face only')
}

export function soundIndexUrl() {
  return soundFileUrl('index.json')
}

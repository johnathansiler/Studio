/** Starter instruments resolve from a Hugging Face dataset. No repo is required for the app to build. */
export const DEFAULT_LIBRARY_BASE = 'https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main'

let baseUrl = DEFAULT_LIBRARY_BASE

export function libraryBaseUrl() {
  return baseUrl
}

export function setLibraryBaseUrl(url: string) {
  const trimmed = url.trim().replace(/\/$/, '')
  assertHuggingFaceUrl(`${trimmed}/catalog.json`)
  baseUrl = trimmed
}

export function libraryFileUrl(base: string, path: string) {
  const root = base.trim().replace(/\/$/, '')
  const clean = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  const url = new URL(clean, `${root}/`).toString()
  assertHuggingFaceUrl(url)
  return url
}

/** Sample and instrument files are fetched from Hugging Face, never the app host. */
export function assertHuggingFaceUrl(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Library files must be Hugging Face URLs')
  }
  if (parsed.protocol !== 'https:') throw new Error('Library files must use HTTPS')
  const host = parsed.hostname.toLowerCase()
  const huggingface = host === 'huggingface.co' || host.endsWith('.huggingface.co')
  if (!huggingface || host.endsWith('.onrender.com') || host === 'render.com' || host.endsWith('.cloudflare.com') || host === 'cloudflare.com') {
    throw new Error('Sample libraries load from Hugging Face only')
  }
}

export function resolveSampleUrl(presetUrl: string, samplePath: string) {
  assertHuggingFaceUrl(presetUrl)
  if (/^https:\/\//i.test(samplePath)) {
    assertHuggingFaceUrl(samplePath)
    return samplePath
  }
  const root = presetUrl.replace(/[^/]*$/, '')
  const clean = samplePath.replace(/\\/g, '/').replace(/^\.\//, '')
  const url = new URL(clean, root).toString()
  assertHuggingFaceUrl(url)
  return url
}

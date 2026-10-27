/** Where library files may live. Call relays are not library files. */

export const HOST_PART_LIMIT = 2 * 1024 * 1024 * 1024 - 1024 * 1024
export const APP_SHELL_BUDGET = 1_500_000

const LIBRARY_EXT = /\.(opus|flac|wav|aiff|aif|ogg|mp3|sfz|sf2|sf3|dspreset|onnx|safetensors|pt|npy|nki|bin|wasm)(?:$|[?#])/i
const LIBRARY_PATH = /\/(samples?|library|models?|weights|irs?|onnx|sounds)\//i
const FORBIDDEN_HOST = /(^|\.)(onrender\.com|render\.com|cloudflare\.com|cloudflarestorage\.com|cloudflarer2\.com|r2\.dev|workers\.dev)$/i
const ALLOWED_HOST = /^https:\/\/(github\.com\/|objects\.githubusercontent\.com\/|release-assets\.githubusercontent\.com\/|huggingface\.co\/|cdn-lfs[a-z0-9.-]*\.huggingface\.co\/)/i

export function storageBudget(form: 'phone' | 'fold' | 'desk') {
  if (form === 'phone') return 256 * 1024 * 1024
  if (form === 'fold') return 512 * 1024 * 1024
  return 1024 * 1024 * 1024
}

/** Block once the file would pass the device budget. Warn once it would pass 80%. */
export function planStore(used: number, incoming: number, budget: number): 'ok' | 'warn' | 'block' {
  if (incoming < 0 || used < 0) return 'block'
  if (incoming > budget || used + incoming > budget) return 'block'
  if (used + incoming > budget * 0.8) return 'warn'
  return 'ok'
}

export function partCount(bytes: number, limit = HOST_PART_LIMIT) {
  if (bytes <= 0) return 1
  return Math.max(1, Math.ceil(bytes / limit))
}

export function forbiddenLibraryHost(url: string) {
  try {
    return FORBIDDEN_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

export function allowedLibraryHost(url: string) {
  return ALLOWED_HOST.test(url) && !forbiddenLibraryHost(url)
}

export function isLibraryAssetUrl(url: string) {
  return LIBRARY_EXT.test(url) || LIBRARY_PATH.test(url)
}

export function libraryViolations(text: string) {
  const found: string[] = []
  for (const match of text.match(/https?:\/\/[^\s"'`)<>]+/g) ?? []) {
    const url = match.replace(/[),.;]+$/, '')
    if (isLibraryAssetUrl(url) && forbiddenLibraryHost(url)) found.push(url)
  }
  return found
}

export function isBlockedStatic(pathname: string) {
  const path = pathname.replace(/^\/+/, '')
  if (path === 'ort' || path.startsWith('ort/')) return true
  return LIBRARY_EXT.test(path)
}

export function touchLru(map: Record<string, number>, id: string, at: number) {
  return { ...map, [id]: at }
}

export function oldestId(map: Record<string, number>, ids: string[]) {
  let oldest = ''
  let at = Number.POSITIVE_INFINITY
  for (const id of ids) {
    const used = map[id] ?? 0
    if (!oldest || used < at) {
      oldest = id
      at = used
    }
  }
  return oldest || null
}

export async function downloadParts(urls: string[], fetchImpl: typeof fetch) {
  const chunks: Uint8Array[] = []
  for (const url of urls) {
    if (!allowedLibraryHost(url) || forbiddenLibraryHost(url)) throw new Error('refused')
    const response = await fetchImpl(url, { cache: 'force-cache' })
    if (!response.ok) throw new Error('download')
    chunks.push(new Uint8Array(await response.arrayBuffer()))
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

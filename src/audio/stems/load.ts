import { modelFor, type StemMode } from './engine'

const CACHE = 'cueharbor-stems-v1'

async function readCache(url: string): Promise<ArrayBuffer | null> {
  try {
    const cache = await caches.open(CACHE)
    const hit = await cache.match(url)
    if (!hit) return null
    return await hit.arrayBuffer()
  } catch {
    return null
  }
}

async function writeCache(url: string, bytes: ArrayBuffer) {
  try {
    const cache = await caches.open(CACHE)
    await cache.put(url, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } }))
  } catch {
    /* a private window may refuse Cache Storage; OPFS is the other copy */
  }
}

async function readOpfs(file: string): Promise<ArrayBuffer | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(file)
    return await (await handle.getFile()).arrayBuffer()
  } catch {
    return null
  }
}

async function writeOpfs(file: string, bytes: ArrayBuffer) {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(file, { create: true })
    const writable = await handle.createWritable()
    await writable.write(bytes)
    await writable.close()
  } catch {
    /* Cache Storage still holds the weights */
  }
}

/** Lazy weight download straight from Hugging Face. Not proxied through the app or the SFU. */
export async function loadWeights(mode: StemMode, onProgress: (received: number, total: number) => void): Promise<ArrayBuffer> {
  const model = modelFor(mode)
  const cached = await readCache(model.url)
  if (cached) {
    onProgress(cached.byteLength, cached.byteLength)
    return cached
  }
  const stored = await readOpfs(model.file)
  if (stored) {
    onProgress(stored.byteLength, stored.byteLength)
    await writeCache(model.url, stored)
    return stored
  }
  const response = await fetch(model.url)
  if (!response.ok || !response.body) throw new Error('Model download failed')
  const total = Number(response.headers.get('content-length')) || model.bytes
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    parts.push(value)
    received += value.byteLength
    onProgress(received, total)
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  const buffer = bytes.buffer
  await writeCache(model.url, buffer)
  await writeOpfs(model.file, buffer)
  return buffer
}

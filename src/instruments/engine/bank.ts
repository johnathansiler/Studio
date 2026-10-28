import type { SampleMeta } from './types'

/** One disk page. The bank keeps the first page hot and reads later pages when a voice reaches them. */
export const CHUNK_FRAMES = 8192

export interface DiskSample {
  id: string
  sampleRate: number
  channels: Float32Array[]
}

export interface DiskStore {
  put(sample: DiskSample): Promise<void>
  meta(id: string): Promise<SampleMeta | null>
  chunk(id: string, index: number): Promise<Float32Array[] | null>
  has(id: string): Promise<boolean>
}

export interface MemoryDisk extends DiskStore {
  reads: number
  puts: number
}

function split(sample: DiskSample, chunkFrames: number) {
  const frames = sample.channels[0]?.length ?? 0
  const channels = Math.max(1, sample.channels.length)
  const chunks = new Map<number, Float32Array[]>()
  const count = Math.max(1, Math.ceil(frames / chunkFrames))
  for (let index = 0; index < count; index++) {
    const start = index * chunkFrames
    const end = Math.min(frames, start + chunkFrames)
    const page: Float32Array[] = []
    for (let channel = 0; channel < channels; channel++) {
      const source = sample.channels[channel] ?? sample.channels[0]
      page.push(source ? source.slice(start, end) : new Float32Array(Math.max(0, end - start)))
    }
    chunks.set(index, page)
  }
  const meta: SampleMeta = { id: sample.id, sampleRate: sample.sampleRate, channels, frames, chunkFrames }
  return { meta, chunks }
}

export function createMemoryDisk(chunkFrames = CHUNK_FRAMES): MemoryDisk {
  const metas = new Map<string, SampleMeta>()
  const pages = new Map<string, Map<number, Float32Array[]>>()
  const disk: MemoryDisk = {
    reads: 0,
    puts: 0,
    async has(id) {
      return metas.has(id)
    },
    async put(sample) {
      if (metas.has(sample.id)) return
      const packed = split(sample, chunkFrames)
      metas.set(sample.id, packed.meta)
      pages.set(sample.id, packed.chunks)
      disk.puts += 1
    },
    async meta(id) {
      return metas.get(id) ?? null
    },
    async chunk(id, index) {
      const page = pages.get(id)?.get(index) ?? null
      if (!page) return null
      disk.reads += 1
      return page.map((channel) => channel.slice())
    },
  }
  return disk
}

const DB_NAME = 'cueharbor-samples'
const META = 'meta'
const CHUNKS = 'chunks'

function openSampleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

/** IndexedDB pages. A refresh reads the same pages; nothing is fetched from the network. */
export function createIdbDisk(chunkFrames = CHUNK_FRAMES): DiskStore {
  let opening: Promise<IDBDatabase> | null = null
  const db = () => (opening ??= openSampleDb())
  return {
    async has(id) {
      const store = (await db()).transaction(META, 'readonly').objectStore(META)
      const found = await request(store.get(id))
      return Boolean(found)
    },
    async put(sample) {
      if (await this.has(sample.id)) return
      const packed = split(sample, chunkFrames)
      const database = await db()
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction([META, CHUNKS], 'readwrite')
        tx.objectStore(META).put(packed.meta)
        for (const [index, page] of packed.chunks) {
          const stored = page.map((channel) => channel.buffer.slice(channel.byteOffset, channel.byteOffset + channel.byteLength))
          tx.objectStore(CHUNKS).put(stored, `${sample.id}:${index}`)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    },
    async meta(id) {
      const store = (await db()).transaction(META, 'readonly').objectStore(META)
      return (await request<SampleMeta | undefined>(store.get(id))) ?? null
    },
    async chunk(id, index) {
      const store = (await db()).transaction(CHUNKS, 'readonly').objectStore(CHUNKS)
      const stored = await request<ArrayBuffer[] | undefined>(store.get(`${id}:${index}`))
      if (!stored) return null
      return stored.map((buffer) => new Float32Array(buffer.slice(0)))
    },
  }
}

export function createDefaultDisk(): DiskStore {
  if (typeof indexedDB === 'undefined') return createMemoryDisk()
  return createIdbDisk()
}

export interface SampleBank {
  store(sample: DiskSample): Promise<void>
  has(id: string): Promise<boolean>
  /** Load the first page into memory. */
  open(id: string): Promise<SampleMeta | null>
  info(id: string): SampleMeta | null
  /**
   * Synchronous read of frames that are already in memory.
   * Returns null when a page in the range still has to be fetched.
   * Frames past the end are zeros, not a miss.
   */
  read(id: string, start: number, frames: number): Float32Array[] | null
  prefetch(id: string, start: number, frames: number): Promise<void>
}

interface Resident {
  meta: SampleMeta
  chunks: Map<number, Float32Array[]>
}

export function createStreamBank(disk: DiskStore): SampleBank {
  const resident = new Map<string, Resident>()
  const remember = (meta: SampleMeta) => {
    const found = resident.get(meta.id)
    if (found) return found
    const created: Resident = { meta, chunks: new Map() }
    resident.set(meta.id, created)
    return created
  }
  return {
    async store(sample) {
      await disk.put(sample)
    },
    has(id) {
      return disk.has(id)
    },
    info(id) {
      return resident.get(id)?.meta ?? null
    },
    async open(id) {
      const meta = (await disk.meta(id)) ?? resident.get(id)?.meta ?? null
      if (!meta) return null
      const slot = remember(meta)
      if (!slot.chunks.has(0) && meta.frames > 0) {
        const page = await disk.chunk(id, 0)
        if (page) slot.chunks.set(0, page)
      }
      return meta
    },
    read(id, start, frames) {
      const slot = resident.get(id)
      if (!slot || frames <= 0) return null
      const from = Math.max(0, Math.floor(start))
      const lastFrame = Math.min(slot.meta.frames, Math.floor(start + frames)) - 1
      if (slot.meta.frames > 0 && lastFrame >= from) {
        const first = Math.floor(from / slot.meta.chunkFrames)
        const last = Math.floor(lastFrame / slot.meta.chunkFrames)
        for (let index = first; index <= last; index++) if (!slot.chunks.has(index)) return null
      }
      const out = Array.from({ length: slot.meta.channels }, () => new Float32Array(frames))
      for (let i = 0; i < frames; i++) {
        const frame = Math.floor(start) + i
        if (frame < 0 || frame >= slot.meta.frames) continue
        const index = Math.floor(frame / slot.meta.chunkFrames)
        const page = slot.chunks.get(index)
        if (!page) return null
        const at = frame - index * slot.meta.chunkFrames
        for (let channel = 0; channel < page.length; channel++) out[channel][i] = page[channel][at] || 0
      }
      return out
    },
    async prefetch(id, start, frames) {
      const meta = (await disk.meta(id)) ?? resident.get(id)?.meta ?? null
      if (!meta || meta.frames <= 0) return
      const slot = remember(meta)
      const from = Math.max(0, Math.floor(start))
      const to = Math.min(meta.frames, Math.floor(start + Math.max(0, frames)))
      const lastFrame = Math.max(from, to - 1)
      const first = Math.floor(Math.min(from, meta.frames - 1) / meta.chunkFrames)
      const last = Math.floor(Math.min(lastFrame, meta.frames - 1) / meta.chunkFrames)
      for (let index = first; index <= last; index++) {
        if (slot.chunks.has(index)) continue
        const page = await disk.chunk(id, index)
        if (page) slot.chunks.set(index, page)
      }
    },
  }
}

let shared: SampleBank | null = null

/** Process-wide bank. Browser pages use IndexedDB, so a refresh still has the samples. */
export function instrumentBank() {
  if (!shared) shared = createStreamBank(createDefaultDisk())
  return shared
}

/**
 * Private-library uploads.
 * WAV bytes are sent as they are. Nothing here resamples, dither, or re-encodes,
 * so the original bit depth stays in the file.
 * New objects live under `audio/`. The catalog JSON stays under `catalog/`.
 */
import { LibraryAuthError, clearLibraryAccessKey, signedUrlKeepsSecret } from './access.ts'

export const LIBRARY_AUDIO_PREFIX = 'audio/'
export const LIBRARY_UPLOAD_MAX_KEYS = 50
export const LIBRARY_APPEND_MAX = 500
export const LIBRARY_UPLOAD_MAX_BYTES = 60 * 1024 * 1024
/** The only Content-Type a signed upload accepts. The signature binds this value. */
export const LIBRARY_PUT_CONTENT_TYPE = 'audio/wav'

const AUDIO_KEY_HIDDEN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/
const AUDIO_KEY_ENCODED = /%(?:2e|2f|5c|00)/i

function audioSegmentOk(part: string) {
  if (!part || part === '.' || part === '..') return false
  const folded = part.normalize('NFKC')
  if (!folded || folded === '.' || folded === '..') return false
  if (folded.includes('/') || folded.includes('\\') || AUDIO_KEY_HIDDEN.test(folded)) return false
  if (AUDIO_KEY_ENCODED.test(part) || AUDIO_KEY_ENCODED.test(folded)) return false
  return true
}

export interface CatalogWireEntry {
  key: string
  size: number
  format: 'wav'
  pack: string
  type: string
  category: string
  instrument: string
  genre: string[]
  bpm: number | null
  bpm_alt: number | null
  bpm_source?: string | null
  musical_key: string | null
  root: string | null
  note: string | null
  chord: string | null
  mood: string[]
  tags: string[]
  license: string
  search: string
  sample_rate?: number
  bit_depth?: number
  channels?: number
}

export interface UploadFileBytes {
  name: string
  size: number
  bytes: ArrayBuffer
}

export interface UploadCounts {
  uploaded: number
  skipped: number
  added: number
  failed: number
}

/** A WAV object key under the audio prefix. Rejects traversal, catalog paths, encoded dots, and lookalike separators. */
export function libraryAudioKey(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const key = input.trim()
  if (!key.startsWith(LIBRARY_AUDIO_PREFIX) || key.length > 512) return null
  if (key.includes('\\') || key.includes('://') || AUDIO_KEY_HIDDEN.test(key) || AUDIO_KEY_ENCODED.test(key)) return null
  if (!key.split('/').every(audioSegmentOk)) return null
  if (!key.toLowerCase().endsWith('.wav')) return null
  const folded = key.normalize('NFKC')
  if (!folded.startsWith(LIBRARY_AUDIO_PREFIX) || !folded.toLowerCase().endsWith('.wav')) return null
  if (!folded.split('/').every(audioSegmentOk)) return null
  return key
}

export function libraryUploadSize(input: unknown): number | null {
  if (typeof input !== 'number' || !Number.isInteger(input)) return null
  if (input < 1 || input > LIBRARY_UPLOAD_MAX_BYTES) return null
  return input
}

function ascii(view: DataView, offset: number, length: number) {
  let text = ''
  for (let i = 0; i < length; i++) text += String.fromCharCode(view.getUint8(offset + i))
  return text
}

/** Header facts only. The bytes themselves are not converted. */
export function readWavFacts(bytes: ArrayBuffer): { sampleRate: number; bits: number; channels: number } | null {
  if (bytes.byteLength < 44) return null
  const view = new DataView(bytes)
  if (ascii(view, 0, 4) !== 'RIFF' || ascii(view, 8, 4) !== 'WAVE') return null
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  let format = 0
  let sawData = false
  while (offset + 8 <= bytes.byteLength) {
    const id = ascii(view, offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ' && offset + 24 <= bytes.byteLength) {
      format = view.getUint16(offset + 8, true)
      channels = view.getUint16(offset + 10, true)
      sampleRate = view.getUint32(offset + 12, true)
      bits = view.getUint16(offset + 22, true)
      if (format === 0xfffe && size >= 40 && offset + 34 <= bytes.byteLength) format = view.getUint16(offset + 32, true)
    } else if (id === 'data') {
      sawData = true
      break
    }
    const step = 8 + size + (size % 2)
    if (step <= 0) return null
    offset += step
  }
  if (!sawData) return null
  if (format !== 1 && format !== 3) return null
  if (channels < 1 || channels > 8) return null
  if (sampleRate < 1000 || sampleRate > 384000) return null
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) return null
  return { sampleRate, bits, channels }
}

/** Object key for a file the phone is adding. The category becomes one folder under `audio/`. */
export function libraryUploadObjectKey(fileName: string, category: string): string | null {
  const base = fileName.replace(/\\/g, '/').split('/').pop() ?? ''
  if (!base.toLowerCase().endsWith('.wav')) return null
  const stem = base.slice(0, -4).replace(/[^\w.\- ()#]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!stem || stem === '.' || stem === '..' || stem.includes('..')) return null
  const cat = category.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const folder = cat ? `${LIBRARY_AUDIO_PREFIX}${cat}` : `${LIBRARY_AUDIO_PREFIX}uploads`
  return libraryAudioKey(`${folder}/${stem}.wav`)
}

function textField(value: unknown, max: number, nullable: true): string | null | undefined
function textField(value: unknown, max: number, nullable: false): string | undefined
function textField(value: unknown, max: number, nullable: boolean): string | null | undefined {
  if (value === undefined) return ''
  if (value === null) return nullable ? null : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length > max) return undefined
  return text
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 24) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    const text = item.trim()
    if (!text || text.length > 80) return undefined
    out.push(text)
  }
  return out
}

function tempoField(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 400) return undefined
  return value
}

function countField(value: unknown, max: number): number | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) return undefined
  return value
}

/** Catalog row in the gzip file's snake_case shape. A wrong type rejects the row. */
export function normalizeCatalogEntry(input: unknown): CatalogWireEntry | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const raw = input as Record<string, unknown>
  const key = libraryAudioKey(raw.key)
  const size = libraryUploadSize(raw.size)
  const format = textField(raw.format, 16, false)
  if (!key || size == null || format === undefined || format.toLowerCase() !== 'wav') return null
  const pack = textField(raw.pack, 120, false)
  const type = textField(raw.type, 40, false)
  const category = textField(raw.category, 40, false)
  const instrument = textField(raw.instrument, 80, false)
  const license = textField(raw.license, 80, false)
  const genre = stringList(raw.genre)
  const mood = stringList(raw.mood)
  const tags = stringList(raw.tags)
  const bpm = tempoField(raw.bpm)
  const bpmAlt = tempoField(raw.bpm_alt)
  const musical = textField(raw.musical_key, 40, true)
  const root = textField(raw.root, 16, true)
  const note = textField(raw.note, 16, true)
  const chord = textField(raw.chord, 40, true)
  const search = textField(raw.search, 1000, false)
  const bpmSource = raw.bpm_source === undefined ? undefined : textField(raw.bpm_source, 40, true)
  const sampleRate = raw.sample_rate === undefined && raw.sampleRate === undefined ? undefined : countField(raw.sample_rate ?? raw.sampleRate, 384000)
  const bitDepth = raw.bit_depth === undefined && raw.bitDepth === undefined ? undefined : countField(raw.bit_depth ?? raw.bitDepth, 32)
  const channels = raw.channels === undefined ? undefined : countField(raw.channels, 8)
  const bitsOk = bitDepth === 8 || bitDepth === 16 || bitDepth === 24 || bitDepth === 32
  if (
    pack === undefined || type === undefined || category === undefined || instrument === undefined || license === undefined
    || genre === undefined || mood === undefined || tags === undefined
    || bpm === undefined || bpmAlt === undefined || musical === undefined || root === undefined || note === undefined || chord === undefined
    || search === undefined
    || (raw.bpm_source !== undefined && bpmSource === undefined)
    || ((raw.sample_rate !== undefined || raw.sampleRate !== undefined) && sampleRate === undefined)
    || ((raw.bit_depth !== undefined || raw.bitDepth !== undefined) && (bitDepth === undefined || !bitsOk))
    || (raw.channels !== undefined && channels === undefined)
  ) return null
  const entry: CatalogWireEntry = {
    key,
    size,
    format: 'wav',
    pack,
    type,
    category: category.toLowerCase(),
    instrument: instrument.toLowerCase(),
    genre,
    bpm,
    bpm_alt: bpmAlt,
    musical_key: musical,
    root,
    note,
    chord,
    mood,
    tags,
    license,
    search: search.toLowerCase(),
  }
  if (bpmSource !== undefined) entry.bpm_source = bpmSource
  if (sampleRate) entry.sample_rate = sampleRate
  if (bitDepth) entry.bit_depth = bitDepth
  if (channels) entry.channels = channels
  return entry
}

export function catalogEntryForUpload(input: {
  key: string
  size: number
  category: string
  bpm: number | null
  musicalKey: string
  name: string
  sampleRate?: number
  bits?: number
  channels?: number
}): CatalogWireEntry | null {
  const category = input.category.trim().toLowerCase()
  const musical = input.musicalKey.trim()
  const name = input.name.trim()
  const search = [name, category, musical, input.bpm ? String(input.bpm) : '', 'upload'].filter(Boolean).join(' ')
  return normalizeCatalogEntry({
    key: input.key,
    size: input.size,
    format: 'wav',
    pack: 'Uploads',
    type: input.bpm ? 'loop' : 'one-shot',
    category,
    instrument: category,
    genre: [],
    bpm: input.bpm,
    bpm_alt: null,
    musical_key: musical || null,
    root: null,
    note: null,
    chord: null,
    mood: [],
    tags: ['upload'],
    license: 'upload',
    search,
    sample_rate: input.sampleRate,
    bit_depth: input.bits,
    channels: input.channels,
  })
}

function entryKeyOf(item: unknown) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return ''
  const key = (item as { key?: unknown }).key
  return typeof key === 'string' ? key : ''
}

export interface CatalogMerge {
  ok: true
  changed: boolean
  document: Record<string, unknown>
  added: number
  skipped: number
}

/** Append rows. Existing rows stay, including fields this schema does not know. Same key is skipped. */
export function mergeCatalogEntries(raw: unknown, incoming: unknown[], now: number): CatalogMerge | { ok: false } {
  if (!Array.isArray(incoming) || !incoming.length || incoming.length > LIBRARY_APPEND_MAX) return { ok: false }
  const base: Record<string, unknown> = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? { ...(raw as Record<string, unknown>) }
    : { version: 0, generated_at: '', count: 0, pending: '', entries: [] as unknown[] }
  if (!Array.isArray(base.entries)) return { ok: false }
  const normalized: CatalogWireEntry[] = []
  for (const item of incoming) {
    const entry = normalizeCatalogEntry(item)
    if (!entry) return { ok: false }
    normalized.push(entry)
  }
  const existing = base.entries.slice() as unknown[]
  const seen = new Set<string>()
  for (const item of existing) {
    const key = entryKeyOf(item)
    if (key) seen.add(key)
  }
  const entries: unknown[] = existing.slice()
  let added = 0
  let skipped = 0
  for (const entry of normalized) {
    if (seen.has(entry.key)) {
      skipped += 1
      continue
    }
    seen.add(entry.key)
    entries.push(entry)
    added += 1
  }
  if (!added) {
    return { ok: true, changed: false, document: { ...base, entries }, added, skipped }
  }
  const version = typeof base.version === 'number' && Number.isFinite(base.version) ? base.version + 1 : 1
  return {
    ok: true,
    changed: true,
    added,
    skipped,
    document: {
      ...base,
      version,
      generated_at: new Date(now).toISOString(),
      count: entries.length,
      entries,
    },
  }
}

interface SignedUpload {
  key: string
  url: string
  exists?: boolean
}

async function readJson(response: Response) {
  return response.json().catch(() => null) as Promise<Record<string, unknown> | null>
}

function publicError(message: string, accessKey: string, fallback: string) {
  if (!message || (accessKey && message.includes(accessKey))) return fallback
  return message
}

async function signUploadBatch(items: { key: string; size: number }[], accessKey: string, fetchImpl: typeof fetch): Promise<SignedUpload[]> {
  const response = await fetchImpl('/api/library/upload-sign', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-library-key': accessKey },
    body: JSON.stringify({ keys: items }),
  })
  const body = await readJson(response)
  if (response.status === 401) {
    clearLibraryAccessKey()
    throw new LibraryAuthError(publicError(typeof body?.error === 'string' ? body.error : '', accessKey, 'That passphrase does not unlock the library.'))
  }
  if (!response.ok || !Array.isArray(body?.urls)) throw new Error(publicError(typeof body?.error === 'string' ? body.error : '', accessKey, 'Could not prepare the upload.'))
  return body.urls.filter((item): item is SignedUpload => {
    if (!item || typeof item !== 'object') return false
    const row = item as SignedUpload
    return typeof row.key === 'string' && typeof row.url === 'string'
  })
}

/** Presigned upload targets stay off the public Hugging Face hosts. */
export function privateUploadUrl(url: string, accessKey: string) {
  if (!signedUrlKeepsSecret(url, accessKey)) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'huggingface.co' || host.endsWith('.huggingface.co') || host === 'hf.co' || host.endsWith('.hf.co')) return false
    return true
  } catch {
    return false
  }
}

async function putWav(url: string, bytes: ArrayBuffer, fetchImpl: typeof fetch) {
  const response = await fetchImpl(url, {
    method: 'PUT',
    redirect: 'error',
    headers: { 'content-type': LIBRARY_PUT_CONTENT_TYPE, 'if-none-match': '*' },
    body: bytes,
  })
  return response.ok
}

/**
 * Upload original WAV bytes, then append their catalog rows.
 * A file that is already in the bucket is skipped. Failed files are left out of the catalog.
 */
export async function uploadLibraryWavs(input: {
  files: UploadFileBytes[]
  category: string
  bpm: number | null
  musicalKey: string
  accessKey: string
  fetchImpl?: typeof fetch
}): Promise<UploadCounts> {
  const fetchImpl = input.fetchImpl ?? fetch
  const counts: UploadCounts = { uploaded: 0, skipped: 0, added: 0, failed: 0 }
  const used = new Set<string>()
  const ready: { key: string; size: number; bytes: ArrayBuffer; entry: CatalogWireEntry }[] = []
  for (const file of input.files) {
    if (!file.name.toLowerCase().endsWith('.wav') || file.size !== file.bytes.byteLength || !libraryUploadSize(file.size)) {
      counts.failed += 1
      continue
    }
    const facts = readWavFacts(file.bytes)
    let key = libraryUploadObjectKey(file.name, input.category)
    if (!facts || !key) {
      counts.failed += 1
      continue
    }
    if (used.has(key)) {
      const dot = key.lastIndexOf('.')
      let next: string | null = null
      for (let n = 2; n < 50; n++) {
        const candidate = libraryAudioKey(`${key.slice(0, dot)}-${n}${key.slice(dot)}`)
        if (candidate && !used.has(candidate)) {
          next = candidate
          break
        }
      }
      key = next
    }
    if (!key) {
      counts.failed += 1
      continue
    }
    const entry = catalogEntryForUpload({
      key,
      size: file.size,
      category: input.category,
      bpm: input.bpm,
      musicalKey: input.musicalKey,
      name: file.name.replace(/\.wav$/i, ''),
      sampleRate: facts.sampleRate,
      bits: facts.bits,
      channels: facts.channels,
    })
    if (!entry) {
      counts.failed += 1
      continue
    }
    used.add(key)
    ready.push({ key, size: file.size, bytes: file.bytes, entry })
  }
  const appended: CatalogWireEntry[] = []
  for (let offset = 0; offset < ready.length; offset += LIBRARY_UPLOAD_MAX_KEYS) {
    const batch = ready.slice(offset, offset + LIBRARY_UPLOAD_MAX_KEYS)
    const signed = await signUploadBatch(batch.map((item) => ({ key: item.key, size: item.size })), input.accessKey, fetchImpl)
    const byKey = new Map(signed.map((item) => [item.key, item]))
    for (const item of batch) {
      const link = byKey.get(item.key)
      if (!link) {
        counts.failed += 1
        continue
      }
      if (link.exists) {
        counts.skipped += 1
        appended.push(item.entry)
        continue
      }
      if (!privateUploadUrl(link.url, input.accessKey)) {
        counts.failed += 1
        continue
      }
      const stored = await putWav(link.url, item.bytes, fetchImpl)
      if (!stored) {
        counts.failed += 1
        continue
      }
      counts.uploaded += 1
      appended.push(item.entry)
    }
  }
  if (!appended.length) return counts
  const response = await fetchImpl('/api/library/catalog-append', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-library-key': input.accessKey },
    body: JSON.stringify({ entries: appended }),
  })
  const body = await readJson(response)
  if (response.status === 401) {
    clearLibraryAccessKey()
    throw new LibraryAuthError(publicError(typeof body?.error === 'string' ? body.error : '', input.accessKey, 'That passphrase does not unlock the library.'))
  }
  if (!response.ok) throw new Error(publicError(typeof body?.error === 'string' ? body.error : '', input.accessKey, 'Could not update the library catalog.'))
  counts.added = typeof body?.added === 'number' ? body.added : appended.length
  return counts
}

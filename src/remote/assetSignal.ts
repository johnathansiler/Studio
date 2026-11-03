/**
 * The catalog a peer may announce over signaling.
 * Ids, sizes, and checksums only. Any audio field rejects the message.
 * This file stays free of other imports so the signaling process can load it.
 */

export const ASSET_CHUNK_BYTES = 16 * 1024
export const ASSET_SIGNAL_LIMIT = 12_000
export const ASSET_ID = /^[A-Za-z0-9_-]{1,80}$/
export const ASSET_HASH = /^[a-f0-9]{64}$/
const FORBIDDEN_KEY = new Set(['wav', 'chunk', 'channels', 'samples', 'pcm', 'audio', 'buffer', 'blob', 'base64'])
const CODECS = new Set<AssetCodec>(['wav', 'opus', 'mp3'])

export type AssetCodec = 'wav' | 'opus' | 'mp3'

export interface AssetOffer {
  id: string
  name: string
  sampleRate: number
  bytes: number
  sha256: string
  total: number
  /** Absent on a full-quality wav. Opus or MP3 is the relay copy. */
  codec?: AssetCodec
  /** Bits per second of a compressed copy. Always 128000–160000. */
  bitrate?: number
  /** SHA-256 of the wav this compressed copy can be replaced by. */
  upgrade?: string
}

export function sanitizeOffer(value: unknown): AssetOffer | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id : ''
  const name = String(row.name || 'Audio').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Audio'
  const sampleRate = Number(row.sampleRate)
  const bytes = Number(row.bytes)
  const sha256 = typeof row.sha256 === 'string' ? row.sha256 : ''
  const total = Number(row.total)
  if (!ASSET_ID.test(id) || !ASSET_HASH.test(sha256)) return null
  if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 192000) return null
  if (!Number.isInteger(bytes) || bytes < 44 || bytes > 64 * 1024 * 1024) return null
  if (!Number.isInteger(total) || total < 1 || total > 4096) return null
  if (total !== Math.ceil(bytes / ASSET_CHUNK_BYTES)) return null
  let codec: AssetCodec | undefined
  if (row.codec != null && row.codec !== '') {
    const name = String(row.codec)
    if (!CODECS.has(name as AssetCodec)) return null
    codec = name as AssetCodec
  }
  let bitrate: number | undefined
  if (row.bitrate != null && row.bitrate !== '') {
    bitrate = Number(row.bitrate)
    if (!Number.isInteger(bitrate) || bitrate < 128_000 || bitrate > 160_000) return null
  }
  let upgrade: string | undefined
  if (row.upgrade != null && row.upgrade !== '') {
    upgrade = String(row.upgrade)
    if (!ASSET_HASH.test(upgrade)) return null
  }
  if ((codec === 'opus' || codec === 'mp3') && bitrate == null) return null
  if ((!codec || codec === 'wav') && bitrate != null) return null
  return {
    id,
    name,
    sampleRate,
    bytes,
    sha256,
    total,
    ...(codec && codec !== 'wav' ? { codec } : {}),
    ...(bitrate ? { bitrate } : {}),
    ...(upgrade ? { upgrade } : {}),
  }
}

function signalTooBig(value: unknown, depth: number): boolean {
  if (depth > 5 || value == null) return false
  if (typeof value === 'string') return value.length > 256
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) {
    if (value.length > 48) return true
    return value.some((item) => signalTooBig(item, depth + 1))
  }
  const keys = Object.keys(value as object)
  if (keys.length > 12) return true
  return keys.some((key) => FORBIDDEN_KEY.has(key) || signalTooBig((value as Record<string, unknown>)[key], depth + 1))
}

/** Catalog only. A wav, chunk, or other audio field rejects the whole message. */
export function offersFromSignal(message: unknown): AssetOffer[] | null {
  if (!message || typeof message !== 'object' || signalTooBig(message, 0)) return null
  const assets = (message as { assets?: unknown }).assets
  if (!Array.isArray(assets) || assets.length > 32) return null
  const offers: AssetOffer[] = []
  for (const item of assets) {
    const offer = sanitizeOffer(item)
    if (!offer) return null
    offers.push(offer)
  }
  if (JSON.stringify(offers).length > ASSET_SIGNAL_LIMIT) return null
  return offers
}

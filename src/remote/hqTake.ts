/**
 * Full-quality guest takes.
 * The live path is the low-bitrate stream the host hears while recording.
 * The printed take is the guest's local mic, sent after the punch-out.
 * A direct data channel is preferred. Bytes that actually ride a Cloudflare
 * relay are added to the existing usage meter. This module does not choose
 * or change the monthly cap.
 */

export const TAKE_CHUNK_BYTES = 16 * 1024

export interface RelayPair {
  selected: boolean
  candidateType?: string
  bytesSent?: number
  bytesReceived?: number
}

export type TakePath = 'data' | 'server'

/** The ordered data channel when it is open. The server path is only the fallback. */
export function chooseTakePath(channelOpen: boolean): TakePath {
  return channelOpen ? 'data' : 'server'
}

/**
 * Clock offset for alignment. The data-channel sample wins when it exists.
 * The signaling-socket sample is used when the SFU is carrying media and the
 * data channel has not produced a sample yet.
 */
export function clockOffsetForTake(linkOffset: number | null | undefined, signaledOffset: number | null | undefined): number | null {
  if (typeof linkOffset === 'number' && Number.isFinite(linkOffset)) return linkOffset
  if (typeof signaledOffset === 'number' && Number.isFinite(signaledOffset)) return signaledOffset
  return null
}

export function chunkBytes(bytes: Uint8Array, size = TAKE_CHUNK_BYTES): Uint8Array[] {
  if (size < 1) throw new Error('Take chunk size must be positive')
  if (!bytes.byteLength) return [new Uint8Array()]
  const out: Uint8Array[] = []
  for (let index = 0; index < bytes.byteLength; index += size) out.push(bytes.subarray(index, index + size))
  return out
}

/** A standalone ArrayBuffer. DataChannel.send and the wav decoder both want one. */
export function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

/** 8-byte header (index, total) plus the wav slice. The buffer is exactly that length. */
export function packTakeChunk(index: number, total: number, slice: Uint8Array): Uint8Array {
  const packet = new Uint8Array(8 + slice.byteLength)
  const view = new DataView(packet.buffer)
  view.setUint32(0, index)
  view.setUint32(4, total)
  packet.set(slice, 8)
  return packet
}

export function readTakeChunk(packet: ArrayBuffer): { index: number; total: number; bytes: Uint8Array } | null {
  if (packet.byteLength < 8) return null
  const view = new DataView(packet)
  const index = view.getUint32(0)
  const total = view.getUint32(4)
  if (!Number.isInteger(total) || total < 1 || index < 0 || index >= total) return null
  return { index, total, bytes: new Uint8Array(packet.slice(8)) }
}

/** Null when any chunk is missing, so a hole never becomes a short wav. */
export function assembleTakeWav(parts: Array<Uint8Array | undefined>, total: number): Uint8Array | null {
  if (!Number.isInteger(total) || total < 1) return null
  let size = 0
  for (let index = 0; index < total; index++) {
    const part = parts[index]
    if (!part) return null
    size += part.byteLength
  }
  const wav = new Uint8Array(size)
  let offset = 0
  for (let index = 0; index < total; index++) {
    const part = parts[index]!
    wav.set(part, offset)
    offset += part.byteLength
  }
  return wav
}

export function takeProgress(done: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, done / total))
}

/** Selected relay pairs only. A direct pair, or a pair that was not chosen, adds nothing. */
export function relayPairBytes(pair: RelayPair): number {
  if (!pair.selected || pair.candidateType !== 'relay') return 0
  const sent = Number(pair.bytesSent)
  const received = Number(pair.bytesReceived)
  return Math.max(0, Number.isFinite(sent) ? sent : 0) + Math.max(0, Number.isFinite(received) ? received : 0)
}

export function sumRelayBytes(pairs: RelayPair[]): number {
  return pairs.reduce((sum, pair) => sum + relayPairBytes(pair), 0)
}

/**
 * Bytes to add for this take on top of media that is already in the meter.
 * The Render HTTP fallback is not Cloudflare egress, so it adds nothing.
 * A data channel adds only the relay-pair totals (already cumulative stats).
 */
export function takeRelayCredit(path: TakePath, pairs: RelayPair[]): number {
  if (path !== 'data') return 0
  return sumRelayBytes(pairs)
}

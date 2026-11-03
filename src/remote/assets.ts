/**
 * Shared takes and arrangement audio.
 * A direct pair carries a lossless wav. A relay pair carries high-quality
 * compressed audio on the same data channel, and the wav replaces it if a
 * direct link appears later. The signaling server may forward the short catalog
 * below. It never receives the audio, and this module does not read or change
 * the monthly relay cap.
 */

import { decodeWavPCM, encodeWav } from '../model/wav'
import type { AudioAsset } from '../model/types'
import {
  assembleTakeWav,
  bytesToArrayBuffer,
  chunkBytes,
  packTakeChunk,
  readTakeChunk,
  sumRelayBytes,
  takeProgress,
  type RelayPair,
} from './hqTake'
import { ASSET_CHUNK_BYTES, ASSET_HASH, ASSET_ID, offersFromSignal, sanitizeOffer, type AssetOffer } from './assetSignal'
import { browserTakeCodec, type TakeAudioCodec } from './takeCodec'

export { ASSET_CHUNK_BYTES, offersFromSignal, sanitizeOffer }
export type { AssetOffer }

/** How many slices one turn may hand to the data channel. */
export const ASSET_CHUNKS_PER_TURN = 8

export type AssetPath = 'direct' | 'relay' | 'closed' | 'unknown'

export type AssetDelivery = 'wav' | 'compressed' | 'none'

export type AssetPhase = 'queued' | 'receiving' | 'sending' | 'verifying' | 'saved' | 'waiting' | 'failed'

export interface AssetStatus {
  id: string
  name: string
  phase: AssetPhase
  progress: number
  /** Short text shown beside the asset name. */
  label: string
}

export interface AssetControlCatalog { t: 'catalog'; assets: AssetOffer[] }
export interface AssetControlWant { t: 'want'; id: string; sha256: string; have: number[] }
export interface AssetControlBegin { t: 'begin'; offer: AssetOffer; send: number[] }
export interface AssetControlMiss { t: 'miss'; id: string }
export interface AssetControlWait { t: 'wait'; id: string }
export type AssetControl = AssetControlCatalog | AssetControlWant | AssetControlBegin | AssetControlMiss | AssetControlWait

export interface AssetAction {
  peerId: string
  assetId?: string
  text?: string
  binary?: Uint8Array
  /** Wav on a direct pair. Compressed audio on a relay pair. */
  delivery?: AssetDelivery
}

export interface AssetPeerPath {
  id: string
  path: AssetPath
  buffered: number
}

export interface SharedAssetRecord {
  id: string
  name: string
  sampleRate: number
  sha256: string
  wav: Uint8Array
  quality?: 'wav' | 'compressed'
  upgrade?: string
  codec?: 'opus' | 'mp3'
  bitrate?: number
}

export interface SharedPartialRecord {
  id: string
  offer: AssetOffer
  parts: Array<Uint8Array | null>
}

export interface AssetByteStore {
  getAsset(id: string): Promise<SharedAssetRecord | null>
  putAsset(record: SharedAssetRecord): Promise<void>
  getPartial(id: string): Promise<SharedPartialRecord | null>
  putPartial(record: SharedPartialRecord): Promise<void>
  deletePartial(id: string): Promise<void>
}

/** Direct, relay, or not yet known. The candidate type decides what may be sent. */
export function chooseAssetPath(channelOpen: boolean, candidateType?: string): AssetPath {
  if (!channelOpen) return 'closed'
  if (candidateType === 'relay') return 'relay'
  if (candidateType === 'host' || candidateType === 'srflx' || candidateType === 'prflx') return 'direct'
  return 'unknown'
}

/** Lossless wav on a direct pair. Compressed audio on a relay pair. Nothing until the pair is known. */
export function assetDelivery(path: AssetPath): AssetDelivery {
  if (path === 'direct') return 'wav'
  if (path === 'relay') return 'compressed'
  return 'none'
}

/** The lossless wav is allowed only on a direct pair. */
export function assetBytesAllowed(path: AssetPath): boolean {
  return assetDelivery(path) === 'wav'
}

/**
 * Bytes this transfer adds on Cloudflare.
 * A relay path contributes the compressed payload only. Those bytes are already
 * inside the selected pair's stats, so the caller passes the payload size and
 * does not add the pair again. A direct path counts a selected relay pair,
 * which is empty when the pair really is direct. The monthly cap is not read.
 */
export function assetRelayCredit(path: AssetPath, pairs: RelayPair[], compressedBytes = 0): number {
  if (path === 'relay') {
    const sent = Number(compressedBytes)
    return Math.max(0, Math.round(Number.isFinite(sent) ? sent : 0))
  }
  if (path !== 'direct') return 0
  return sumRelayBytes(pairs)
}

export function encodeLosslessWav(channels: Float32Array[], sampleRate: number): Uint8Array {
  return new Uint8Array(encodeWav(channels, sampleRate, { bits: 32, dither: 'none' }))
}

export async function hashWav(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', wavBuffer(bytes))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyAssetWav(bytes: Uint8Array, sha256: string): Promise<boolean> {
  if (!ASSET_HASH.test(sha256)) return false
  return (await hashWav(bytes)) === sha256
}

export function splitAssetWav(bytes: Uint8Array, size = ASSET_CHUNK_BYTES): Uint8Array[] {
  return chunkBytes(bytes, size)
}

export function packAssetChunk(index: number, total: number, slice: Uint8Array): Uint8Array {
  return packTakeChunk(index, total, slice)
}

export function readAssetChunk(packet: ArrayBuffer): { index: number; total: number; bytes: Uint8Array } | null {
  const chunk = readTakeChunk(packet)
  if (!chunk || chunk.bytes.byteLength < 1 || chunk.bytes.byteLength > ASSET_CHUNK_BYTES) return null
  return chunk
}

export function missingChunkIndexes(parts: Array<Uint8Array | undefined> | undefined, total: number): number[] {
  const missing: number[] = []
  if (!Number.isInteger(total) || total < 1 || total > 4096) return missing
  for (let index = 0; index < total; index++) if (!parts?.[index]?.byteLength) missing.push(index)
  return missing
}

export function assembleAssetWav(parts: Array<Uint8Array | undefined>, total: number): Uint8Array | null {
  return assembleTakeWav(parts, total)
}

export function assetProgress(done: number, total: number): number {
  return takeProgress(done, total)
}

export function assetStatusLabel(phase: AssetPhase, progress: number, stored: boolean, quality: 'wav' | 'compressed' = 'wav'): string {
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100)
  if (phase === 'receiving') return quality === 'compressed' ? `Receiving compressed ${pct}%` : `Receiving ${pct}%`
  if (phase === 'sending') return quality === 'compressed' ? `Sending compressed ${pct}%` : `Sending ${pct}%`
  if (phase === 'verifying') return 'Checking the file'
  if (phase === 'saved' && quality === 'compressed') return 'Compressed copy on this device'
  if (phase === 'saved') return stored ? 'Saved on this device' : 'Saved for this session'
  if (phase === 'queued' && quality === 'compressed') return 'Upgrading to full quality'
  if (phase === 'waiting') return 'Waiting for a direct link'
  if (phase === 'failed') return 'Check failed, retrying'
  return 'Queued'
}

export function parseAssetControl(data: string): AssetControl | null {
  if (!data || data.length > 64_000) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const row = parsed as Record<string, unknown>
  if (row.t === 'catalog') {
    const assets = offersFromSignal(row)
    return assets ? { t: 'catalog', assets } : null
  }
  if (row.t === 'miss' || row.t === 'wait') {
    const id = typeof row.id === 'string' ? row.id : ''
    if (!ASSET_ID.test(id)) return null
    return { t: row.t, id }
  }
  if (row.t === 'want') {
    const id = typeof row.id === 'string' ? row.id : ''
    const sha256 = typeof row.sha256 === 'string' ? row.sha256 : ''
    if (!ASSET_ID.test(id) || (sha256 && !ASSET_HASH.test(sha256))) return null
    return { t: 'want', id, sha256, have: indexList(row.have, 4096) }
  }
  if (row.t === 'begin') {
    const offer = sanitizeOffer(row.offer)
    if (!offer) return null
    return { t: 'begin', offer, send: indexList(row.send, offer.total) }
  }
  return null
}

function indexList(value: unknown, total: number): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  const seen = new Set<number>()
  for (const item of value) {
    const index = Number(item)
    if (!Number.isInteger(index) || index < 0 || index >= total || seen.has(index)) continue
    seen.add(index)
    out.push(index)
  }
  return out
}

/**
 * Prefer a direct peer so the wav can move. When none is open, a relay peer
 * can still send the compressed copy. Closed peers are skipped.
 */
export function pickAssetPeer(input: {
  selfId: string
  holders: string[]
  paths: Record<string, AssetPath>
  skip?: string[]
  /** Set while upgrading a compressed copy. Relay peers are not asked again. */
  directOnly?: boolean
}): string | null {
  const skip = new Set(input.skip || [])
  const eligible = (path: AssetPath) => input.holders.filter((id) => id && id !== input.selfId && !skip.has(id) && input.paths[id] === path).sort()
  const direct = eligible('direct')
  if (direct.length) return direct[0]
  if (input.directOnly) return null
  return eligible('relay')[0] || null
}

export function audioFromVerifiedWav(id: string, name: string, sampleRate: number, wav: Uint8Array): AudioAsset | null {
  try {
    const decoded = decodeWavPCM(bytesToArrayBuffer(wav))
    if (!decoded.channels.length || !decoded.channels[0].length) return null
    return {
      id,
      name: name || 'Audio',
      sampleRate: decoded.sampleRate || sampleRate,
      channels: decoded.channels,
    }
  } catch {
    return null
  }
}

function compressedOffer(offer: AssetOffer): boolean {
  return offer.codec === 'opus' || offer.codec === 'mp3'
}

function filledIndexes(partial: SharedPartialRecord): number[] {
  return partial.parts.map((part, index) => (part?.byteLength ? index : -1)).filter((index) => index >= 0)
}

function cloneBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function wavBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

export function memoryAssetStore(): AssetByteStore {
  const assets = new Map<string, SharedAssetRecord>()
  const partials = new Map<string, SharedPartialRecord>()
  return {
    async getAsset(id) {
      const row = assets.get(id)
      return row ? { ...row, wav: cloneBytes(row.wav) } : null
    },
    async putAsset(record) {
      assets.set(record.id, { ...record, wav: cloneBytes(record.wav) })
      partials.delete(record.id)
    },
    async getPartial(id) {
      const row = partials.get(id)
      if (!row) return null
      return { id: row.id, offer: { ...row.offer }, parts: row.parts.map((part) => (part ? cloneBytes(part) : null)) }
    },
    async putPartial(record) {
      partials.set(record.id, { id: record.id, offer: { ...record.offer }, parts: record.parts.map((part) => (part ? cloneBytes(part) : null)) })
    },
    async deletePartial(id) {
      partials.delete(id)
    },
  }
}

const ASSET_DB = 'cueharbor-shared-assets'
let assetDb: Promise<IDBDatabase> | null = null

function openAssetDb(): Promise<IDBDatabase> {
  if (assetDb) return assetDb
  assetDb = new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSET_DB, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' })
      if (!db.objectStoreNames.contains('partials')) db.createObjectStore('partials', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      assetDb = null
      reject(request.error)
    }
  })
  return assetDb
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Received wavs and in-progress slices. Separate from the project database. */
export function indexedDbAssetStore(): AssetByteStore {
  return {
    async getAsset(id) {
      const db = await openAssetDb()
      const row = await idbRequest<{
        id: string
        name: string
        sampleRate: number
        sha256: string
        wav: Blob
        quality?: 'wav' | 'compressed'
        upgrade?: string
        codec?: 'opus' | 'mp3'
        bitrate?: number
      } | undefined>(
        db.transaction('assets', 'readonly').objectStore('assets').get(id),
      )
      if (!row?.wav) return null
      return {
        id: row.id,
        name: row.name,
        sampleRate: row.sampleRate,
        sha256: row.sha256,
        wav: new Uint8Array(await row.wav.arrayBuffer()),
        quality: row.quality,
        upgrade: row.upgrade,
        codec: row.codec,
        bitrate: row.bitrate,
      }
    },
    async putAsset(record) {
      const db = await openAssetDb()
      const wav = new Blob([wavBuffer(record.wav)], { type: record.quality === 'compressed' ? 'application/octet-stream' : 'audio/wav' })
      await idbRequest(db.transaction('assets', 'readwrite').objectStore('assets').put({
        id: record.id,
        name: record.name,
        sampleRate: record.sampleRate,
        sha256: record.sha256,
        wav,
        quality: record.quality || 'wav',
        upgrade: record.upgrade || '',
        codec: record.codec || '',
        bitrate: record.bitrate || 0,
      }))
      await idbRequest(db.transaction('partials', 'readwrite').objectStore('partials').delete(record.id))
    },
    async getPartial(id) {
      const db = await openAssetDb()
      const row = await idbRequest<{ id: string; offer: AssetOffer; parts: Array<Blob | null> } | undefined>(
        db.transaction('partials', 'readonly').objectStore('partials').get(id),
      )
      if (!row?.offer) return null
      const parts: Array<Uint8Array | null> = []
      for (const part of row.parts || []) parts.push(part ? new Uint8Array(await part.arrayBuffer()) : null)
      return { id: row.id, offer: row.offer, parts }
    },
    async putPartial(record) {
      const db = await openAssetDb()
      const parts = record.parts.map((part) => (part ? new Blob([wavBuffer(part)], { type: 'application/octet-stream' }) : null))
      await idbRequest(db.transaction('partials', 'readwrite').objectStore('partials').put({ id: record.id, offer: record.offer, parts }))
    },
    async deletePartial(id) {
      const db = await openAssetDb()
      await idbRequest(db.transaction('partials', 'readwrite').objectStore('partials').delete(id))
    },
  }
}

export function sharedAssetStore(): AssetByteStore {
  if (typeof indexedDB === 'undefined') return memoryAssetStore()
  return indexedDbAssetStore()
}

interface LocalWav {
  offer: AssetOffer
  wav: Uint8Array
  channels: Float32Array[]
  sampleRate: number
  compressed?: { bytes: Uint8Array; offer: AssetOffer }
}

interface HeardAsset {
  quality: 'wav' | 'compressed'
  channels: Float32Array[]
  sampleRate: number
  upgrade?: string
}

interface OutboundJob {
  id: string
  queue: number[]
  total: number
  payload: Uint8Array
  offer: AssetOffer
  delivery: 'wav' | 'compressed'
}

interface InboundJob {
  offer: AssetOffer
  parts: Array<Uint8Array | undefined>
}

interface StatusDraft {
  id: string
  name: string
  phase: AssetPhase
  progress: number
  stored: boolean
  quality?: 'wav' | 'compressed'
}

export class AssetExchange {
  private local = new Map<string, LocalWav>()
  private catalog = new Map<string, AssetOffer[]>()
  private outbound = new Map<string, OutboundJob>()
  private inbound = new Map<string, InboundJob>()
  private inflight = new Map<string, { peerId: string; at: number }>()
  private skipUntil = new Map<string, number>()
  private attempts = new Map<string, number>()
  private statuses = new Map<string, StatusDraft>()
  /** Ids we already have at full quality and must not request again. */
  private satisfied = new Set<string>()
  /** What this device can already play, including a compressed relay copy. */
  private played = new Map<string, HeardAsset>()
  /** Edit seats send bytes. View and Comment only request what they are missing. */
  private publishing = true
  private announced = ''
  private readonly store: AssetByteStore
  private readonly now: () => number
  private readonly codec: TakeAudioCodec

  constructor(store: AssetByteStore = memoryAssetStore(), now: () => number = () => Date.now(), codec: TakeAudioCodec = browserTakeCodec()) {
    this.store = store
    this.now = now
    this.codec = codec
  }

  reset() {
    this.local.clear()
    this.catalog.clear()
    this.outbound.clear()
    this.inbound.clear()
    this.inflight.clear()
    this.skipUntil.clear()
    this.attempts.clear()
    this.statuses.clear()
    this.satisfied.clear()
    this.played.clear()
    this.publishing = true
    this.announced = ''
  }

  /** A direct send failed. Skip that peer briefly so a relay path can carry the compressed copy. */
  noteDirectFailed(peerId: string, assetId: string) {
    if (!peerId || !assetId) return
    this.outbound.delete(peerId)
    this.inflight.delete(assetId)
    this.skipUntil.set(`${peerId}:${assetId}`, this.now() + 2000)
  }

  /** A live role change stops or resumes sending. Receiving does not use this flag. */
  setPublishing(publish: boolean) {
    this.publishing = publish
    if (!publish) this.outbound.clear()
  }

  noteCatalog(peerId: string, offers: AssetOffer[]) {
    if (!peerId) return
    this.catalog.set(peerId, offers.map((offer) => ({ ...offer })))
  }

  currentStatuses(): AssetStatus[] {
    return [...this.statuses.values()].map((row) => ({
      id: row.id,
      name: row.name,
      phase: row.phase,
      progress: row.progress,
      label: assetStatusLabel(row.phase, row.progress, row.stored, row.quality || 'wav'),
    }))
  }

  async handleControl(peerId: string, data: string, path: AssetPath): Promise<AssetAction[]> {
    const message = parseAssetControl(data)
    if (!message) return []
    if (message.t === 'catalog') {
      this.noteCatalog(peerId, message.assets)
      return []
    }
    if (message.t === 'miss' || message.t === 'wait') {
      this.inflight.delete(message.id)
      this.skipUntil.set(`${peerId}:${message.id}`, this.now() + (message.t === 'wait' ? 4000 : 1500))
      const row = this.statuses.get(message.id)
      if (row && row.phase !== 'saved') this.setStatus({ ...row, phase: 'waiting', progress: row.progress })
      return []
    }
    if (message.t === 'want') return this.answerWant(peerId, message, path)
    if (message.t === 'begin') {
      await this.beginInbound(peerId, message)
      return []
    }
    return []
  }

  async handleBinary(peerId: string, packet: ArrayBuffer): Promise<{ actions: AssetAction[]; completed: AudioAsset[] }> {
    const job = this.inbound.get(peerId)
    const chunk = readAssetChunk(packet)
    if (!job || !chunk || chunk.total !== job.offer.total) return { actions: [], completed: [] }
    if (!job.parts[chunk.index]) job.parts[chunk.index] = chunk.bytes
    const quality = compressedOffer(job.offer) ? 'compressed' : 'wav'
    const filled = job.offer.total - missingChunkIndexes(job.parts, job.offer.total).length
    this.setStatus({ id: job.offer.id, name: job.offer.name, phase: 'receiving', progress: assetProgress(filled, job.offer.total), stored: false, quality })
    await this.persistPartial(job)
    if (filled < job.offer.total) return { actions: [], completed: [] }
    this.setStatus({ id: job.offer.id, name: job.offer.name, phase: 'verifying', progress: 1, stored: false, quality })
    const wav = assembleAssetWav(job.parts, job.offer.total)
    this.inbound.delete(peerId)
    this.inflight.delete(job.offer.id)
    if (!wav || !(await verifyAssetWav(wav, job.offer.sha256))) {
      await this.store.deletePartial(job.offer.id).catch(() => undefined)
      const attempts = (this.attempts.get(job.offer.id) || 0) + 1
      this.attempts.set(job.offer.id, attempts)
      this.setStatus({ id: job.offer.id, name: job.offer.name, phase: 'failed', progress: 0, stored: false, quality })
      return { actions: [], completed: [] }
    }
    const audio = quality === 'compressed' ? await this.audioFromCompressed(job.offer, wav) : audioFromVerifiedWav(job.offer.id, job.offer.name, job.offer.sampleRate, wav)
    if (!audio) {
      this.setStatus({ id: job.offer.id, name: job.offer.name, phase: 'failed', progress: 0, stored: false, quality })
      return { actions: [], completed: [] }
    }
    let stored = false
    try {
      await this.store.putAsset({
        id: audio.id,
        name: audio.name,
        sampleRate: audio.sampleRate,
        sha256: job.offer.sha256,
        wav,
        quality,
        upgrade: job.offer.upgrade,
        codec: job.offer.codec === 'opus' || job.offer.codec === 'mp3' ? job.offer.codec : undefined,
        bitrate: job.offer.bitrate,
      })
      stored = true
    } catch {
      stored = false
    }
    if (quality === 'compressed') {
      this.played.set(audio.id, { quality: 'compressed', channels: audio.channels, sampleRate: audio.sampleRate, upgrade: job.offer.upgrade })
    } else this.remember(audio, wav, job.offer)
    this.attempts.delete(job.offer.id)
    this.setStatus({ id: audio.id, name: audio.name, phase: 'saved', progress: 1, stored, quality })
    return { actions: [], completed: [audio] }
  }

  async tick(input: { selfId: string; held: AudioAsset[]; referenced: string[]; peers: AssetPeerPath[]; publish?: boolean }): Promise<{
    signal: AssetOffer[] | null
    actions: AssetAction[]
    completed: AudioAsset[]
    statuses: AssetStatus[]
    busy: boolean
  }> {
    const actions: AssetAction[] = []
    const completed: AudioAsset[] = []
    const publish = input.publish !== false
    this.setPublishing(publish)
    if (!publish) this.local.clear()
    for (const asset of input.held) {
      if (this.played.get(asset.id)?.quality === 'compressed') continue
      if (publish) await this.rememberAsset(asset)
      else {
        this.played.set(asset.id, { quality: 'wav', channels: asset.channels, sampleRate: asset.sampleRate })
        this.satisfied.add(asset.id)
      }
    }
    const paths = Object.fromEntries(input.peers.map((peer) => [peer.id, peer.path]))
    const missing = input.referenced.filter((id) => {
      if (this.satisfied.has(id) || this.local.has(id)) return false
      return this.played.get(id)?.quality !== 'wav'
    })
    for (const id of missing) {
      const holders = this.holdersOf(id)
      const offer = holders.offers.find((item) => !item.codec || item.codec === 'wav') || holders.offers[0]
      const name = offer?.name || this.statuses.get(id)?.name || 'Audio'
      if ((this.attempts.get(id) || 0) >= 4) {
        this.setStatus({ id, name, phase: 'failed', progress: 0, stored: false })
        continue
      }
      const heard = this.played.get(id)
      if (!heard) {
        const fromDisk = await this.loadStored(id)
        if (fromDisk) {
          completed.push(fromDisk)
          if (this.played.get(id)?.quality !== 'compressed') continue
        }
      }
      if (this.inboundBusy(id) || this.inflight.has(id)) {
        const phase = this.inboundBusy(id) ? 'receiving' : 'queued'
        this.setStatus({ id, name, phase, progress: this.statuses.get(id)?.progress || 0, stored: false, quality: this.played.get(id)?.quality })
        continue
      }
      const upgrading = this.played.get(id)?.quality === 'compressed'
      const skip = this.skipped(id)
      const peerId = pickAssetPeer({ selfId: input.selfId, holders: holders.peers, paths, skip, directOnly: upgrading })
      if (!peerId) {
        const announced = holders.peers.length > 0
        const reachable = holders.peers.some((peer) => paths[peer] === 'direct' || paths[peer] === 'relay')
        this.setStatus({
          id,
          name,
          phase: upgrading ? 'saved' : announced && !reachable ? 'waiting' : 'queued',
          progress: upgrading ? 1 : this.statuses.get(id)?.progress || 0,
          stored: upgrading,
          quality: upgrading ? 'compressed' : 'wav',
        })
        continue
      }
      const partial = await this.resumePartial(id, offer, assetDelivery(paths[peerId] || 'closed'))
      const have = partial ? filledIndexes(partial) : []
      const sha = partial?.offer.sha256 || offer?.sha256 || ''
      this.inflight.set(id, { peerId, at: this.now() })
      this.setStatus({
        id,
        name,
        phase: 'queued',
        progress: assetProgress(have.length, partial?.offer.total || offer?.total || 1),
        stored: false,
        quality: upgrading ? 'compressed' : 'wav',
      })
      actions.push({
        peerId,
        assetId: id,
        delivery: assetDelivery(paths[peerId] || 'closed'),
        text: JSON.stringify({ t: 'want', id, sha256: sha, have } satisfies AssetControlWant),
      })
    }
    for (const peer of publish ? input.peers : []) {
      const job = this.outbound.get(peer.id)
      if (!job) continue
      if (assetDelivery(peer.path) !== job.delivery) {
        this.outbound.delete(peer.id)
        continue
      }
      if (peer.buffered > 256_000) continue
      const pieces = splitAssetWav(job.payload)
      let sent = 0
      while (job.queue.length && sent < ASSET_CHUNKS_PER_TURN) {
        const index = job.queue.shift()!
        const slice = pieces[index]
        if (!slice) continue
        actions.push({ peerId: peer.id, assetId: job.id, delivery: job.delivery, binary: packAssetChunk(index, pieces.length, slice) })
        sent += 1
      }
      const done = job.total - job.queue.length
      this.setStatus({
        id: job.id,
        name: job.offer.name,
        phase: job.queue.length ? 'sending' : 'saved',
        progress: assetProgress(done, job.total),
        stored: true,
        quality: job.delivery === 'compressed' ? 'compressed' : 'wav',
      })
      if (!job.queue.length) this.outbound.delete(peer.id)
    }
    const offers = [...this.local.values()].map((item) => item.offer).sort((a, b) => (a.id < b.id ? -1 : 1))
    const signature = JSON.stringify(offers)
    const signal = signature === this.announced ? null : offers
    if (signal) this.announced = signature
    const busy = input.peers.some((peer) => {
      const job = this.outbound.get(peer.id)
      return Boolean(job && job.queue.length && assetDelivery(peer.path) === job.delivery)
    })
    return { signal, actions, completed, statuses: this.currentStatuses(), busy }
  }

  private async answerWant(peerId: string, message: AssetControlWant, path: AssetPath): Promise<AssetAction[]> {
    const miss = { peerId, assetId: message.id, text: JSON.stringify({ t: 'miss', id: message.id } satisfies AssetControlMiss) }
    const wait = { peerId, assetId: message.id, text: JSON.stringify({ t: 'wait', id: message.id } satisfies AssetControlWait) }
    if (!this.publishing) return [miss]
    const local = this.local.get(message.id)
    if (!local) return [miss]
    const delivery = assetDelivery(path)
    if (delivery === 'none') return [wait]
    const active = this.outbound.get(peerId)
    if (active && active.queue.length && active.id !== message.id) return [wait]
    if (delivery === 'wav') return this.queueSend(peerId, 'wav', local.offer, local.wav, message.have)
    const compressed = await this.compressedFor(local)
    if (!compressed) return [wait]
    const have = message.sha256 === compressed.offer.sha256 ? message.have : []
    return this.queueSend(peerId, 'compressed', compressed.offer, compressed.bytes, have)
  }

  private queueSend(peerId: string, delivery: 'wav' | 'compressed', offer: AssetOffer, payload: Uint8Array, have: number[]): AssetAction[] {
    const pieces = splitAssetWav(payload)
    const owned = new Set(have.filter((index) => index >= 0 && index < pieces.length))
    const queue = pieces.map((_, index) => index).filter((index) => !owned.has(index))
    this.outbound.set(peerId, { id: offer.id, queue: queue.slice(), total: pieces.length, payload, offer, delivery })
    const begin: AssetControlBegin = { t: 'begin', offer, send: queue.slice() }
    const actions: AssetAction[] = [{ peerId, assetId: offer.id, delivery, text: JSON.stringify(begin) }]
    let sent = 0
    while (queue.length && sent < ASSET_CHUNKS_PER_TURN) {
      const index = queue.shift()!
      const slice = pieces[index]
      if (!slice) continue
      actions.push({ peerId, assetId: offer.id, delivery, binary: packAssetChunk(index, pieces.length, slice) })
      sent += 1
    }
    const job = this.outbound.get(peerId)
    if (job) job.queue = queue
    if (!queue.length) this.outbound.delete(peerId)
    const done = pieces.length - queue.length
    this.setStatus({
      id: offer.id,
      name: offer.name,
      phase: queue.length ? 'sending' : 'saved',
      progress: assetProgress(done, pieces.length),
      stored: true,
      quality: delivery === 'compressed' ? 'compressed' : 'wav',
    })
    return actions
  }

  private async beginInbound(peerId: string, message: AssetControlBegin) {
    const existing = this.inbound.get(peerId)
    if (existing && existing.offer.id !== message.offer.id && missingChunkIndexes(existing.parts, existing.offer.total).length) return
    const partial = await this.partialFor(message.offer.id, message.offer)
    const parts: Array<Uint8Array | undefined> = []
    if (partial && partial.offer.sha256 === message.offer.sha256) {
      partial.parts.forEach((part, index) => {
        if (part?.byteLength) parts[index] = part
      })
    }
    this.inbound.set(peerId, { offer: message.offer, parts })
    this.inflight.set(message.offer.id, { peerId, at: this.now() })
    const filled = message.offer.total - missingChunkIndexes(parts, message.offer.total).length
    this.setStatus({
      id: message.offer.id,
      name: message.offer.name,
      phase: 'receiving',
      progress: assetProgress(filled, message.offer.total),
      stored: false,
      quality: compressedOffer(message.offer) ? 'compressed' : 'wav',
    })
  }

  private holdersOf(id: string): { peers: string[]; offers: AssetOffer[] } {
    const peers: string[] = []
    const offers: AssetOffer[] = []
    for (const [peerId, list] of this.catalog) {
      const offer = list.find((item) => item.id === id)
      if (!offer) continue
      peers.push(peerId)
      offers.push(offer)
    }
    return { peers, offers }
  }

  private skipped(id: string): string[] {
    const now = this.now()
    const skip: string[] = []
    for (const [key, until] of this.skipUntil) {
      const [peerId, assetId] = key.split(':')
      if (assetId !== id) continue
      if (until <= now) this.skipUntil.delete(key)
      else skip.push(peerId)
    }
    const flight = this.inflight.get(id)
    if (flight && this.now() - flight.at > 8000) {
      this.skipUntil.set(`${flight.peerId}:${id}`, this.now() + 1500)
      this.inflight.delete(id)
      skip.push(flight.peerId)
    }
    return skip
  }

  private inboundBusy(id: string): boolean {
    for (const job of this.inbound.values()) {
      if (job.offer.id === id && missingChunkIndexes(job.parts, job.offer.total).length) return true
    }
    return false
  }

  private async loadStored(id: string): Promise<AudioAsset | null> {
    if ((this.attempts.get(id) || 0) >= 4 || this.played.has(id)) return null
    let row: SharedAssetRecord | null = null
    try {
      row = await this.store.getAsset(id)
    } catch {
      return null
    }
    if (!row) return null
    const announced = this.holdersOf(id).offers.find((item) => !item.codec || item.codec === 'wav') || this.holdersOf(id).offers[0]
    if (!(await verifyAssetWav(row.wav, row.sha256))) return null
    if (row.quality === 'compressed') {
      if (announced && row.upgrade && announced.sha256 !== row.upgrade) return null
      const audio = await this.audioFromCompressed({
        id: row.id,
        name: row.name,
        sampleRate: row.sampleRate,
        bytes: row.wav.byteLength,
        sha256: row.sha256,
        total: Math.ceil(row.wav.byteLength / ASSET_CHUNK_BYTES),
        codec: row.codec,
        bitrate: row.bitrate,
        upgrade: row.upgrade,
      }, row.wav)
      if (!audio) return null
      this.played.set(audio.id, { quality: 'compressed', channels: audio.channels, sampleRate: audio.sampleRate, upgrade: row.upgrade })
      this.setStatus({ id: audio.id, name: audio.name, phase: 'saved', progress: 1, stored: true, quality: 'compressed' })
      return audio
    }
    if (announced && announced.sha256 !== row.sha256) return null
    const audio = audioFromVerifiedWav(row.id, row.name, row.sampleRate, row.wav)
    if (!audio) return null
    const offer = announced || {
      id: row.id,
      name: row.name,
      sampleRate: row.sampleRate,
      bytes: row.wav.byteLength,
      sha256: row.sha256,
      total: Math.ceil(row.wav.byteLength / ASSET_CHUNK_BYTES),
    }
    this.remember(audio, row.wav, offer)
    this.setStatus({ id: audio.id, name: audio.name, phase: 'saved', progress: 1, stored: true, quality: 'wav' })
    return audio
  }

  private async partialFor(id: string, offer: AssetOffer | undefined): Promise<SharedPartialRecord | null> {
    try {
      const row = await this.store.getPartial(id)
      if (!row) return null
      if (offer && row.offer.sha256 !== offer.sha256) return null
      return row
    } catch {
      return null
    }
  }

  private async persistPartial(job: InboundJob) {
    const parts: Array<Uint8Array | null> = []
    for (let index = 0; index < job.offer.total; index++) {
      const part = job.parts[index]
      parts.push(part?.byteLength ? cloneBytes(part) : null)
    }
    try {
      await this.store.putPartial({ id: job.offer.id, offer: job.offer, parts })
    } catch {
      /* the in-memory slices still resume this session */
    }
  }

  private remember(asset: AudioAsset, wav: Uint8Array, offer: AssetOffer) {
    this.played.set(asset.id, { quality: 'wav', channels: asset.channels, sampleRate: asset.sampleRate })
    this.satisfied.delete(asset.id)
    if (!this.publishing) return
    const cached = this.local.get(asset.id)
    this.local.set(asset.id, { offer, wav, channels: asset.channels, sampleRate: asset.sampleRate, compressed: cached?.compressed })
  }

  private async rememberAsset(asset: AudioAsset) {
    const cached = this.local.get(asset.id)
    if (cached && cached.channels === asset.channels && cached.sampleRate === asset.sampleRate) return
    let wav: Uint8Array
    try {
      wav = encodeLosslessWav(asset.channels, asset.sampleRate)
    } catch {
      return
    }
    if (wav.byteLength < 44 || wav.byteLength > 64 * 1024 * 1024) return
    const sha256 = await hashWav(wav)
    const offer: AssetOffer = {
      id: asset.id,
      name: (asset.name || 'Audio').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'Audio',
      sampleRate: asset.sampleRate,
      bytes: wav.byteLength,
      sha256,
      total: Math.ceil(wav.byteLength / ASSET_CHUNK_BYTES),
    }
    if (!sanitizeOffer(offer)) return
    this.local.set(asset.id, { offer, wav, channels: asset.channels, sampleRate: asset.sampleRate, compressed: cached?.compressed })
    this.played.set(asset.id, { quality: 'wav', channels: asset.channels, sampleRate: asset.sampleRate })
    this.satisfied.delete(asset.id)
  }

  private async compressedFor(local: LocalWav): Promise<{ bytes: Uint8Array; offer: AssetOffer } | null> {
    if (local.compressed) return local.compressed
    let encoded: Awaited<ReturnType<TakeAudioCodec['encode']>> = null
    try {
      encoded = await this.codec.encode(local.channels, local.sampleRate)
    } catch {
      encoded = null
    }
    if (!encoded?.bytes.byteLength) return null
    const sha256 = await hashWav(encoded.bytes)
    const offer: AssetOffer = {
      id: local.offer.id,
      name: local.offer.name,
      sampleRate: local.sampleRate,
      bytes: encoded.bytes.byteLength,
      sha256,
      total: Math.ceil(encoded.bytes.byteLength / ASSET_CHUNK_BYTES),
      codec: encoded.codec,
      bitrate: encoded.bitrate,
      upgrade: local.offer.sha256,
    }
    if (!sanitizeOffer(offer)) return null
    local.compressed = { bytes: encoded.bytes, offer }
    return local.compressed
  }

  private async audioFromCompressed(offer: AssetOffer, bytes: Uint8Array): Promise<AudioAsset | null> {
    let decoded: Awaited<ReturnType<TakeAudioCodec['decode']>> = null
    try {
      decoded = await this.codec.decode(bytes)
    } catch {
      decoded = null
    }
    if (!decoded?.channels.length || !decoded.channels[0].length) return null
    return {
      id: offer.id,
      name: offer.name || 'Audio',
      sampleRate: decoded.sampleRate || offer.sampleRate,
      channels: decoded.channels,
    }
  }

  private async resumePartial(id: string, offer: AssetOffer | undefined, delivery: AssetDelivery): Promise<SharedPartialRecord | null> {
    try {
      const row = await this.store.getPartial(id)
      if (!row) return null
      if (delivery === 'compressed' && offer && row.offer.upgrade === offer.sha256) return row
      if (offer && row.offer.sha256 === offer.sha256) return row
      return null
    } catch {
      return null
    }
  }

  private setStatus(row: StatusDraft) {
    const previous = this.statuses.get(row.id)
    if (previous?.phase === 'saved' && row.phase === 'sending') {
      this.statuses.set(row.id, row)
      return
    }
    if (previous?.phase === 'receiving' && row.phase === 'saved' && previous.id === row.id) {
      this.statuses.set(row.id, row)
      return
    }
    this.statuses.set(row.id, row)
  }
}

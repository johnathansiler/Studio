import type { AudioAsset } from '../../model/types'
import type { SamplePack } from './types'

export const PACK_PREFIX = 'pack:'

/** A project asset that is packed instrument PCM, not a timeline clip. */
export function isPackAsset(asset: { name?: string } | undefined | null) {
  return !!asset?.name && asset.name.startsWith(PACK_PREFIX)
}

/**
 * Store a SoundFont sample chunk as float PCM so the project save keeps it.
 * Playback still decodes zones on demand from the rebuilt pack.
 */
export function packToAsset(pack: SamplePack): AudioAsset {
  const words = new Int16Array(pack.pcm)
  const channel = new Float32Array(words.length)
  for (let i = 0; i < words.length; i++) channel[i] = words[i] / 32768
  const channels = [channel]
  if (pack.sm24) {
    const low = new Uint8Array(pack.sm24)
    const extra = new Float32Array(words.length)
    for (let i = 0; i < words.length; i++) extra[i] = (low[i] || 0) / 255
    channels.push(extra)
  }
  return {
    id: pack.id,
    name: `${PACK_PREFIX}${Math.max(1, pack.channels || 1)}`,
    sampleRate: 48000,
    channels,
  }
}

/** Inverse of packToAsset. Values round-trip through 32-bit WAV. */
export function packFromAsset(asset: { id: string; name?: string; channels: Float32Array[] }): SamplePack | null {
  if (!isPackAsset(asset)) return null
  const source = asset.channels[0]
  if (!source?.length) return null
  const pcm = new ArrayBuffer(source.length * 2)
  const view = new DataView(pcm)
  for (let i = 0; i < source.length; i++) {
    const unit = Math.max(-1, Math.min(32767 / 32768, source[i] || 0))
    view.setInt16(i * 2, Math.round(unit * 32768), true)
  }
  let sm24: ArrayBuffer | undefined
  const low = asset.channels[1]
  if (low && low.length === source.length) {
    const bytes = new Uint8Array(source.length)
    for (let i = 0; i < source.length; i++) bytes[i] = Math.max(0, Math.min(255, Math.round((low[i] || 0) * 255)))
    sm24 = bytes.buffer
  }
  const channels = Number(asset.name!.slice(PACK_PREFIX.length)) || 1
  return { id: asset.id, pcm, sm24, channels }
}

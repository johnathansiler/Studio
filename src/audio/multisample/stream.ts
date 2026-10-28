import type { SampleBank } from './cache'
import type { DecodedSample, SampleRef } from './types'

/** Samples longer than this are read in chunks instead of installed whole. */
export const STREAM_FRAMES = 48_000 * 2
const CHUNK = 8192
const MAX_CHUNKS = 4

/**
 * A sample the voice can read by frame.
 * Only a few decoded chunks stay resident; the rest stays in the packed source.
 */
export interface SampleStream {
  frames: number
  channels: number
  sampleRate: number
  packId?: string
  at(channel: number, frame: number): number
  resident(): number
}

export function openStream(bank: SampleBank, sample: SampleRef): SampleStream | null {
  const host = bank as SampleBank & { stream?: (sample: SampleRef) => SampleStream | null }
  if (typeof host.stream !== 'function') return null
  return host.stream(sample)
}

/** Long float audio already in memory. Reads in place, so the cache does not clone it. */
export function viewStream(sample: DecodedSample): SampleStream {
  const frames = sample.channels[0]?.length ?? 0
  const channels = Math.max(1, sample.channels.length)
  return {
    frames,
    channels,
    sampleRate: sample.sampleRate,
    at(channel, frame) {
      if (frame < 0 || frame >= frames) return 0
      const data = sample.channels[Math.min(channel, channels - 1)]
      return data?.[frame] || 0
    },
    resident() {
      return 0
    },
  }
}

/**
 * Packed PCM (a SoundFont, or any frame store). `read` decodes one chunk.
 * Chunks far from the playhead are dropped.
 */
export function packStream(
  sample: SampleRef,
  packId: string,
  read: (start: number, count: number) => Float32Array[],
): SampleStream {
  const frames = Math.max(0, sample.frameCount)
  const channels = Math.max(1, sample.channels || 1)
  const chunks = new Map<number, Float32Array[]>()
  const recent: number[] = []
  const load = (index: number) => {
    const found = chunks.get(index)
    if (found) {
      const at = recent.indexOf(index)
      if (at >= 0) recent.splice(at, 1)
      recent.push(index)
      return found
    }
    const start = index * CHUNK
    const count = Math.max(0, Math.min(CHUNK, frames - start))
    const made = count > 0 ? read(start, count) : [new Float32Array(0)]
    chunks.set(index, made)
    recent.push(index)
    while (recent.length > MAX_CHUNKS) {
      const drop = recent.shift()
      if (drop != null) chunks.delete(drop)
    }
    return made
  }
  return {
    frames,
    channels,
    sampleRate: sample.sampleRate || 48000,
    packId,
    at(channel, frame) {
      if (frame < 0 || frame >= frames) return 0
      const index = Math.floor(frame / CHUNK)
      const block = load(index)
      const data = block[Math.min(channel, block.length - 1)]
      return data?.[frame - index * CHUNK] || 0
    },
    resident() {
      let count = 0
      for (const block of chunks.values()) {
        for (const channel of block) count += channel.length
      }
      return count
    },
  }
}

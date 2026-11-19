/**
 * Lossless float PCM for a clip that has already been pitch-shifted.
 * The source asset stays untouched. Playback time-stretches this cache.
 * The key includes a fingerprint of the samples, so an edit of the same
 * buffer id does not play a stale shift.
 */

const cache = new Map<string, Float32Array[]>()
const order: string[] = []
let floats = 0
/** About 48 MB of float PCM. Older renders drop first. */
const MAX_FLOATS = 12_000_000

export function channelPrint(channels: ArrayLike<Float32Array> | Float32Array[]) {
  let hash = 2166136261
  const list = channels as ArrayLike<Float32Array>
  for (let c = 0; c < list.length; c++) {
    const channel = list[c]
    hash = Math.imul(hash ^ channel.length, 16777619)
    for (let i = 0; i < channel.length; i++) {
      hash = Math.imul(hash ^ ((channel[i] || 0) * 1e5 | 0), 16777619)
    }
  }
  return hash >>> 0
}

export function formantPitchKey(input: {
  bufferId: string
  offsetSamples: number
  sourceSamples: number
  length: number
  sampleRate: number
  semitones: number
  cents: number
  formant: boolean
  mode: string
  /** Fingerprint of the samples being shifted. */
  print: number
}) {
  return [
    'pv2',
    input.bufferId,
    input.offsetSamples,
    input.sourceSamples,
    input.length,
    input.sampleRate,
    input.semitones,
    input.cents,
    input.formant ? 1 : 0,
    input.mode,
    input.print >>> 0,
  ].join(':')
}

export function readFormantPitch(key: string) {
  return cache.get(key) ?? null
}

function counted(channels: Float32Array[]) {
  return channels.reduce((sum, channel) => sum + channel.length, 0)
}

export function writeFormantPitch(key: string, channels: Float32Array[]) {
  if (!key || !channels[0]?.length) return
  const previous = cache.get(key)
  if (previous) floats -= counted(previous)
  cache.set(key, channels)
  floats += counted(channels)
  const at = order.indexOf(key)
  if (at >= 0) order.splice(at, 1)
  order.push(key)
  while (floats > MAX_FLOATS && order.length > 1) {
    const drop = order.shift()
    if (!drop) break
    const held = cache.get(drop)
    if (held) floats -= counted(held)
    cache.delete(drop)
  }
}

export function pitchCacheSize() {
  return cache.size
}

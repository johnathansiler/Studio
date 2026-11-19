/**
 * Lossless float PCM for a clip that has already been pitch-shifted.
 * The source asset stays untouched. Playback time-stretches this cache.
 */

const cache = new Map<string, Float32Array[]>()

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
}) {
  return [
    'pv1',
    input.bufferId,
    input.offsetSamples,
    input.sourceSamples,
    input.length,
    input.sampleRate,
    input.semitones,
    input.cents,
    input.formant ? 1 : 0,
    input.mode,
  ].join(':')
}

export function readFormantPitch(key: string) {
  return cache.get(key) ?? null
}

export function writeFormantPitch(key: string, channels: Float32Array[]) {
  if (!key || !channels[0]?.length) return
  cache.set(key, channels)
}

export function pitchCacheSize() {
  return cache.size
}

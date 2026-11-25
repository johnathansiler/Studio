/** Hats, claps, and snares share this buffer. Live playback and the bounce use the same seed. */

const SEED = 0x6d2b79f5

export function writeSharedNoise(channel: Float32Array) {
  let seed = SEED
  for (let index = 0; index < channel.length; index++) {
    seed = Math.imul(seed ^ (seed >>> 15), seed | 1)
    seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61)
    channel[index] = ((seed >>> 0) / 4294967296) * 2 - 1
  }
}

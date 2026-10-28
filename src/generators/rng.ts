/** Deterministic RNG. The same seed and variation always rebuild the same part. */

export function hashSeed(seed: number, variation: number, channel: number) {
  let h = 2166136261
  for (const part of [seed, variation, channel]) {
    h ^= part >>> 0
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Harmony ignores variation, so Vary keeps the chord roots. */
export function harmonyRng(seed: number) {
  return mulberry32(hashSeed(seed, 0, 1))
}

export function channelRng(seed: number, variation: number, channel: number) {
  return mulberry32(hashSeed(seed, variation + 17, channel + 3))
}

export function pickWeighted<T extends { weight: number }>(items: T[], rng: () => number): T {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0)
  if (total <= 0) return items[0]
  let roll = rng() * total
  for (const item of items) {
    roll -= Math.max(0, item.weight)
    if (roll <= 0) return item
  }
  return items[items.length - 1]
}

export function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

export function mod12(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

/** Swing delays the off-beat eighth. 1 is a triplet feel. */
export function swingTime(beat: number, amount: number) {
  if (amount <= 0) return beat
  const eighth = beat * 2
  const nearest = Math.round(eighth)
  if (Math.abs(eighth - nearest) > 0.08) return beat
  if (nearest % 2 === 0) return beat
  return beat + amount * (1 / 6)
}

export function roundBeat(beat: number) {
  return Math.round(beat * 480) / 480
}

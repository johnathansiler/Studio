/** Mix analysis inputs down to one finite channel. */

export function channelList(channels: ArrayLike<number> | ArrayLike<number>[]): ArrayLike<number>[] {
  if (channels instanceof Float32Array) return [channels]
  if (Array.isArray(channels)) {
    if (!channels.length) return []
    if (typeof channels[0] === 'number') return [channels as unknown as ArrayLike<number>]
    return channels as ArrayLike<number>[]
  }
  return [channels]
}

export function monoMix(channels: ArrayLike<number> | ArrayLike<number>[]): Float32Array {
  const list = channelList(channels)
  const length = list.reduce((max, channel) => Math.max(max, channel.length), 0)
  const out = new Float32Array(length)
  if (!list.length || !length) return out
  const scale = 1 / list.length
  for (const channel of list) {
    for (let i = 0; i < channel.length; i++) {
      const sample = channel[i] || 0
      if (Number.isFinite(sample)) out[i] += sample * scale
    }
  }
  return out
}

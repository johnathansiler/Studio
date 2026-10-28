/** Mono key for a compressor or gate. Uses the rendered pre-fader bus when it is ready, otherwise the track buffer or the tracks that feed it. */
export interface KeyTrack {
  id: string
  type: string
  buffer: Float32Array[]
  groupId: string | null
  output: string | null
  sends: { busId: string; enabled: boolean }[]
}

export function sidechainMono(
  id: string,
  offset: number,
  count: number,
  tracks: KeyTrack[],
  rendered: Map<string, { pre: Float32Array[] }>,
) {
  if (!id || count <= 0) return null
  const ready = rendered.get(id)?.pre
  if (ready) return mix(ready, offset, count)
  const track = tracks.find((item) => item.id === id)
  if (track && track.type !== 'bus' && track.type !== 'group') return mix(track.buffer, offset, count)
  const feeds = tracks.filter((item) => item.groupId === id || item.output === id || item.sends.some((send) => send.enabled && send.busId === id))
  if (track && !feeds.length) return mix(track.buffer, offset, count)
  if (!feeds.length) return null
  const out = new Float32Array(count)
  for (const feed of feeds) {
    const source = rendered.get(feed.id)?.pre ?? feed.buffer
    const mono = mix(source, offset, count)
    for (let i = 0; i < count; i++) out[i] += mono[i]
  }
  return out
}

function mix(buffer: Float32Array[], offset: number, count: number) {
  const out = new Float32Array(count)
  const left = buffer[0]
  const right = buffer[1] ?? left
  if (!left) return out
  for (let i = 0; i < count; i++) {
    const index = offset + i
    const l = index >= 0 && index < left.length ? left[index] : 0
    const r = right && index >= 0 && index < right.length ? right[index] : l
    out[i] = (l + r) * 0.5
  }
  return out
}

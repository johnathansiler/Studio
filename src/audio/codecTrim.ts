/**
 * Encoder delay left in a decoded MP3 or AAC buffer is silence at the loop point.
 * WAV has no encoder delay and is preferred before this trim runs.
 */

export function readLameDelay(bytes: Uint8Array): { delay: number; padding: number } | null {
  const end = Math.min(bytes.length - 24, 8192)
  for (let i = 0; i < end; i++) {
    if (bytes[i] !== 0x4c || bytes[i + 1] !== 0x41 || bytes[i + 2] !== 0x4d || bytes[i + 3] !== 0x45) continue
    const version = bytes[i + 4]
    if (version !== 0x20 && (version < 0x30 || version > 0x39)) continue
    const at = i + 21
    if (at + 2 >= bytes.length) return null
    const delay = (bytes[at] << 4) | (bytes[at + 1] >> 4)
    const padding = ((bytes[at + 1] & 0x0f) << 8) | bytes[at + 2]
    if (delay === 0 && padding === 0) return null
    if (delay > 4096 || padding > 8192) return null
    return { delay, padding }
  }
  return null
}

export function isAacFile(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const kind = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7])
  if (kind === 'ftyp') return true
  return bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0
}

export function trimCodecPadding(channels: Float32Array[], delay: number, padding: number): Float32Array[] {
  const lead = channels[0]
  if (!lead?.length) return channels
  const start = Math.max(0, Math.min(lead.length - 2, Math.round(delay)))
  const end = Math.max(start + 2, lead.length - Math.max(0, Math.round(padding)))
  if (start === 0 && end === lead.length) return channels.map((channel) => Float32Array.from(channel))
  return channels.map((channel) => {
    const from = Math.max(0, start)
    const to = Math.min(channel.length, end)
    const out = new Float32Array(Math.max(2, to - from))
    out.set(channel.subarray(from, to))
    return out
  })
}

/** AAC-LC priming is 2112 samples. Drop it only when that head is actually silence. */
export function trimAacPriming(channels: Float32Array[], sampleRate: number): Float32Array[] {
  const lead = channels[0]
  const priming = 2112
  if (!lead || lead.length < priming + sampleRate * 0.05) return channels
  if (rms(lead, 0, priming) > Math.max(0.0008, rms(lead, priming, Math.min(lead.length, priming + sampleRate * 0.25)) * 0.08)) return channels
  return trimCodecPadding(channels, priming, 0)
}

function rms(channel: Float32Array, start: number, end: number) {
  const from = Math.max(0, start)
  const to = Math.min(channel.length, end)
  if (to <= from) return 0
  let sum = 0
  for (let i = from; i < to; i++) sum += (channel[i] || 0) ** 2
  return Math.sqrt(sum / (to - from))
}

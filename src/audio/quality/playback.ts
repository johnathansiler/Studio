import { resampleSinc } from './resample'

/**
 * Play a file at the device rate.
 * A 96 kHz buffer left for the browser to resample, or stepped with a short
 * kernel, folds the top octave back into the audible band. That alias is the
 * crackle on bright library one-shots. This is one windowed-sinc conversion.
 */
export function fitPlaybackRate(channels: Float32Array[], fromRate: number, toRate: number) {
  const lead = channels[0]
  const from = fromRate > 0 ? fromRate : toRate
  const to = toRate > 0 ? toRate : from
  if (!lead?.length || !(from > 0) || !(to > 0) || from === to) {
    return { sampleRate: from || to || 48000, channels }
  }
  const outLen = Math.max(1, Math.round((lead.length * to) / from))
  const taps = lead.length > from * 90 ? 32 : 64
  return {
    sampleRate: to,
    channels: channels.map((channel) => {
      const source = channel.length === lead.length ? channel : fitLength(channel, lead.length)
      return resampleSinc(source, outLen, taps)
    }),
  }
}

function fitLength(channel: Float32Array, length: number) {
  const out = new Float32Array(length)
  out.set(channel.subarray(0, Math.min(channel.length, length)))
  return out
}

/**
 * A few milliseconds of fade so a sample that does not start or end at zero
 * does not click. The body of the note is left alone.
 */
export function fadePlaybackEdges(channels: Float32Array[], samples: number) {
  const fade = Math.max(0, samples | 0)
  if (fade < 2) return channels
  return channels.map((channel) => {
    if (channel.length < fade * 2) return channel
    const out = channel.slice()
    for (let i = 0; i < fade; i++) {
      const gain = i / fade
      out[i] *= gain
      out[out.length - 1 - i] *= gain
    }
    return out
  })
}

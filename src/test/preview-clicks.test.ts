import { describe, expect, it } from 'vitest'
import { parseLibraryCatalog } from '../library/catalog'
import { isLibraryStandard, LIBRARY_BITS, LIBRARY_CHANNELS, LIBRARY_RATE } from '../library/standard'
import { prepareSpeakerPreview } from '../audio/quality/playback'
import { measurePeak } from '../audio/level'

function sine(freq: number, n: number, rate: number, amp: number) {
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return data
}

function thd(buf: Float32Array, freq: number, rate: number, start: number) {
  const n = Math.min(8192, buf.length - start - 8)
  const w = (2 * Math.PI * freq) / rate
  let aa = 0
  let bb = 0
  let cc = 0
  let dd = 0
  let ee = 0
  for (let i = 0; i < n; i++) {
    const s = Math.sin(w * i)
    const c = Math.cos(w * i)
    const x = buf[start + i]
    aa += s * s
    bb += s * c
    cc += c * c
    dd += x * s
    ee += x * c
  }
  const det = aa * cc - bb * bb
  const sineA = (dd * cc - bb * ee) / det
  const cosine = (aa * ee - bb * dd) / det
  let noise = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const err = buf[start + i] - (sineA * Math.sin(w * i) + cosine * Math.cos(w * i))
    noise += err * err
    total += buf[start + i] * buf[start + i]
  }
  return Math.sqrt(noise / total)
}

function clickSpikes(buf: Float32Array) {
  const peak = measurePeak([buf]) || 1
  let spikes = 0
  for (let i = 2; i < buf.length; i++) {
    const rel = Math.abs(buf[i] - 2 * buf[i - 1] + buf[i - 2]) / peak
    if (rel > 0.05) spikes += 1
  }
  return spikes
}

function dropoutSamples(buf: Float32Array) {
  const peak = measurePeak([buf]) || 1
  const floor = peak * 0.02
  let run = 0
  let worst = 0
  const from = Math.floor(buf.length * 0.05)
  const to = Math.floor(buf.length * 0.95)
  for (let i = from; i < to; i++) {
    if (Math.abs(buf[i]) < floor) {
      run += 1
      if (run > worst) worst = run
    } else run = 0
  }
  return worst
}

describe('library preview of a sub and a bright loop', () => {
  it('moves a 44.1 kHz sub to 48 kHz without clicks, dropouts, or a broken seam', () => {
    const rate = 44100
    const sub = sine(55, rate, rate, 0.9)
    sub[0] = 0.2
    const played = prepareSpeakerPreview([sub, sub], rate, 48000, true)
    const left = played.channels[0]
    expect(played.sampleRate).toBe(48000)
    expect(thd(left, 55, 48000, Math.floor(48000 * 0.1))).toBeLessThan(1e-4)
    const body = left.subarray(Math.floor(48000 * 0.02), left.length - Math.floor(48000 * 0.02))
    expect(clickSpikes(body)).toBe(0)
    expect(dropoutSamples(left)).toBeLessThan(40)
    const wrap = Math.abs(left[0] - left[left.length - 1])
    const slope = Math.abs(left[left.length - 1] - left[left.length - 2])
    expect(wrap).toBeLessThan(slope * 8 + 0.01)
  })

  it('does not resample a file that is already at the device rate', () => {
    const tone = sine(220, 4800, 48000, 0.4)
    const played = prepareSpeakerPreview([tone], 48000, 48000, false)
    expect(played.sampleRate).toBe(48000)
    expect(played.channels[0].length).toBe(tone.length)
    expect(clickSpikes(played.channels[0])).toBe(0)
    expect(dropoutSamples(played.channels[0])).toBeLessThan(40)
  })

  it('keeps a bright loop under the same click budget as the sub', () => {
    const rate = 44100
    const n = rate
    const brass = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let h = 1; h <= 8; h++) sum += Math.sin((2 * Math.PI * 220 * h * i) / rate) / h
      brass[i] = sum
    }
    let peak = 0
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(brass[i]))
    for (let i = 0; i < n; i++) brass[i] = (brass[i] / peak) * 0.8
    const bright = prepareSpeakerPreview([brass], rate, 48000, false).channels[0]
    expect(clickSpikes(bright)).toBeLessThanOrEqual(clickSpikes(brass) + 8)
    expect(dropoutSamples(bright)).toBeLessThan(40)
  })
})

describe('library playback standard', () => {
  it('is 48 kHz 24-bit stereo PCM WAV', () => {
    expect(isLibraryStandard({ format: 'wav', sampleRate: LIBRARY_RATE, bits: LIBRARY_BITS, channels: LIBRARY_CHANNELS })).toBe(true)
    expect(isLibraryStandard({ format: 'wav', sampleRate: 44100, bits: 24, channels: 2 })).toBe(false)
    expect(isLibraryStandard({ format: 'mp3', sampleRate: 48000, bits: 24, channels: 2 })).toBe(false)
    expect(isLibraryStandard({ format: 'wav', sampleRate: 48000, bits: 16, channels: 2 })).toBe(false)
    expect(isLibraryStandard({ format: 'wav', sampleRate: 96000, bits: 24, channels: 1 })).toBe(false)
  })

  it('reads rate, bit depth, and channels from a catalog row', () => {
    const parsed = parseLibraryCatalog({
      version: 1,
      generated_at: '2026-11-17',
      count: 1,
      entries: [{
        key: 'Loops/E808 Loop BD 105-04.wav',
        size: 100,
        format: 'wav',
        sampleRate: 44100,
        bitDepth: 24,
        channels: 2,
        pack: 'MusicRadar',
        type: 'loop',
        category: 'bass',
        instrument: '808',
        genre: [],
        bpm: 105,
        musical_key: '',
        root: '',
        note: '',
        mood: [],
        tags: [],
        license: 'private',
        search: 'e808 loop bass',
      }],
    })
    const entry = parsed?.document.entries[0]
    expect(entry?.sampleRate).toBe(44100)
    expect(entry?.bitDepth).toBe(24)
    expect(entry?.channels).toBe(2)
    expect(isLibraryStandard({ format: entry?.format, sampleRate: entry?.sampleRate, bits: entry?.bitDepth, channels: entry?.channels })).toBe(false)
  })
})

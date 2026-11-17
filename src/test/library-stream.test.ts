import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'
import { resampleSinc } from '../audio/quality/resample'
import { decodeWavPCM } from '../model/wav'
import { directDatasetUrl } from '../sounds/direct'
import { SOUND_CATALOG_URL, SOUND_DATASET_COMMIT } from '../sounds/contract'
import { createCatalogScan, pullCatalogEntries, parseSoundScoutCatalog } from '../sounds/catalog'
import { RateStreamer, WavDecoder, outputLength } from '../sounds/wavStream'
import { soundFileUrl } from '../sounds/source'

describe('library streaming', () => {
  it('skips the Hugging Face resolve redirect', () => {
    const file = soundFileUrl('soundscout-2026-11-09/one-shots/drums/kick #1.wav')
    const direct = directDatasetUrl(file)
    expect(direct.startsWith(`https://huggingface.co/api/resolve-cache/datasets/cueharbor/sound-library/${SOUND_DATASET_COMMIT}/`)).toBe(true)
    expect(direct).toContain(encodeURIComponent('soundscout-2026-11-09/one-shots/drums/kick #1.wav'))
    expect(directDatasetUrl(SOUND_CATALOG_URL)).toContain(encodeURIComponent('catalogs/soundscout-2026-11-17-4.json'))
    expect(directDatasetUrl('https://example.com/nope')).toBe('https://example.com/nope')
  })

  it('decodes a chunked 24-bit wav the same way as the whole file', () => {
    const rate = 96000
    const frames = 2400
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    for (let i = 0; i < frames; i++) {
      left[i] = Math.sin(i / 12) * 0.8
      right[i] = Math.cos(i / 20) * 0.4
    }
    const bytes = new Uint8Array(encodeWav([left, right], rate, { bits: 24 }))
    const whole = decodeWavPCM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const decoder = new WavDecoder()
    for (let offset = 0; offset < bytes.length; offset += 100) decoder.push(bytes.subarray(offset, offset + 100))
    expect(decoder.ready()?.sampleRate).toBe(rate)
    expect(decoder.decodedFrames).toBe(frames)
    expect(decoder.fileChannels[0]).toEqual(whole.channels[0])
    expect(decoder.fileChannels[1]).toEqual(whole.channels[1])
  })

  it('streams the same sinc the full preview uses', () => {
    const from = 96000
    const to = 48000
    const frames = 9600
    const channel = new Float32Array(frames)
    for (let i = 0; i < frames; i++) channel[i] = Math.sin((2 * Math.PI * 3000 * i) / from) * 0.5
    const outLen = outputLength(frames, from, to)
    const full = resampleSinc(channel, outLen, 96)
    const decoder = new WavDecoder()
    const wav = new Uint8Array(encodeWav([channel], from, { bits: 24 }))
    let stream: RateStreamer | null = null
    const parts: Float32Array[] = []
    for (let offset = 0; offset < wav.length; offset += 1500) {
      decoder.push(wav.subarray(offset, offset + 1500))
      const info = decoder.ready()
      if (!info) continue
      stream ??= new RateStreamer(decoder.fileChannels, info.frames, info.sampleRate, to)
      const slice = stream.take(decoder.decodedFrames, info.frames)
      if (slice?.[0]?.length) parts.push(slice[0])
    }
    const info = decoder.ready()!
    const tail = stream!.take(info.frames, info.frames)
    if (tail?.[0]?.length) parts.push(tail[0])
    const joined = new Float32Array(outLen)
    let cursor = 0
    for (const part of parts) {
      joined.set(part, cursor)
      cursor += part.length
    }
    expect(cursor).toBe(full.length)
    let worst = 0
    for (let i = 0; i < full.length; i++) worst = Math.max(worst, Math.abs(full[i] - joined[i]))
    expect(worst).toBeLessThan(1e-6)
  })

  it('shows catalog rows before the document has finished', () => {
    const raw = readFileSync(new URL('../../catalogs/soundscout-2026-11-17-4.json', import.meta.url))
    const text = raw.toString('utf8')
    const scan = createCatalogScan()
    let seen = 0
    let first = ''
    for (let offset = 0; offset < text.length; offset += 4096) {
      const pulled = pullCatalogEntries(scan, text.slice(offset, offset + 4096))
      if (!first && pulled.entries.length) first = pulled.entries[0].name
      seen += pulled.entries.length
      if (pulled.done) break
    }
    const official = parseSoundScoutCatalog(JSON.parse(text))
    expect(first).toBe('01 808 - C1')
    expect(seen).toBe(official.length)
    expect(seen).toBe(1208)
    expect(scan.text.length).toBeGreaterThan(0)
  })
})

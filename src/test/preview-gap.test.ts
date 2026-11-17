import { describe, expect, it } from 'vitest'
import { abutPreviewSlice, canStartGaplessPreview } from '../audio/previewSchedule'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { resampleSinc } from '../audio/quality/resample'
import { SoundCache, memoryByteStore, resetSoundDownloads } from '../sounds/cache'
import { streamCatalogSound } from '../sounds/playStream'
import { soundFileUrl } from '../sounds/source'

/** Chrome DevTools Slow 4G downlink. */
const SLOW_4G_BYTES_PER_SEC = (500 * 1000) / 8

/** Slower than Slow 4G. */
const SLOWER_BYTES_PER_SEC = 10 * 1000

function tone(frames: number, rate: number, freq: number) {
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.6
  return data
}

function wavBytes(channel: Float32Array, rate: number) {
  const encoded = encodeWav([channel], rate, { bits: 16 })
  return new Uint8Array(encoded)
}

function throttledFetch(bytes: Uint8Array, bytesPerSec: number) {
  return async () => {
    let offset = 0
    const size = 2048
    return new Response(new ReadableStream({
      async pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        const end = Math.min(bytes.length, offset + size)
        const chunk = bytes.subarray(offset, end)
        offset = end
        controller.enqueue(chunk)
        await new Promise((resolve) => setTimeout(resolve, (chunk.length / bytesPerSec) * 1000))
      },
    }))
  }
}

function concat(parts: Float32Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(length)
  let cursor = 0
  for (const part of parts) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}

describe('preview schedule', () => {
  it('refuses a slice that would start after the audio already scheduled', () => {
    expect(abutPreviewSlice(null, 10)).toBeCloseTo(10.02)
    expect(abutPreviewSlice(12, 10)).toBe(12)
    expect(abutPreviewSlice(12, 12)).toBe(12)
    expect(abutPreviewSlice(12, 12.001)).toBeNull()
  })

  it('waits on Slow 4G until the buffer covers the rest of the file', () => {
    const total = 879_000
    const duration = 1.52
    const earlyReceived = SLOW_4G_BYTES_PER_SEC * 2
    expect(canStartGaplessPreview({
      receivedBytes: earlyReceived,
      totalBytes: total,
      elapsedSec: 2,
      bufferedSec: (earlyReceived / total) * duration,
    })).toBe(false)
    const lateReceived = total * 0.97
    const lateElapsed = lateReceived / SLOW_4G_BYTES_PER_SEC
    expect(canStartGaplessPreview({
      receivedBytes: lateReceived,
      totalBytes: total,
      elapsedSec: lateElapsed,
      bufferedSec: 0.97 * duration,
    })).toBe(true)
    expect(canStartGaplessPreview({
      receivedBytes: lateReceived,
      totalBytes: total,
      elapsedSec: lateReceived / SLOWER_BYTES_PER_SEC,
      bufferedSec: 0.97 * duration,
    })).toBe(false)
    // A fast lifetime average must not hide a link that has already slowed down.
    expect(canStartGaplessPreview({
      receivedBytes: lateReceived,
      totalBytes: total,
      elapsedSec: lateElapsed,
      bufferedSec: 0.97 * duration,
      recentBytes: 16 * 1024,
      recentSec: (16 * 1024) / SLOWER_BYTES_PER_SEC,
    })).toBe(false)
  })
})

describe('throttled preview has no gaps', () => {
  async function play(name: string, channel: Float32Array, rate: number, toRate: number, bytesPerSec: number) {
    resetSoundDownloads()
    const bytes = wavBytes(channel, rate)
    const fetchImpl = throttledFetch(bytes, bytesPerSec)
    const emissions: { at: number; channels: Float32Array[]; sampleRate: number }[] = []
    const started = performance.now()
    const file = await streamCatalogSound({
      url: soundFileUrl(`soundscout-2026-11-09/one-shots/${name}.wav`),
      toRate,
      totalBytes: bytes.byteLength,
      fetchImpl,
      cache: new SoundCache([memoryByteStore()]),
      onSlice: (slice) => {
        emissions.push({ at: performance.now(), channels: slice.channels.map((item) => Float32Array.from(item)), sampleRate: slice.sampleRate })
      },
    })
    return { emissions, file, ms: performance.now() - started, bytes }
  }

  function assertContinuous(emissions: { at: number; channels: Float32Array[]; sampleRate: number }[], expected: Float32Array) {
    expect(emissions.length).toBeGreaterThan(0)
    let audioEnd = 0
    const t0 = emissions[0].at
    const rendered: Float32Array[] = []
    for (const emission of emissions) {
      const arrived = (emission.at - t0) / 1000
      const gap = arrived - audioEnd
      expect(gap).toBeLessThanOrEqual(0.02)
      const lead = emission.channels[0]
      expect(lead.length).toBeGreaterThan(0)
      rendered.push(lead)
      audioEnd += lead.length / emission.sampleRate
    }
    const heard = concat(rendered)
    expect(heard.length).toBe(expected.length)
    const fade = Math.max(8, Math.round(emissions[0].sampleRate * 0.0015))
    let worst = 0
    for (let i = fade; i < heard.length - fade; i++) worst = Math.max(worst, Math.abs(heard[i] - expected[i]))
    expect(worst).toBeLessThan(1e-4)
    let cursor = 0
    for (let index = 0; index < rendered.length - 1; index++) {
      cursor += rendered[index].length
      const join = cursor
      expect(Math.abs(heard[join] - expected[join])).toBeLessThan(1e-4)
      expect(Math.abs(heard[join - 1] - expected[join - 1])).toBeLessThan(1e-4)
    }
  }

  it('keeps Slow 4G playback continuous for a 96 kHz file', async () => {
    const rate = 96000
    const channel = tone(Math.round(rate * 1.2), rate, 440)
    const { emissions } = await play('slow-96k', channel, rate, 48000, SLOW_4G_BYTES_PER_SEC)
    const expected = resampleSinc(decodeWavPCM(wavBytes(channel, rate).buffer).channels[0], Math.round(channel.length * 48000 / rate), 96)
    assertContinuous(emissions, expected)
  }, 20_000)

  it('plays a slower-than-Slow-4G download from the full decode', async () => {
    const rate = 48000
    const channel = tone(Math.round(rate * 0.12), rate, 330)
    const { emissions } = await play('slower-48k', channel, rate, rate, SLOWER_BYTES_PER_SEC)
    expect(emissions.length).toBe(1)
    const expected = decodeWavPCM(wavBytes(channel, rate).buffer).channels[0]
    assertContinuous(emissions, expected)
  }, 20_000)

  it('does not open a gap when several slices start early', async () => {
    const rate = 48000
    const channel = tone(Math.round(rate * 1.6), rate, 220)
    const { emissions } = await play('fast-slices', channel, rate, rate, 400_000)
    expect(emissions.length).toBeGreaterThan(1)
    assertContinuous(emissions, decodeWavPCM(wavBytes(channel, rate).buffer).channels[0])
  }, 20_000)

  it('is not slower to a placeable buffer than download-then-decode', async () => {
    const rate = 48000
    const channel = tone(Math.round(rate * 0.45), rate, 180)
    const bytes = wavBytes(channel, rate)
    for (const speed of [SLOW_4G_BYTES_PER_SEC, SLOWER_BYTES_PER_SEC]) {
      resetSoundDownloads()
      const streamStarted = performance.now()
      await streamCatalogSound({
        url: soundFileUrl(`soundscout-2026-11-09/one-shots/track-${speed}.wav`),
        toRate: rate,
        totalBytes: bytes.byteLength,
        fetchImpl: throttledFetch(bytes, speed),
        cache: new SoundCache([memoryByteStore()]),
        play: false,
        onSlice: () => undefined,
      })
      const streamMs = performance.now() - streamStarted
      const serialStarted = performance.now()
      const response = await throttledFetch(bytes, speed)()
      const downloaded = new Uint8Array(await response.arrayBuffer())
      const decoded = decodeWavPCM(downloaded.buffer)
      resampleSinc(decoded.channels[0], decoded.channels[0].length, 96)
      const serialMs = performance.now() - serialStarted
      expect(streamMs).toBeLessThanOrEqual(serialMs + 80)
    }
  }, 30_000)
})

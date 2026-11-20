import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resampleSinc } from '../audio/quality/resample'
import { clearLibraryAccessKey, LibraryAuthError, writeLibraryAccessKey } from '../library/access'
import { memoryAudioCache, setLibraryCaches } from '../library/audio'
import { resetLibrarySoundMemory, previewLibrarySound, streamLibraryAsset } from '../library/stream'
import type { LibraryEntry } from '../library/types'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { resetSoundDownloads } from '../sounds/cache'

/** Chrome DevTools Slow 4G downlink. */
const SLOW_4G_BYTES_PER_SEC = (500 * 1000) / 8

function tone(frames: number, rate: number, freq: number) {
  const data = new Float32Array(frames)
  for (let i = 0; i < frames; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return data
}

function wavBytes(channel: Float32Array, rate: number) {
  return new Uint8Array(encodeWav([channel], rate, { bits: 16 }))
}

function entryFor(key: string, bytes: Uint8Array, type = 'one-shot'): LibraryEntry {
  return {
    key,
    size: bytes.byteLength,
    format: 'wav',
    pack: 'Pack',
    type,
    category: '',
    instrument: '',
    genre: [],
    bpm: type === 'loop' ? 100 : null,
    bpmAlt: null,
    musicalKey: '',
    root: '',
    note: '',
    mood: [],
    tags: [],
    license: 'private',
    name: key,
  }
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
    }), { status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(bytes.byteLength) } })
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

function libraryFetch(bytes: Uint8Array, bytesPerSec: number, passphrase: string, audioHits: { n: number }) {
  const audio = throttledFetch(bytes, bytesPerSec)
  return async (input: string, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/library/sign')) {
      const header = new Headers(init?.headers).get('x-library-key')
      if (header !== passphrase) {
        return new Response(JSON.stringify({ error: 'That passphrase does not unlock the library.' }), { status: 401, headers: { 'content-type': 'application/json' } })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { keys?: string[] }
      return new Response(JSON.stringify({
        expiresIn: 900,
        urls: (body.keys ?? []).map((key) => ({ key, url: `https://library.test/${encodeURIComponent(key)}` })),
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (!url.startsWith('https://library.test/')) return new Response('missing', { status: 404 })
    audioHits.n += 1
    return audio()
  }
}

function assertContinuous(emissions: { at: number; channels: Float32Array[] ; sampleRate: number }[], expected: Float32Array) {
  expect(emissions.length).toBeGreaterThan(0)
  let audioEnd = 0
  const t0 = emissions[0].at
  const rendered: Float32Array[] = []
  for (const emission of emissions) {
    const arrived = (emission.at - t0) / 1000
    expect(arrived - audioEnd).toBeLessThanOrEqual(0.02)
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
    expect(Math.abs(heard[cursor] - expected[cursor])).toBeLessThan(1e-4)
    expect(Math.abs(heard[cursor - 1] - expected[cursor - 1])).toBeLessThan(1e-4)
  }
}

describe('my library streamed preview', () => {
  it('calls the engine methods with the engine as this', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    writeLibraryAccessKey('owner-pass')
    const rate = 48000
    const bytes = wavBytes(tone(1800, rate, 330), rate)
    const fetchImpl = libraryFetch(bytes, 2_000_000, 'owner-pass', { n: 0 })
    const engine = {
      fed: 0,
      looped: 0,
      stopPreview() {},
      previewPcm() {},
      feedPreview() {
        this.fed += 1
        return true
      },
      setPreviewGain() {},
      continuePreviewLoop() {
        this.looped += 1
        return true
      },
    }
    await previewLibrarySound({
      entry: entryFor('Choir/bound.wav', bytes, 'loop'),
      toRate: rate,
      token: 7,
      fetchImpl,
      engine,
    })
    expect(engine.fed).toBeGreaterThan(0)
    expect(engine.looped).toBe(1)
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })

  it('refuses the asset until the passphrase signs it', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    clearLibraryAccessKey()
    const bytes = wavBytes(tone(1200, 48000, 440), 48000)
    const audioHits = { n: 0 }
    const fetchImpl = libraryFetch(bytes, 1_000_000, 'owner-pass', audioHits)
    const entry = entryFor('Drums/locked.wav', bytes)
    await expect(streamLibraryAsset({
      entry,
      toRate: 48000,
      fetchImpl,
      onSlice: () => undefined,
    })).rejects.toThrow(/Unlock/)
    expect(audioHits.n).toBe(0)

    writeLibraryAccessKey('nope')
    await expect(streamLibraryAsset({
      entry,
      toRate: 48000,
      fetchImpl,
      onSlice: () => undefined,
    })).rejects.toBeInstanceOf(LibraryAuthError)
    expect(audioHits.n).toBe(0)
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })

  it('joins Slow 4G slices into the same sinc decode and starts before a full download', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    writeLibraryAccessKey('owner-pass')
    const rate = 96000
    const channel = tone(Math.round(rate * 0.45), rate, 440)
    const bytes = wavBytes(channel, rate)
    const audioHits = { n: 0 }
    const fetchImpl = libraryFetch(bytes, SLOW_4G_BYTES_PER_SEC, 'owner-pass', audioHits)
    const entry = entryFor('Drums/slow-96k.wav', bytes)
    const emissions: { at: number; channels: Float32Array[]; sampleRate: number }[] = []
    const started = performance.now()
    await streamLibraryAsset({
      entry,
      toRate: 48000,
      fetchImpl,
      onSlice: (slice) => {
        emissions.push({ at: performance.now(), channels: slice.channels.map((item) => Float32Array.from(item)), sampleRate: slice.sampleRate })
      },
    })
    const streamMs = (emissions[0]?.at ?? performance.now()) - started
    expect(audioHits.n).toBeGreaterThan(0)
    const decoded = decodeWavPCM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
    const expected = resampleSinc(decoded.channels[0], Math.round(channel.length * 48000 / rate), 96)
    assertContinuous(emissions, expected)

    const serialStarted = performance.now()
    const response = await throttledFetch(bytes, SLOW_4G_BYTES_PER_SEC)()
    const downloaded = new Uint8Array(await response.arrayBuffer())
    const serialDecoded = decodeWavPCM(downloaded.buffer)
    resampleSinc(serialDecoded.channels[0], Math.round(channel.length * 48000 / rate), 96)
    const serialMs = performance.now() - serialStarted
    const timing = {
      link: 'Slow 4G',
      bytes: bytes.byteLength,
      fileRate: rate,
      playRate: 48000,
      beforeMs: Math.round(serialMs),
      afterMs: Math.round(streamMs),
      slices: emissions.length,
    }
    writeFileSync('/tmp/library-preview-timing.json', JSON.stringify(timing, null, 2))
    expect(streamMs).toBeLessThanOrEqual(serialMs + 80)
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  }, 20_000)

  it('keeps several fast slices continuous', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    writeLibraryAccessKey('owner-pass')
    const rate = 48000
    const channel = tone(Math.round(rate * 1.2), rate, 220)
    const bytes = wavBytes(channel, rate)
    const fetchImpl = libraryFetch(bytes, 400_000, 'owner-pass', { n: 0 })
    const emissions: { at: number; channels: Float32Array[]; sampleRate: number }[] = []
    await streamLibraryAsset({
      entry: entryFor('Drums/fast.wav', bytes),
      toRate: rate,
      fetchImpl,
      onSlice: (slice) => {
        emissions.push({ at: performance.now(), channels: slice.channels.map((item) => Float32Array.from(item)), sampleRate: slice.sampleRate })
      },
    })
    expect(emissions.length).toBeGreaterThan(1)
    assertContinuous(emissions, decodeWavPCM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)).channels[0])
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  }, 20_000)

  it('loops a library loop and leaves a one-shot as one play-through', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    writeLibraryAccessKey('owner-pass')
    const rate = 48000
    const channel = tone(1800, rate, 330)
    const bytes = wavBytes(channel, rate)
    const fetchImpl = libraryFetch(bytes, 2_000_000, 'owner-pass', { n: 0 })
    const fed: number[] = []
    let looped = false
    let pcmLoop: boolean | null = null
    let heardGain = 0
    let loopGain = 0
    const engine = {
      stopPreview() {},
      previewPcm(_channels: Float32Array[], _sampleRate?: number, loop?: boolean) { pcmLoop = loop ?? false },
      feedPreview(_token: number, slice: Float32Array[]) {
        fed.push(slice[0]?.length ?? 0)
        return true
      },
      setPreviewGain(_token: number, gain: number) { heardGain = gain },
      continuePreviewLoop(_token: number, _channels: Float32Array[], _sampleRate: number, gain = 0.8) {
        looped = true
        loopGain = gain
        return true
      },
    }
    await previewLibrarySound({
      entry: entryFor('Choir/pad.wav', bytes, 'loop'),
      toRate: rate,
      token: 1,
      fetchImpl,
      engine,
    })
    expect(fed.length).toBeGreaterThan(0)
    expect(looped).toBe(true)
    expect(loopGain).toBeCloseTo(heardGain, 5)
    expect(loopGain).toBeLessThan(0.8)
    expect(pcmLoop).toBeNull()

    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    fed.length = 0
    pcmLoop = null
    const once = {
      stopPreview() {},
      previewPcm(_channels: Float32Array[], _sampleRate?: number, loop?: boolean) { pcmLoop = loop ?? false },
      feedPreview(_token: number, slice: Float32Array[]) {
        fed.push(slice[0]?.length ?? 0)
        return true
      },
      setPreviewGain() {},
      continuePreviewLoop() { return true },
    }
    await previewLibrarySound({
      entry: entryFor('Drums/hat.wav', bytes, 'one-shot'),
      toRate: rate,
      token: 2,
      fetchImpl,
      engine: once,
    })
    expect(fed.length).toBeGreaterThan(0)
    expect(pcmLoop).toBeNull()

    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    pcmLoop = null
    await previewLibrarySound({
      entry: entryFor('Choir/again.wav', bytes, 'loop'),
      toRate: rate,
      token: 3,
      fetchImpl,
      engine: {
        stopPreview() {},
        previewPcm(_channels: Float32Array[], _sampleRate?: number, loop?: boolean) { pcmLoop = loop ?? false },
        feedPreview() { return true },
        setPreviewGain() {},
      },
    })
    expect(pcmLoop).toBe(true)

    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    const cancelled: string[] = []
    const controller = new AbortController()
    const pending = previewLibrarySound({
      entry: entryFor('Choir/cancel.wav', bytes, 'loop'),
      toRate: rate,
      token: 4,
      signal: controller.signal,
      fetchImpl,
      engine: {
        stopPreview() { cancelled.push('stop') },
        previewPcm() { cancelled.push('pcm') },
        feedPreview() { cancelled.push('feed'); return true },
        setPreviewGain() {},
        continuePreviewLoop() { cancelled.push('loop'); return true },
      },
    })
    controller.abort()
    await pending.catch((error: unknown) => {
      if (!(error instanceof DOMException) || error.name !== 'AbortError') throw error
    })
    expect(cancelled).not.toContain('pcm')
    expect(cancelled).not.toContain('loop')
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })

  it('plays a file the wav streamer cannot read through the library decoder', async () => {
    resetSoundDownloads()
    resetLibrarySoundMemory()
    setLibraryCaches({ audio: memoryAudioCache() })
    writeLibraryAccessKey('owner-pass')
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const fetchImpl = libraryFetch(junk, 1_000_000, 'owner-pass', { n: 0 })
    const played: { channels: Float32Array[]; loop: boolean }[] = []
    await previewLibrarySound({
      entry: entryFor('FX/impactGlass heavy 004.wav', junk, 'sfx'),
      toRate: 48000,
      token: 9,
      fetchImpl,
      decode: async () => ({ sampleRate: 48000, channels: [Float32Array.from([0.25, -0.25])] }),
      engine: {
        stopPreview() {},
        previewPcm(channels, _sampleRate, loop) { played.push({ channels, loop: loop === true }) },
      },
    })
    expect(played).toHaveLength(1)
    expect(played[0].loop).toBe(false)
    expect(played[0].channels[0]).toEqual(Float32Array.from([0.25, -0.25]))
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })
})

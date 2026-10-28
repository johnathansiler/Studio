import { describe, expect, it } from 'vitest'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { capGigabytes } from '../model/usage'
import { alignedRecordWindow } from '../model/latency'
import {
  assembleTakeWav,
  bytesToArrayBuffer,
  chooseTakePath,
  chunkBytes,
  clockOffsetForTake,
  packTakeChunk,
  readTakeChunk,
  relayPairBytes,
  sumRelayBytes,
  TAKE_CHUNK_BYTES,
  takeProgress,
  takeRelayCredit,
} from '../remote/hqTake'
import { createEmptyProject, type AudioClip } from '../model/types'
import { ProjectStore } from '../state/store'

function clip(patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'guide',
    name: 'Live guide',
    bufferId: 'low',
    startSample: 1000,
    offsetSamples: 0,
    durationSamples: 480,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'guide',
    takeId: 'take-1',
    peerId: 'guest-1',
    ...patch,
  }
}

describe('guest full-quality take transfer', () => {
  it('prefers the data channel and does not bill the server fallback as Cloudflare', () => {
    expect(chooseTakePath(true)).toBe('data')
    expect(chooseTakePath(false)).toBe('server')
    const relay = [{ selected: true, candidateType: 'relay' as const, bytesSent: 8_000, bytesReceived: 200 }]
    expect(takeRelayCredit('data', relay)).toBe(8_200)
    expect(takeRelayCredit('server', relay)).toBe(0)
    expect(capGigabytes('750')).toBe(750)
    expect(capGigabytes(undefined)).toBe(500)
  })

  it('counts only a selected relay pair', () => {
    expect(relayPairBytes({ selected: true, candidateType: 'host', bytesSent: 50_000, bytesReceived: 50_000 })).toBe(0)
    expect(relayPairBytes({ selected: false, candidateType: 'relay', bytesSent: 50_000, bytesReceived: 1 })).toBe(0)
    expect(sumRelayBytes([
      { selected: true, candidateType: 'srflx', bytesSent: 10, bytesReceived: 10 },
      { selected: true, candidateType: 'relay', bytesSent: 100, bytesReceived: 40 },
    ])).toBe(140)
  })

  it('uses the signaling clock when the data channel has no sample yet', () => {
    expect(clockOffsetForTake(12, 40)).toBe(12)
    expect(clockOffsetForTake(null, 40)).toBe(40)
    expect(clockOffsetForTake(undefined, null)).toBeNull()
  })

  it('round-trips a 24-bit take in order, with progress', () => {
    const audio = Float32Array.from({ length: 3000 }, (_, index) => Math.sin(index / 12) * 0.4)
    const wav = new Uint8Array(encodeWav([audio], 48000, { bits: 24, dither: 'none' }))
    expect(TAKE_CHUNK_BYTES).toBe(16 * 1024)
    const pieces = chunkBytes(wav, 1024)
    expect(pieces.length).toBeGreaterThan(1)
    const parts: Array<Uint8Array | undefined> = []
    pieces.forEach((piece, index) => {
      const packet = packTakeChunk(index, pieces.length, piece)
      const read = readTakeChunk(bytesToArrayBuffer(packet))
      expect(read?.index).toBe(index)
      expect(read?.total).toBe(pieces.length)
      parts[index] = read?.bytes
      expect(takeProgress(index + 1, pieces.length)).toBeCloseTo((index + 1) / pieces.length)
    })
    const hole = parts.slice()
    hole[1] = undefined
    expect(assembleTakeWav(hole, pieces.length)).toBeNull()
    const joined = assembleTakeWav(parts, pieces.length)
    expect(joined).not.toBeNull()
    const decoded = decodeWavPCM(bytesToArrayBuffer(joined!))
    expect(decoded.sampleRate).toBe(48000)
    expect(decoded.channels[0][100]).toBeCloseTo(audio[100], 4)
  })

  it('places the aligned take on the host grid and drops the live guide', () => {
    const window = alignedRecordWindow({
      recordStartSample: 4800,
      recordEndSample: 9600,
      sampleRate: 48000,
      cueEpochHostPerfMs: 10_000,
      cueEpochTimelineSample: 4800,
      oneWayCueMs: 20,
      guestInputLatencyMs: 10,
      clockOffsetMs: 5,
    })
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    track.input = 'remote:guest-1'
    track.clips.push(clip({ startSample: 1000 }))
    store.buffers.set('low', { id: 'low', name: 'guide', sampleRate: 48000, channels: [new Float32Array(480)] })
    const hq = Float32Array.from({ length: 4800 }, () => 0.25)
    store.acceptAlignedTake({
      peerId: 'guest-1',
      peerName: 'Ava',
      takeId: 'take-1',
      placeAtSample: window.placeAtSample,
      sampleRate: 48000,
      channels: [hq],
      compensationMs: window.compensationMs,
      detail: '24-bit local mic',
      silent: false,
    })
    const clips = store.project.tracks[0].clips
    expect(clips.some((item) => item.source === 'guide' && item.takeId === 'take-1')).toBe(false)
    const aligned = clips.find((item) => item.source === 'aligned-take' || item.folder?.lanes.some((lane) => lane.source === 'aligned-take'))
    expect(aligned).toBeTruthy()
    expect(aligned?.startSample).toBe(4800)
    expect(aligned?.takeId === 'take-1' || aligned?.folder?.lanes.some((lane) => lane.takeId === 'take-1')).toBe(true)
    const asset = [...store.buffers.values()].find((item) => item.name === 'Ava take')
    expect(asset?.channels[0][0]).toBeCloseTo(0.25)
    expect(store.sync.peek().some((op) => op.p.includes('clips'))).toBe(true)
    expect(store.toasts.some((toast) => toast.text.includes('Ava aligned'))).toBe(true)
  })

  it('keeps a session slot pointed at the replacement, not the guide', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    track.input = 'remote:guest-1'
    store.placeInSlot(track.id, 1, clip({ id: 'slot-guide', slotOnly: true, startSample: 0 }))
    store.acceptAlignedTake({
      peerId: 'guest-1',
      peerName: 'Ava',
      takeId: 'take-1',
      placeAtSample: 2400,
      sampleRate: 48000,
      channels: [new Float32Array(1200)],
      compensationMs: 15,
      detail: '24-bit local mic',
    })
    const next = store.project.tracks.find((item) => item.id === track.id)!
    expect(next.clips.some((item) => item.id === 'slot-guide')).toBe(false)
    const slotId = next.audioSlots?.[1]
    const slotted = next.clips.find((item) => item.id === slotId)
    expect(slotted).toBeTruthy()
    expect(slotted?.source).not.toBe('guide')
  })
})

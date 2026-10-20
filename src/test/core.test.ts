import { describe, expect, it } from 'vitest'
import { splitAudioClip, trimAudioClip } from '../model/clips'
import { renderDemoLoop, computePeaks } from '../model/demo'
import {
  alignedRecordWindow,
  bestClockSample,
  decodePcmFrame,
  encodePcmFrame,
  estimateCueOneWayMs,
  findPeakOffset,
  fitPerfAtContextZero,
  jamDelays,
  matchPingDelay,
  ntpOffset,
  shiftPlacementForLateBuffer,
  sliceChunksByPerf,
} from '../model/latency'
import { DEFAULT_OPUS, mungeOpusSdp } from '../model/sdp'
import { formatBarsBeats, formatTimecode, samplesToMusical, snapSample } from '../model/time'
import { decodeWavPCM, encodeWav, linearResample, parseWavHeader } from '../model/wav'
import { ProjectStore, seedDemoProject } from '../state/store'
import type { AudioClip } from '../model/types'

const clip = (patch: Partial<AudioClip> = {}): AudioClip => ({
  id: 'c1',
  name: 'Vocal',
  bufferId: 'b1',
  startSample: 1000,
  offsetSamples: 100,
  durationSamples: 500,
  fadeInSamples: 20,
  fadeOutSamples: 30,
  gain: 1,
  source: 'local',
  ...patch,
})

describe('musical time', () => {
  const sig = { numerator: 4, denominator: 4 }
  it('maps 120bpm 48k to bars and beats', () => {
    expect(formatBarsBeats(0, 48000, 120, sig)).toBe('1.1.000')
    expect(formatBarsBeats(24000, 48000, 120, sig)).toBe('1.2.000')
    expect(formatBarsBeats(96000, 48000, 120, sig)).toBe('2.1.000')
    expect(formatTimecode(48000, 48000, 30)).toBe('00:00:01:00')
  })

  it('counts 6/8 in eighth-note beats', () => {
    const six = { numerator: 6, denominator: 8 }
    const pos = samplesToMusical(12000, 48000, 120, six)
    expect(pos.bar).toBe(1)
    expect(pos.beat).toBe(2)
    expect(pos.tick).toBe(0)
  })

  it('snaps to quarter notes when enabled', () => {
    expect(snapSample(100, 48000, 120, false)).toBe(100)
    expect(snapSample(24000 + 100, 48000, 120, true)).toBe(24000)
  })
})

describe('clip editing', () => {
  it('splits a clip and preserves the buffer offset', () => {
    const parts = splitAudioClip(clip(), 1200)
    expect(parts).not.toBeNull()
    const [left, right] = parts!
    expect(left.durationSamples).toBe(200)
    expect(right.startSample).toBe(1200)
    expect(right.offsetSamples).toBe(300)
    expect(right.durationSamples).toBe(300)
    expect(left.fadeOutSamples).toBe(0)
    expect(right.fadeInSamples).toBe(0)
  })

  it('refuses a split outside the clip', () => {
    expect(splitAudioClip(clip(), 1000)).toBeNull()
    expect(splitAudioClip(clip(), 1600)).toBeNull()
  })

  it('trims without reading past the buffer', () => {
    const trimmed = trimAudioClip(clip(), 'start', 1100, 10000)
    expect(trimmed.startSample).toBe(1100)
    expect(trimmed.offsetSamples).toBe(200)
    expect(trimmed.durationSamples).toBe(400)
    const end = trimAudioClip(clip(), 'end', 1400, 10000)
    expect(end.durationSamples).toBe(400)
  })
})

describe('latency compensation', () => {
  it('computes the NTP offset that turns guest time into host time', () => {
    expect(ntpOffset(0, 10, 10, 20)).toEqual({ rtt: 20, offset: 0 })
    const skewed = ntpOffset(100, 130, 132, 150)
    expect(skewed.rtt).toBe(48)
    expect(skewed.offset).toBe(6)
  })

  it('keeps the lowest-RTT clock sample', () => {
    expect(
      bestClockSample([
        { rtt: 30, offset: 4 },
        { rtt: 12, offset: 5 },
        { rtt: 40, offset: 1 },
      ]),
    ).toEqual({ rtt: 12, offset: 5 })
  })

  it('estimates the cue path and its uncertainty', () => {
    const stats = estimateCueOneWayMs({
      rttMs: 40,
      jitterBufferMs: 8,
      ptimeMs: 10,
      outputLatencyMs: 12,
      mode: 'opus',
    })
    expect(stats.ms).toBe(45)
    expect(stats.uncertaintyMs).toBe(8)
    expect(stats.source).toBe('stats')

    const ping = estimateCueOneWayMs({
      rttMs: 40,
      jitterBufferMs: 8,
      ptimeMs: 10,
      outputLatencyMs: 12,
      audioPingMs: 28,
      mode: 'opus',
    })
    expect(ping.ms).toBe(40)
    expect(ping.source).toBe('audio-ping')

    const pcm = estimateCueOneWayMs({
      rttMs: 40,
      jitterBufferMs: 0,
      ptimeMs: 10,
      outputLatencyMs: 8,
      pcmNetworkMs: 9,
      pcmTargetMs: 20,
      mode: 'pcm',
    })
    expect(pcm.ms).toBe(37)
    expect(pcm.source).toBe('pcm')
  })

  it('places a guest take on the musical grid instead of the network arrival', () => {
    const window = alignedRecordWindow({
      recordStartSample: 48000,
      recordEndSample: 96000,
      sampleRate: 48000,
      cueEpochHostPerfMs: 1000,
      cueEpochTimelineSample: 48000,
      oneWayCueMs: 30,
      guestInputLatencyMs: 10,
      clockOffsetMs: 5,
    })
    expect(window.compensationMs).toBe(40)
    expect(window.guestPerfStart).toBe(1035)
    expect(window.guestPerfEnd).toBe(2035)
    expect(window.placeAtSample).toBe(48000)
    expect(shiftPlacementForLateBuffer(48000, 1035, 1050, 48000)).toBe(48000 + 720)
  })

  it('slices the pre-roll buffer on performance timestamps', () => {
    const data = new Float32Array(1000)
    data[200] = 0.5
    const sliced = sliceChunksByPerf([{ perfStart: 1000, data, sampleRate: 1000 }], 1200, 1700)
    expect(sliced?.audio.length).toBe(500)
    expect(sliced?.audio[0]).toBe(0.5)
    expect(sliced?.actualPerfStart).toBe(1200)
  })

  it('finds a loopback impulse and a ping pattern', () => {
    const recorded = new Float32Array(8000)
    recorded[5000] = 0.9
    expect(findPeakOffset(recorded, 1000, 1000)).toBe(4000)
    const delay = matchPingDelay(
      [
        { perf: 130, mag: 1 },
        { perf: 535, mag: 1 },
        { perf: 928, mag: 1 },
      ],
      [100, 500, 900],
    )
    expect(delay).toBe(30)
  })

  it('delays host monitoring in jam mode without delaying the cue', () => {
    expect(jamDelays(false, 50, 30)).toEqual({ localMonitorMs: 0, remoteExtraMs: 0 })
    expect(jamDelays(true, 50, 30)).toEqual({ localMonitorMs: 50, remoteExtraMs: 20 })
    expect(jamDelays(true, 20, 30)).toEqual({ localMonitorMs: 20, remoteExtraMs: 0 })
  })

  it('round-trips a PCM frame and fits the audio clock', () => {
    const samples = new Float32Array([0.1, -0.2, 0.3])
    const decoded = decodePcmFrame(encodePcmFrame(7, 1234.5, samples))
    expect(decoded?.seq).toBe(7)
    expect(decoded?.senderPerfMs).toBe(1234.5)
    decoded!.samples.forEach((sample, index) => expect(sample).toBeCloseTo([0.1, -0.2, 0.3][index], 5))
    expect(fitPerfAtContextZero([{ ctx: 2, perf: 5000 }])).toBe(3000)
  })
})

describe('opus sdp and wav', () => {
  it('forces 10ms stereo opus with DTX off', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
      'a=ptime:20',
      'a=maxptime:20',
      '',
    ].join('\r\n')
    const munged = mungeOpusSdp(sdp, DEFAULT_OPUS)
    expect(munged).toContain('a=ptime:10')
    expect(munged).toContain('a=maxptime:10')
    expect(munged).not.toContain('a=ptime:20')
    expect(munged).toContain('usedtx=0')
    expect(munged).toContain('stereo=1')
    expect(munged).toContain('sprop-stereo=1')
    expect(munged).toContain('maxaveragebitrate=510000')
    expect(munged).toContain('useinbandfec=1')
    expect(munged).toContain('cbr=1')
  })

  it('can turn FEC off', () => {
    const munged = mungeOpusSdp('m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n', {
      ...DEFAULT_OPUS,
      fec: false,
    })
    expect(munged).toContain('useinbandfec=0')
  })

  it('round-trips 16-bit wav and resamples', () => {
    const tone = new Float32Array(480)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((i / 48) * Math.PI)
    const wav = encodeWav([tone, tone.map((v) => -v)], 48000)
    const info = parseWavHeader(wav)
    expect(info.sampleRate).toBe(48000)
    expect(info.channels).toBe(2)
    expect(info.bits).toBe(16)
    const decoded = decodeWavPCM(wav)
    expect(decoded.channels[0][0]).toBeCloseTo(tone[0], 2)
    expect(decoded.channels[1][10]).toBeCloseTo(-tone[10], 2)
    const half = linearResample(tone, 48000, 24000)
    expect(half.length).toBe(240)
  })
})

describe('project store', () => {
  it('undoes a tempo change and keeps the demo clip', () => {
    const music = renderDemoLoop(48000, 1, 120)
    expect(music.some((sample) => Math.abs(sample) > 0.1)).toBe(true)
    const seeded = seedDemoProject(48000, music)
    const store = new ProjectStore(seeded.project, seeded.buffers)
    expect(store.project.tracks[1].clips).toHaveLength(1)
    store.setTempo(140)
    expect(store.project.tempo).toBe(140)
    store.undo()
    expect(store.project.tempo).toBe(120)
    store.redo()
    expect(store.project.tempo).toBe(140)
    const peaks = computePeaks(music, 8)
    expect(peaks).toHaveLength(8)
    expect(peaks.some((peak) => peak.max > 0)).toBe(true)
  })

  it('retargets clip positions when the audio device rate differs', () => {
    const seeded = seedDemoProject(48000, new Float32Array([0, 0.5, -0.5, 0]))
    const store = new ProjectStore(seeded.project, seeded.buffers)
    const before = store.project.tracks[1].clips[0].durationSamples
    store.retargetSampleRate(24000)
    expect(store.project.sampleRate).toBe(24000)
    expect(store.project.tracks[1].clips[0].durationSamples).toBe(Math.round(before / 2))
    expect(store.buffers.get(store.project.tracks[1].clips[0].bufferId)?.channels[0].length).toBe(2)
  })
})

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
import { DEFAULT_OPUS, mungeOpusSdp, videoDirectionsFromSdp } from '../model/sdp'
import { rememberDiag, sanitizeDiag } from '../model/diag'
import { arrangementDigest, assetChunkCount, ASSET_CHUNK_BYTES, catchUpSchedule, guestMayRequest, guestStartPerf, mediaCanCarryAssets, referencedBufferIds, scheduleLeadMs } from '../model/sessionSync'
import { cameraAttempts, DEFAULT_VIDEO_BITRATE, legalDirection, orderVideoCodecs, outboundVideoCodecs, scaleResolutionDownBy, shouldSetVideoCodecPreferences, videoDirection, videoEncodingBudget, videoTargetForBwe } from '../model/codecs'
import { ensureCellularTurn, filterBrowserTurnUrls, isSilentTake, mediaStatus, nextRelayGather, queueIceCandidate, staticTurnServer, tcpRelayIceServers, udpIceServers } from '../model/media'
import { answerMatches, enqueueSignal, iceDisconnectLimit, ICE_INITIAL_GATHER_MS, ICE_RESTART_VIDEO_HOLD_MS, ICE_TCP_DISCONNECT_RESTART_MS, ICE_UDP_DISCONNECT_RESTART_MS, iceRecoveryAction, ignoreIncomingOffer, inviteWins, keepPeerConnection, repeatedOffer, sessionHello, SIGNAL_KEEPALIVE_MS, socketMayOpen } from '../model/negotiate'
import { isQuotaError } from '../storage/idb'
import { clearIceCache, currentIce } from '../../server/ice.ts'
import { formatBarsBeats, formatTimecode, samplesToMusical, snapSample } from '../model/time'
import { decodeWavPCM, encodeWav, linearResample, parseWavHeader } from '../model/wav'
import { ProjectStore, seedDemoProject } from '../state/store'
import { createEmptyProject, makeTrack } from '../model/types'
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

describe('shared session transport', () => {
  it('waits long enough for the guest to receive the downbeat', () => {
    expect(scheduleLeadMs(10)).toBe(120)
    expect(scheduleLeadMs(100)).toBe(180)
    expect(scheduleLeadMs(900)).toBe(400)
  })

  it('maps the host performance clock onto the guest', () => {
    expect(guestStartPerf(5_000, 40)).toBe(4_960)
  })

  it('skips ahead when the start arrives late', () => {
    const next = catchUpSchedule({ targetPerf: 1_000, nowPerf: 1_100, sample: 48_000, sampleRate: 48_000 })
    expect(next.sample).toBe(52_800)
    expect(next.perf).toBe(1_100)
    expect(catchUpSchedule({ targetPerf: 2_000, nowPerf: 2_000, sample: 10, sampleRate: 48_000 }).sample).toBe(10)
  })

  it('lets a guest request play, stop, and locate, and leaves record to the host', () => {
    expect(guestMayRequest('play')).toBe(true)
    expect(guestMayRequest('stop')).toBe(true)
    expect(guestMayRequest('seek')).toBe(true)
    expect(guestMayRequest('record-start')).toBe(false)
  })

  it('fingerprints the arrangement without the audio samples', () => {
    const project = createEmptyProject(48000, 'Sync')
    const track = makeTrack({ name: 'Music', type: 'audio' })
    track.clips = [
      {
        id: 'c',
        name: 'Loop',
        bufferId: 'buf',
        startSample: 0,
        offsetSamples: 0,
        durationSamples: 1000,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 1,
        source: 'demo',
      },
    ]
    project.tracks = [track]
    expect(arrangementDigest(project)).toBe(arrangementDigest(structuredClone(project)))
    const changed = structuredClone(project)
    changed.tempo = 100
    expect(arrangementDigest(project)).not.toBe(arrangementDigest(changed))
    expect(referencedBufferIds(project)).toEqual(['buf'])
  })

  it('keeps a following guest from editing the host arrangement', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const tempo = store.project.tempo
    store.remoteFollow = true
    store.setTempo(90)
    expect(store.project.tempo).toBe(tempo)
  })
})

describe('video codecs', () => {
  it('keeps H.264 and puts it ahead of VP8', () => {
    const ordered = orderVideoCodecs([
      { mimeType: 'video/AV1' },
      { mimeType: 'video/VP8' },
      { mimeType: 'video/H264' },
      { mimeType: 'video/rtx' },
    ])
    expect(ordered.map((codec) => codec.mimeType)).toEqual(['video/H264', 'video/VP8', 'video/AV1', 'video/rtx'])
  })

  it('offers H.264 and VP8 to an iPhone and leaves AV1 out', () => {
    const offered = outboundVideoCodecs([
      { mimeType: 'video/VP8' },
      { mimeType: 'video/rtx' },
      { mimeType: 'video/AV1' },
      { mimeType: 'video/H264' },
      { mimeType: 'video/rtx' },
      { mimeType: 'video/VP9' },
    ])
    expect(offered.map((codec) => codec.mimeType)).toEqual(['video/H264', 'video/rtx', 'video/VP8', 'video/rtx'])
  })

  it('does not call setCodecPreferences on Safari, where that drops H.264', () => {
    expect(shouldSetVideoCodecPreferences('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe(false)
    expect(shouldSetVideoCodecPreferences('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0.0.0 Mobile Safari/537.36')).toBe(true)
  })

  it('does not ask Safari for an exact camera device', () => {
    const attempts = cameraAttempts('cam-1')
    expect(JSON.stringify(attempts)).not.toMatch(/exact/)
    expect(attempts[0]).toMatchObject({
      deviceId: { ideal: 'cam-1' },
      facingMode: 'user',
      width: { ideal: 640, max: 854 },
      height: { ideal: 360, max: 480 },
      frameRate: { ideal: 15, max: 15 },
    })
    expect(attempts.at(-1)).toEqual({})
    expect(scaleResolutionDownBy(1280, 720)).toBeGreaterThan(1)
    expect(scaleResolutionDownBy(320, 240)).toBe(1)
    expect(scaleResolutionDownBy(854, 480, 480)).toBe(1)
    expect(scaleResolutionDownBy(1280, 720, 480)).toBeGreaterThan(1)
    expect(videoDirection(true, false)).toBe('sendonly')
    expect(videoDirection(false, true)).toBe('recvonly')
    expect(videoDirection(false, false)).toBe('inactive')
    expect(legalDirection('sendrecv', 'sendonly')).toBe('recvonly')
    expect(legalDirection('sendonly', 'sendonly')).toBe('inactive')
    expect(legalDirection('sendrecv', 'recvonly')).toBe('sendonly')
    expect(legalDirection('sendrecv', null)).toBe('sendrecv')
  })
})

describe('media path', () => {
  it('keeps an ICE candidate that arrives before the remote description', () => {
    const queued = queueIceCandidate(false, [], { candidate: 'a' })
    expect(queued.apply).toEqual([])
    expect(queued.pending).toEqual([{ candidate: 'a' }])
    const flushed = queueIceCandidate(true, queued.pending, { candidate: 'b' })
    expect(flushed.apply.map((item) => item.candidate)).toEqual(['a', 'b'])
    expect(flushed.pending).toEqual([])
  })

  it('keeps cellular TCP and TLS TURN and drops port 53 and UDP 443', () => {
    expect(filterBrowserTurnUrls([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:53?transport=udp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turn:turn.cloudflare.com:443?transport=udp',
      'turn:turn.cloudflare.com:443?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ])).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turn:turn.cloudflare.com:443?transport=tcp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ])
    expect(ensureCellularTurn([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp',
    ])).toEqual([
      'turn:turn.cloudflare.com:3478?transport=udp',
      'turns:turn.cloudflare.com:443?transport=tcp',
      'turn:turn.cloudflare.com:80?transport=tcp',
      'turn:turn.cloudflare.com:443?transport=tcp',
    ])
    expect(ensureCellularTurn(['stun:stun.l.google.com:19302'])).toEqual(['stun:stun.l.google.com:19302'])
    expect(tcpRelayIceServers([
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turn:turn.cloudflare.com:443?transport=udp',
          'turn:turn.cloudflare.com:443?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'u',
        credential: 'c',
      },
    ])).toEqual([
      {
        urls: ['turn:turn.cloudflare.com:443?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'u',
        credential: 'c',
      },
    ])
    expect(tcpRelayIceServers([{ urls: 'turn:turn.cloudflare.com:3478?transport=udp', username: 'u', credential: 'c' }])).toEqual([])
    expect(udpIceServers([
      {
        urls: [
          'stun:stun.l.google.com:19302',
          'turn:turn.cloudflare.com:3478?transport=udp',
          'turn:turn.cloudflare.com:80?transport=tcp',
          'turn:turn.cloudflare.com:443?transport=tcp',
          'turns:turn.cloudflare.com:443?transport=tcp',
        ],
        username: 'u',
        credential: 'c',
      },
    ])).toEqual([
      {
        urls: ['stun:stun.l.google.com:19302', 'turn:turn.cloudflare.com:3478?transport=udp'],
        username: 'u',
        credential: 'c',
      },
    ])
    const budget = videoEncodingBudget()
    expect(budget.maxBitrate).toBe(DEFAULT_VIDEO_BITRATE)
    expect(budget.maxBitrate).toBe(100_000)
    expect(budget.maxFramerate).toBe(15)
    expect(budget.priority).toBe('medium')
    expect(videoTargetForBwe(0)).toEqual({ maxBitrate: 100_000, height: 240 })
    expect(videoTargetForBwe(243_000)).toEqual({ maxBitrate: 100_000, height: 240 })
    expect(videoTargetForBwe(800_000)).toEqual({ maxBitrate: 100_000, height: 240 })
    expect(videoTargetForBwe(1_500_000).maxBitrate).toBe(250_000)
    expect(videoTargetForBwe(1_500_000).height).toBe(480)
    const gather = { onTcpRelay: false, sawUdpPair: false, tcpFallback: false, udpMisses: 0 }
    expect(nextRelayGather(gather, true, true)).toEqual({ servers: 'same', state: { ...gather, udpMisses: 1 } })
    expect(nextRelayGather({ ...gather, udpMisses: 1 }, true, true)).toEqual({
      servers: 'both',
      state: { ...gather, udpMisses: 2, tcpFallback: true },
    })
    expect(nextRelayGather({ ...gather, udpMisses: 1 }, true, false).servers).toBe('same')
    expect(nextRelayGather({ ...gather, sawUdpPair: true }, true, true).servers).toBe('same')
    expect(nextRelayGather({ onTcpRelay: true, sawUdpPair: false, tcpFallback: true, udpMisses: 2 }, true, true)).toEqual({
      servers: 'udp',
      state: { onTcpRelay: false, sawUdpPair: false, tcpFallback: false, udpMisses: 0 },
    })
    expect(DEFAULT_OPUS.maxAverageBitrate).toBe(510000)
    expect(staticTurnServer('turn:127.0.0.1:3478,turns:127.0.0.1:5349', 'cue', 'harbor').urls).toEqual([
      'turn:127.0.0.1:3478',
      'turns:127.0.0.1:5349',
    ])
  })

  it('keeps the room and explains a failed media path without jargon', () => {
    const label = mediaStatus({
      turn: 'none',
      live: true,
      links: [{ connection: 'failed', ice: 'failed', path: 'unknown', ageMs: 15000 }],
    })
    expect(label?.tone).toBe('bad')
    expect(label?.text).toMatch(/still in the room/i)
    expect(label?.text).not.toMatch(/TURN|UDP|relay/i)
    const bytes = mediaStatus({
      turn: 'cloudflare',
      turnError: 'Cloudflare TURN failed',
      live: true,
      links: [{ connection: 'disconnected', ice: 'disconnected', path: 'direct', ageMs: 4000, videoBytes: 12000 }],
    })
    expect(bytes?.tone).toBe('good')
    expect(bytes?.text).toMatch(/connected/)
    const checking = mediaStatus({
      turn: 'cloudflare',
      live: true,
      links: [{ connection: 'connecting', ice: 'checking', path: 'unknown', ageMs: 15000 }],
    })
    expect(checking?.text).toMatch(/Connecting/)
    const iceUp = mediaStatus({
      turn: 'cloudflare',
      live: true,
      links: [{ connection: 'connecting', ice: 'connected', path: 'relay', ageMs: 15000 }],
    })
    expect(iceUp?.tone).toBe('good')
  })

  it('reads Cloudflare TURN credentials on the request that has them', async () => {
    clearIceCache()
    const env: NodeJS.ProcessEnv = {}
    const none = await currentIce(env, async () => {
      throw new Error('no fetch')
    })
    expect(none.turn).toBe('none')
    env.CF_TURN_KEY_ID = 'key'
    env.CF_TURN_API_TOKEN = 'token'
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response(JSON.stringify({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' }] }), { status: 201 })
    }
    const first = await currentIce(env, fetchImpl)
    const second = await currentIce(env, fetchImpl)
    expect(first.turn).toBe('cloudflare')
    const urls = first.iceServers.flatMap((server) => Array.isArray(server.urls) ? server.urls : [server.urls])
    expect(urls.some((url) => url.includes('3478'))).toBe(true)
    expect(urls.some((url) => url.includes(':53'))).toBe(false)
    expect(urls).toContain('turn:turn.cloudflare.com:80?transport=tcp')
    expect(urls).toContain('turn:turn.cloudflare.com:443?transport=tcp')
    expect(urls).toContain('turns:turn.cloudflare.com:443?transport=tcp')
    expect(second).toEqual(first)
    expect(calls).toBe(1)
    clearIceCache()
  })

  it('treats a flat line as a silent take', () => {
    expect(isSilentTake([new Float32Array(128)])).toBe(true)
    const loud = new Float32Array(128)
    loud[8] = 0.2
    expect(isSilentTake([loud])).toBe(false)
  })
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
    const stereo = sliceChunksByPerf([{ perfStart: 0, data: new Float32Array([0.2]), right: new Float32Array([-0.2]), sampleRate: 1000 }], 0, 1)
    expect(stereo?.right?.[0]).toBeCloseTo(-0.2)
    const wav = encodeWav(stereo?.right ? [stereo.audio, stereo.right] : [stereo!.audio], 48000)
    expect(String.fromCharCode(...new Uint8Array(wav).slice(0, 4))).toBe('RIFF')
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
    expect(munged).toContain('cbr=0')
    expect(munged).toContain('maxplaybackrate=48000')
    expect(munged).toContain('minptime=10')
    expect(munged).not.toMatch(/m=video[\s\S]*maxaveragebitrate/)
  })

  it('edits each Opus payload type only inside its own audio section', () => {
    const sdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10',
      'm=audio 9 UDP/TLS/RTP/SAVPF 109',
      'a=rtpmap:109 opus/48000/2',
      'a=fmtp:109 minptime=10',
      'm=video 9 UDP/TLS/RTP/SAVPF 102',
      'a=rtpmap:102 H264/90000',
      'a=sendonly',
      '',
    ].join('\r\n')
    const munged = mungeOpusSdp(sdp, DEFAULT_OPUS)
    const audio = munged.split('m=audio').slice(1)
    expect(audio[0]).toContain('a=fmtp:111 ')
    expect(audio[0]).not.toContain('a=fmtp:109 ')
    expect(audio[1]).toContain('a=fmtp:109 ')
    expect(audio[1]).not.toContain('a=fmtp:111 ')
    expect(audio[0]).toContain('maxaveragebitrate=510000')
    expect(audio[1]).toContain('stereo=1')
    expect(munged).not.toMatch(/m=video[\s\S]*a=fmtp:111/)
    expect(videoDirectionsFromSdp(munged)).toEqual(['sendonly'])
  })

  it('keeps a diagnostic snapshot free of media and secrets', () => {
    const clean = sanitizeDiag({
      at: 5,
      peerId: 'peer-1',
      role: 'guest',
      ua: 'Safari',
      sdp: 'v=0 ice-ufrag:secret',
      credential: 'do-not-keep',
      peers: [
        {
          id: 'peer-2',
          signaling: 'stable',
          ice: 'checking',
          connection: 'connecting',
          gathered: { host: 1, srflx: 2, relay: 3, prflx: 0 },
          selected: { local: 'relay', remote: 'relay', protocol: 'udp', relayProtocol: 'udp', url: 'turn:secret' },
          outbound: {
            framesPerSecond: 14.5,
            framesEncoded: 1200,
            bytes: 480000,
            packetsLost: 3,
            nackCount: 4,
            pliCount: 1,
            qualityLimitationReason: 'bandwidth',
            sdp: 'v=0 secret',
          },
          inbound: { framesPerSecond: 12, framesDecoded: 900, bytes: 300000, packetsLost: 2, nackCount: 1, pliCount: 0 },
          availableOutgoingBitrate: 250000,
          currentRoundTripTime: 0.182,
          errors: ['OperationError: Failed to set local answer sdp'],
          candidate: 'a=candidate secret',
        },
      ],
    })
    expect(clean?.peers[0].gathered.relay).toBe(3)
    expect(clean?.peers[0].selected).toEqual({ local: 'relay', remote: 'relay', protocol: 'udp', relayProtocol: 'udp' })
    expect(clean?.peers[0].outbound.framesPerSecond).toBe(14.5)
    expect(clean?.peers[0].outbound.framesEncoded).toBe(1200)
    expect(clean?.peers[0].outbound.bytes).toBe(480000)
    expect(clean?.peers[0].outbound.qualityLimitationReason).toBe('bandwidth')
    expect(clean?.peers[0].inbound.framesDecoded).toBe(900)
    expect(clean?.peers[0].inbound.packetsLost).toBe(2)
    expect(clean?.peers[0].availableOutgoingBitrate).toBe(250000)
    expect(clean?.peers[0].currentRoundTripTime).toBe(0.182)
    expect(clean?.peers[0].outbound).not.toHaveProperty('sdp')
    expect(JSON.stringify(clean)).not.toMatch(/secret|credential|candidate/)
    const log = rememberDiag([], clean!, 1)
    const next = rememberDiag(log, { ...clean!, at: 6 }, 1)
    expect(next).toHaveLength(1)
    expect(next[0].at).toBe(6)
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

describe('offer and answer', () => {
  it('ignores a colliding offer only on the impolite peer', () => {
    expect(ignoreIncomingOffer({ polite: false, makingOffer: true, signalingState: 'have-local-offer', settingRemoteAnswer: false })).toBe(true)
    expect(ignoreIncomingOffer({ polite: true, makingOffer: true, signalingState: 'have-local-offer', settingRemoteAnswer: false })).toBe(false)
    expect(ignoreIncomingOffer({ polite: false, makingOffer: false, signalingState: 'stable', settingRemoteAnswer: false })).toBe(false)
    expect(ignoreIncomingOffer({ polite: false, makingOffer: false, signalingState: 'have-local-offer', settingRemoteAnswer: true })).toBe(false)
  })

  it('lets an invite link win over a stored session code', () => {
    expect(inviteWins('mjlfh2', 'U279DV')).toEqual({ code: 'MJLFH2', dropStored: true })
    expect(inviteWins('', 'U279DV')).toEqual({ code: 'U279DV', dropStored: false })
    expect(inviteWins('U279DV', 'U279DV')).toEqual({ code: 'U279DV', dropStored: false })
    expect(keepPeerConnection({ left: false, remoteInstance: 'a', previousInstance: 'a' })).toBe(true)
    expect(keepPeerConnection({ left: false, remoteInstance: 'a', previousInstance: '' })).toBe(true)
    expect(keepPeerConnection({ left: true, remoteInstance: 'a', previousInstance: 'a' })).toBe(false)
    expect(keepPeerConnection({ left: false, remoteInstance: 'b', previousInstance: 'a' })).toBe(false)
  })

  it('rejoins a room this browser already hosts instead of minting another', () => {
    expect(sessionHello({ create: true })).toEqual({ action: 'create', reason: 'host tapped Create' })
    expect(sessionHello({ create: true, hostedCode: 'EEVEDR' }).action).toBe('join')
    expect(sessionHello({ create: true, hostedCode: 'EEVEDR' }).code).toBe('EEVEDR')
    expect(sessionHello({ create: true, hostedCode: 'EEVEDR' }).reason).toMatch(/already hosts EEVEDR/)
    expect(sessionHello({ create: false, requestedCode: 'eevedr', hostedCode: 'EEVEDR' }).reason).toMatch(/rejoined EEVEDR/)
    expect(sessionHello({ create: false, requestedCode: 'OTHER1', hostedCode: 'EEVEDR' })).toEqual({
      action: 'join',
      code: 'OTHER1',
      reason: 'request OTHER1',
    })
    expect(sessionHello({ create: false }).reason).toMatch(/no session code/)
    expect(sessionHello({ create: true, fresh: true, hostedCode: 'EEVEDR' })).toEqual({
      action: 'create',
      reason: 'host tapped New session',
    })
    expect(socketMayOpen(null)).toBe(true)
    expect(socketMayOpen(undefined)).toBe(true)
    expect(socketMayOpen(3)).toBe(true)
    expect(socketMayOpen(0)).toBe(false)
    expect(socketMayOpen(1)).toBe(false)
    expect(socketMayOpen(2)).toBe(false)
    expect(SIGNAL_KEEPALIVE_MS).toBeGreaterThanOrEqual(5000)
    expect(SIGNAL_KEEPALIVE_MS).toBeLessThanOrEqual(10000)
  })

  it('queues an ICE restart until the socket is welcomed and treats a resent offer as the same negotiation', () => {
    const offer = { t: 'signal', to: 'guest', data: { description: { type: 'offer' }, negotiationId: 2 } }
    const queued = enqueueSignal([{ t: 'ping' }], offer)
    expect(queued.map((item) => item.t)).toEqual(['ping', 'signal'])
    const replaced = enqueueSignal(queued, { t: 'signal', to: 'guest', data: { description: { type: 'offer' }, negotiationId: 3 } })
    expect(replaced.filter((item) => item.data?.description?.type === 'offer')).toHaveLength(1)
    expect(replaced.find((item) => item.t === 'signal')?.data?.negotiationId).toBe(3)
    expect(enqueueSignal(replaced, { t: 'hello' })).toBe(replaced)
    expect(repeatedOffer(3, 3)).toBe(true)
    expect(repeatedOffer(3, 4)).toBe(false)
    expect(answerMatches(3, 3)).toBe(true)
    expect(answerMatches(3, 2)).toBe(false)
    expect(answerMatches(3, undefined)).toBe(true)
    expect(ICE_UDP_DISCONNECT_RESTART_MS).toBe(8000)
    expect(ICE_TCP_DISCONNECT_RESTART_MS).toBe(2000)
    expect(ICE_RESTART_VIDEO_HOLD_MS).toBe(2000)
    expect(iceDisconnectLimit(false)).toBe(8000)
    expect(iceDisconnectLimit(true)).toBe(2000)
    expect(iceRecoveryAction({ polite: true, connection: 'failed', ice: 'failed', signaling: 'stable' })).toBe('none')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 1000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable' })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 2000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 2000, tcpRelay: true })).toBe('restart')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 8000 })).toBe('restart')
    expect(ICE_INITIAL_GATHER_MS).toBe(20000)
    expect(iceRecoveryAction({ polite: false, connection: 'failed', ice: 'failed', signaling: 'stable', ageMs: 5000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 8000, ageMs: 5000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'failed', ice: 'failed', signaling: 'stable', ageMs: 5000, established: true })).toBe('restart')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'stable', disconnectedForMs: 8000, ageMs: 20000 })).toBe('restart')
    expect(iceRecoveryAction({ polite: false, connection: 'failed', ice: 'failed', signaling: 'have-local-offer' })).toBe('resend')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'have-local-offer', disconnectedForMs: 1000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'have-local-offer', disconnectedForMs: 2000 })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'disconnected', ice: 'disconnected', signaling: 'have-local-offer', disconnectedForMs: 8000 })).toBe('resend')
    expect(iceRecoveryAction({ polite: false, connection: 'failed', ice: 'failed', signaling: 'stable' })).toBe('restart')
    expect(iceRecoveryAction({ polite: false, connection: 'failed', ice: 'failed', signaling: 'have-remote-offer' })).toBe('wait')
    expect(iceRecoveryAction({ polite: false, connection: 'connected', ice: 'connected', signaling: 'stable' })).toBe('none')
    expect(mediaCanCarryAssets([])).toBe(false)
    expect(mediaCanCarryAssets([{ connection: 'connected', outboundVideo: 0, outboundAudio: 0 }])).toBe(false)
    expect(mediaCanCarryAssets([{ connection: 'connecting', outboundVideo: 1000, outboundAudio: 0 }])).toBe(false)
    expect(mediaCanCarryAssets([{ connection: 'connected', outboundVideo: 1000, outboundAudio: 0 }])).toBe(true)
    expect(mediaCanCarryAssets([{ connection: 'connected', outboundVideo: 0, outboundAudio: 1000 }])).toBe(true)
    expect(assetChunkCount(0)).toBe(0)
    expect(assetChunkCount(ASSET_CHUNK_BYTES)).toBe(1)
    expect(assetChunkCount(ASSET_CHUNK_BYTES + 1)).toBe(2)
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

describe('storage quota', () => {
  it('recognizes a quota failure and ignores other errors', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true)
    expect(isQuotaError(new DOMException('full', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true)
    expect(isQuotaError(new Error('full'))).toBe(false)
  })
})

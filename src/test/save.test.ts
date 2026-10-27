import { describe, expect, it } from 'vitest'
import { applyFreeze, bounceBounds, renderArrangement, runBounce, tailSamples } from '../audio/bounce'
import { processChain } from '../audio/plugins/chain'
import { renderGraph } from '../audio/renderGraph'
import { measureLufs, normalizeAudio } from '../audio/normalize'
import { encodeMp3, mp3Duration } from '../audio/mp3'
import { packProject, unpackProject } from '../model/archive'
import { decodeFlac, encodeFlac } from '../model/flac'
import { encodeMidi, midiNoteCount } from '../model/midiFile'
import { migrateProject } from '../model/schema'
import { createEmptyProject, makeTrack, SCHEMA_VERSION, uid, type AudioAsset } from '../model/types'
import { decodeWavPCM, encodeWav, parseWavHeader } from '../model/wav'
import { unzip } from '../model/zip'
import { chooseCurrent, contentHash, dedupeBlobs, planCommit, type ProjectDoc, type SnapshotDoc } from '../storage/content'
import { formFactor } from '../ui/form'
import { MPEGDecoder } from 'mpg123-decoder'

function tone(length: number, rate: number, freq = 440, amp = 0.4) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function doc(id: string, savedAt: number): ProjectDoc {
  const project = createEmptyProject(48000, id)
  project.id = id
  return { id, name: id, savedAt, project, assets: [], peaks: [], bytes: 0 }
}

describe('form factor', () => {
  it('classifies phone, cover, landscape, and the unfolded inner screen', () => {
    expect(formFactor(360, 800)).toBe('phone')
    expect(formFactor(390, 844)).toBe('phone')
    expect(formFactor(344, 882)).toBe('phone')
    expect(formFactor(844, 390)).toBe('phone')
    expect(formFactor(800, 360)).toBe('phone')
    expect(formFactor(673, 841)).toBe('fold')
    expect(formFactor(884, 1104)).toBe('fold')
    expect(formFactor(1440, 900)).toBe('desk')
  })
})

describe('projects', () => {
  it('migrates a version 1 document and keeps later saves stable', () => {
    const current = createEmptyProject()
    const legacy = { ...current, version: 1, masterPlugins: undefined, scale: undefined }
    const opened = migrateProject(legacy)
    expect(opened.version).toBe(SCHEMA_VERSION)
    expect(opened.masterPlugins.some((plugin) => plugin.pluginId === 'limiter' && plugin.enabled === false)).toBe(true)
    expect(migrateProject(opened).version).toBe(SCHEMA_VERSION)
    expect(() => migrateProject({ ...opened, version: 9 })).toThrow(/newer/)
  })

  it('round-trips a project through .cueharbor, including a guest take', async () => {
    const project = createEmptyProject(48000, 'Harbor')
    const audio = tone(1200, 48000)
    const asset: AudioAsset = { id: 'take', name: 'guest take', sampleRate: 48000, channels: [audio, audio] }
    project.tracks[0].clips.push({
      id: 'clip',
      name: 'guest aligned',
      bufferId: asset.id,
      startSample: 10,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'aligned-take',
      peerId: 'guest',
      takeId: 't1',
    })
    const packed = await packProject(project, [asset], { audio: 'wav' })
    const opened = await unpackProject(packed)
    expect(opened.project.name).toBe('Harbor')
    expect(opened.project.tracks[0].clips[0].source).toBe('aligned-take')
    expect(opened.project.tracks[0].clips[0].peerId).toBe('guest')
    const again = await unpackProject(await packProject(opened.project, opened.assets, { audio: 'wav' }))
    expect(again.project.tracks[0].clips[0].takeId).toBe('t1')
    expect(again.assets[0].channels[0][10]).toBeCloseTo(audio[10], 5)
  })

  it('dedupes identical audio and keeps eight snapshots', async () => {
    const audio = tone(64, 48000)
    const first = new Uint8Array(encodeWav([audio], 48000, { bits: 32 }))
    const second = new Uint8Array(encodeWav([audio], 48000, { bits: 32 }))
    const a = await contentHash(first)
    const b = await contentHash(second)
    expect(a).toBe(b)
    expect(dedupeBlobs([{ hash: a, wav: first }, { hash: b, wav: second }]).size).toBe(1)
    let snapshots: SnapshotDoc[] = []
    let current = doc('song', 1)
    for (let i = 2; i <= 12; i++) {
      const next = doc('song', i)
      const plan = planCommit({ next, current, snapshots, snapshot: true })
      current = plan.current
      snapshots = plan.snapshots
    }
    expect(snapshots).toHaveLength(8)
    expect(Math.min(...snapshots.map((item) => item.savedAt))).toBe(4)
    expect(chooseCurrent(doc('song', 9), doc('song', 3))?.savedAt).toBe(9)
    expect(chooseCurrent(null, current)?.id).toBe('song')
  })

  it('round-trips FLAC audio used when collecting a project', () => {
    const audio = tone(300, 48000, 330, 0.5)
    const decoded = decodeFlac(encodeFlac([audio, audio.slice()], 48000, 16))
    expect(decoded.sampleRate).toBe(48000)
    expect(decoded.channels[0][20]).toBeCloseTo(audio[20], 2)
  })
})

describe('bounce', () => {
  it('matches the live fader law and block size', async () => {
    const rate = 48000
    const sine = tone(1024, rate, 440, 0.5)
    const project = createEmptyProject(rate, 'Null')
    project.masterPlugins = []
    project.masterVolume = 0.5
    project.tracks = [makeTrack({ id: 't', name: 'T', type: 'audio', volume: 0.8, pan: 0.25, input: 'none' })]
    const asset: AudioAsset = { id: 'a', name: 'a', sampleRate: rate, channels: [sine, sine] }
    project.tracks[0].clips = [{
      id: 'c', name: 'c', bufferId: 'a', startSample: 0, offsetSamples: 0, durationSamples: sine.length,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import',
    }]
    const offline = await renderArrangement(project, new Map([[asset.id, asset]]), 0, sine.length, false)
    const angle = ((0.25 + 1) * Math.PI) / 4
    const left = Math.cos(angle) * 0.8 * 0.5
    const right = Math.sin(angle) * 0.8 * 0.5
    expect(offline[0][100]).toBeCloseTo(sine[100] * left, 4)
    expect(offline[1][100]).toBeCloseTo(sine[100] * right, 4)
    const again = await renderArrangement(project, new Map([[asset.id, asset]]), 0, sine.length, false)
    expect(again[0][100]).toBe(offline[0][100])
    const processor = {
      latencySamples: 0,
      reset() {},
      process(input: Float32Array[], output: Float32Array[]) {
        for (let c = 0; c < output.length; c++) for (let i = 0; i < output[c].length; i++) output[c][i] = (input[c][i] || 0) * 0.5
      },
    }
    const plugin = { id: 'g', pluginId: 'gain', version: '1', enabled: true, wet: 1, params: {}, sidechain: '' }
    const slot = { ...plugin, failed: false, processor }
    const blocked = [new Float32Array(sine.length), new Float32Array(sine.length)]
    for (let offset = 0; offset < sine.length; offset += 256) {
      const count = Math.min(256, sine.length - offset)
      processChain([slot], [sine.subarray(offset, offset + count), sine.subarray(offset, offset + count)], [blocked[0].subarray(offset, offset + count), blocked[1].subarray(offset, offset + count)], {
        sampleRate: rate, tempo: 120, sampleTime: offset, sidechain: null, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], quality: 'full',
      })
    }
    const withGain = renderGraph({
      tracks: [{ id: 't', type: 'audio', input: 'none', buffer: [sine, sine], volume: 0.8, pan: 0.25, mute: false, solo: false, plugins: [plugin], sends: [], output: null, groupId: null }],
      masterPlugins: [], masterVolume: 0.5, sampleRate: rate, tempo: 120, length: sine.length, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], automation: [],
      create: () => processor,
    })
    expect(withGain.master[0][80]).toBeCloseTo(blocked[0][80] * left, 4)
    expect(withGain.master[1][80]).toBeCloseTo(blocked[1][80] * right, 4)
    expect(renderGraph({
      tracks: [{ id: 't', type: 'audio', input: 'none', buffer: [sine, sine], volume: 0.8, pan: 0.25, mute: false, solo: false, plugins: [], sends: [], output: null, groupId: null }],
      masterPlugins: [], masterVolume: 0.5, sampleRate: rate, tempo: 120, length: sine.length, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], automation: [],
      create: () => processor,
    }).master[0][40]).toBeCloseTo(sine[40] * left, 4)
  })

  it('writes wav headers for 16, 24, and 32-bit float', () => {
    const audio = tone(32, 44100)
    for (const bits of [16, 24, 32] as const) {
      const wav = encodeWav([audio, audio], 44100, { bits })
      const info = parseWavHeader(wav)
      expect(info.bits).toBe(bits)
      expect(info.sampleRate).toBe(44100)
      expect(info.format).toBe(bits === 32 ? 3 : 1)
      const decoded = decodeWavPCM(wav)
      expect(decoded.channels[0]).toHaveLength(32)
      const limit = bits === 16 ? 1 / 32767 : bits === 24 ? 1 / 8388607 : 1e-6
      expect(Math.abs(decoded.channels[0][4] - audio[4])).toBeLessThan(limit + 1e-6)
    }
  })

  it('encodes an mp3 that decodes to the same duration', async () => {
    const rate = 44100
    const audio = tone(rate, rate, 440, 0.2)
    const mp3 = encodeMp3([audio, audio], rate, { mode: 'cbr', bitrate: 128, quality: 4, tags: { title: 'Harbor', artist: 'Cue', bpm: 120, key: 'C Major' } })
    expect(mp3Duration(mp3).seconds).toBeGreaterThan(0.8)
    const decoder = new MPEGDecoder()
    await decoder.ready
    const decoded = decoder.decode(mp3)
    decoder.free()
    expect(decoded.errors).toHaveLength(0)
    expect(decoded.samplesDecoded / decoded.sampleRate).toBeGreaterThan(0.8)
    expect(decoded.samplesDecoded / decoded.sampleRate).toBeLessThan(1.2)
    const vbr = encodeMp3([audio, new Float32Array(audio.length)], rate, { mode: 'vbr', bitrate: 192, quality: 4 })
    const loud = encodeMp3([tone(rate, rate, 100, 0.9), tone(rate, rate, 100, 0.9)], rate, { mode: 'vbr', bitrate: 192, quality: 1 })
    expect(mp3Duration(vbr).frames).toBeGreaterThan(0)
    expect(loud.byteLength).not.toBe(vbr.byteLength)
  })

  it('aligns stem files to the same start', async () => {
    const rate = 48000
    const project = createEmptyProject(rate, 'Stems')
    project.masterPlugins = []
    project.tracks = [
      makeTrack({ id: 'a', name: 'Kick', type: 'audio', input: 'none', volume: 1, pan: 0 }),
      makeTrack({ id: 'b', name: 'Snare', type: 'audio', input: 'none', volume: 1, pan: 0 }),
    ]
    const kick = new Float32Array(4000)
    const snare = new Float32Array(4000)
    kick[1000] = 0.8
    snare[2000] = 0.8
    const assets = [
      { id: 'ka', name: 'k', sampleRate: rate, channels: [kick, kick] },
      { id: 'sa', name: 's', sampleRate: rate, channels: [snare, snare] },
    ]
    project.tracks[0].clips = [{ id: 'c1', name: 'k', bufferId: 'ka', startSample: 0, offsetSamples: 0, durationSamples: 4000, fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import' }]
    project.tracks[1].clips = [{ id: 'c2', name: 's', bufferId: 'sa', startSample: 0, offsetSamples: 0, durationSamples: 4000, fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import' }]
    const [zip] = await runBounce({
      kind: 'stems', project, assets, scope: 'time', startSample: 0, endSample: 4000, tail: 0,
      sampleRate: rate, bits: 16, dither: 'none', normalize: 'off', normalizeTarget: -1, limiter: false,
      stemIds: null, trackId: null, mp3Mode: 'cbr', mp3Bitrate: 128, mp3Quality: 4, title: '', artist: '', artwork: null, projectAudio: 'wav',
    })
    const files = await unzip(zip.bytes)
    expect(files).toHaveLength(2)
    const decoded = files.map((file) => decodeWavPCM(file.data.buffer.slice(file.data.byteOffset, file.data.byteOffset + file.data.byteLength) as ArrayBuffer))
    expect(decoded[0].channels[0].length).toBe(decoded[1].channels[0].length)
    const peak = (channel: Float32Array) => channel.reduce((best, value, index) => (Math.abs(value) > Math.abs(channel[best]) ? index : best), 0)
    expect(peak(decoded[0].channels[0])).toBe(1000)
    expect(peak(decoded[1].channels[0])).toBe(2000)
  })

  it('normalizes to a LUFS target', () => {
    const rate = 48000
    const audio = tone(rate, rate, 1000, 0.25)
    const normalized = normalizeAudio([audio, audio], rate, 'lufs', -14)
    expect(measureLufs(normalized, rate)).toBeCloseTo(-14, 1)
  })

  it('detects a delay tail and freezes onto a new track', () => {
    const project = createEmptyProject()
    project.tracks[0].plugins = [{ id: 'd', pluginId: 'delay', version: '1', enabled: true, wet: 1, params: { time: 250, feedback: 0.5 }, sidechain: '' }]
    expect(tailSamples(project, 48000)).toBeGreaterThan(4800)
    expect(bounceBounds(project, 'time', 0, 1000).end).toBe(1000)
    const audio = tone(200, 48000)
    const frozen = applyFreeze(project, new Map(), project.tracks[0].id, { sampleRate: 48000, channels: [audio, audio] }, 0)
    expect(frozen.project.tracks[1].name.endsWith('bounce')).toBe(true)
    expect(frozen.project.tracks[0].mute).toBe(true)
    expect(frozen.project.tracks[0].plugins[0].enabled).toBe(false)
    expect(frozen.buffers.size).toBe(1)
  })

  it('exports midi notes', () => {
    const project = createEmptyProject()
    project.tracks[2].midiClips = [{
      id: 'm', name: 'Keys', startBeat: 0, durationBeats: 4,
      notes: [{ id: uid('n'), pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }, { id: uid('n'), pitch: 64, startBeat: 1, durationBeats: 1, velocity: 0.6 }],
    }]
    const midi = encodeMidi(project)
    expect(String.fromCharCode(...midi.subarray(0, 4))).toBe('MThd')
    expect(midiNoteCount(midi)).toBe(2)
  })
})

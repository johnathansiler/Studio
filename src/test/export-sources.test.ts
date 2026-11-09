import { describe, expect, it } from 'vitest'
import { MPEGDecoder } from 'mpg123-decoder'
import { LibrarySamplesMissing } from '../audio/arrangeSources'
import { AudioEngine } from '../audio/engine'
import { bounceMasterPlugins, BounceCancelled, renderArrangement, runBounce } from '../audio/bounce'
import { renderSamplerSpan } from '../audio/plugins/sampler'
import { renderGraph } from '../audio/renderGraph'
import { ATTACK_SEC, drumLevel } from '../audio/liveStage'
import { residentDrums } from '../model/drums'
import { createPlugin, normalizeProject } from '../audio/plugins/catalog'
import { createStepsPlugin } from '../model/stepPlugin'
import { beatSpanSamples } from '../model/tempoMap'
import { beatsToSamples } from '../model/time'
import { createEmptyProject, makeTrack, type AudioAsset, type Project } from '../model/types'
import { renderClipChannels } from '../audio/stretch/engine'
import { packProject, unpackProject } from '../model/archive'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { unzip } from '../model/zip'
import { normalizePadKit } from '../model/padMachine'
import { loadStarterOnto } from '../sounds/instruments'
import { ProjectStore } from '../state/store'
import type { LibraryEntry } from '../audio/multisample/library'

const rate = 48000

function tone(length: number, freq = 440, amp = 0.5) {
  const data = new Float32Array(length)
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function clicks(bpm: number, bars: number) {
  const beats = bars * 4
  const data = new Float32Array(Math.round(beats * rate * 60 / bpm))
  for (let beat = 0; beat < beats; beat++) data[Math.round(beat * rate * 60 / bpm)] = 1
  return data
}

function project(tracks = projectTracks()) {
  const next = createEmptyProject(rate, 'Export')
  next.masterPlugins = []
  next.masterVolume = 1
  next.tracks = tracks
  return next
}

function projectTracks() {
  return [makeTrack({ id: 't', name: 'T', type: 'audio', volume: 1, pan: 0, input: 'none' })]
}

function asset(id: string, channel: Float32Array): AudioAsset {
  return { id, name: id, sampleRate: rate, channels: [channel, channel.slice()] }
}

function rms(channel: Float32Array, from = 0, to = channel.length) {
  let sum = 0
  let n = 0
  for (let i = from; i < to && i < channel.length; i++) {
    const value = channel[i] || 0
    sum += value * value
    n += 1
  }
  return n ? Math.sqrt(sum / n) : 0
}

function peakIndex(channel: Float32Array, from = 0, to = channel.length) {
  let best = 0
  let at = from
  for (let i = from; i < to && i < channel.length; i++) {
    const mag = Math.abs(channel[i] || 0)
    if (mag > best) {
      best = mag
      at = i
    }
  }
  return { at, best }
}

function firstAbove(channel: Float32Array, threshold: number) {
  for (let i = 0; i < channel.length; i++) if (Math.abs(channel[i] || 0) > threshold) return i
  return -1
}

function correlate(a: Float32Array, b: Float32Array) {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    dot += x * y
    aa += x * x
    bb += y * y
  }
  if (aa < 1e-12 || bb < 1e-12) return 0
  return dot / Math.sqrt(aa * bb)
}

function graphOf(song: Project, buffers: Float32Array[], plugins = song.tracks[0]?.plugins ?? []) {
  return renderGraph({
    tracks: [{
      id: song.tracks[0].id,
      type: song.tracks[0].type,
      input: 'none',
      buffer: buffers,
      volume: song.tracks[0].volume,
      pan: song.tracks[0].pan,
      mute: false,
      solo: false,
      plugins,
      sends: song.tracks[0].sends,
      output: null,
      groupId: null,
    }],
    masterPlugins: song.masterPlugins,
    masterVolume: song.masterVolume,
    sampleRate: rate,
    tempo: song.tempo,
    length: buffers[0].length,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    create: () => ({
      latencySamples: 0,
      reset() {},
      process(input, output) {
        for (let c = 0; c < output.length; c++) output[c].set(input[Math.min(c, input.length - 1)] ?? output[c])
      },
    }),
  }).master
}

describe('export sources', () => {
  it('prints a follow-tempo loop with the stretch engine, not the dry file', async () => {
    const channel = clicks(100, 1)
    const song = project()
    song.tempo = 150
    const clip = {
      id: 'loop',
      name: 'loop',
      bufferId: 'loop',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: Math.round(channel.length * 100 / 150),
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import' as const,
      stretch: { sourceSamples: channel.length, semitones: 0, cents: 0, mode: 'beats' as const, followTempo: true, sourceBpm: 100, markers: [] },
    }
    song.tracks[0].clips = [clip]
    const file = asset('loop', channel)
    const length = Math.max(clip.durationSamples, channel.length)
    const bounced = await renderArrangement(song, new Map([[file.id, file]]), 0, length, false)
    const stretched = renderClipChannels(file.channels, clip, song, 'hq')
    const placed = [new Float32Array(length), new Float32Array(length)]
    placed[0].set(stretched[0].subarray(0, length))
    placed[1].set((stretched[1] ?? stretched[0]).subarray(0, length))
    const expected = graphOf(song, placed, [])
    expect(correlate(bounced[0], expected[0])).toBeGreaterThan(0.98)
    const heard = peakIndex(bounced[0], Math.round(rate * 60 / 150) - 400, Math.round(rate * 60 / 150) + 400)
    const dry = peakIndex(channel, Math.round(rate * 60 / 100) - 20, Math.round(rate * 60 / 100) + 20)
    expect(heard.best).toBeGreaterThan(0.2)
    expect(Math.abs(heard.at - Math.round(rate * 60 / 150))).toBeLessThan(rate * 0.02)
    expect(Math.abs(dry.at - heard.at)).toBeGreaterThan(rate * 0.05)
  })

  it('prints a loaded sampler note instead of a placeholder saw', async () => {
    const pcm = tone(Math.round(rate * 0.2), 330, 0.8)
    const song = project([makeTrack({ id: 'samp', name: 'Sampler', type: 'midi', volume: 1, pan: 0, input: 'none', instrument: 'sampler' })])
    const plugin = createPlugin('sampler')
    plugin.sampler = { ...plugin.sampler!, bufferId: 'pcm', root: 60 }
    song.tracks[0].plugins = [plugin]
    song.tracks[0].midiClips = [{
      id: 'm',
      name: 'notes',
      startBeat: 0,
      durationBeats: 1,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 0.8 }],
    }]
    const length = rate
    const bounced = await renderArrangement(song, new Map([['pcm', asset('pcm', pcm)]]), 0, length, false)
    const span = beatSpanSamples(song, 0, 0.5)
    const rendered = renderSamplerSpan(plugin, pcm, [
      { time: 0, pitch: 60, vel: 0.8 },
      { time: span.duration / rate, pitch: 60, vel: 0 },
    ], rate, Math.ceil((span.duration / rate + 0.3) * rate))
    const placed = [new Float32Array(length), new Float32Array(length)]
    placed[0].set(rendered[0].subarray(0, length - Math.round(span.start)), Math.round(span.start))
    placed[1].set(rendered[1].subarray(0, length - Math.round(span.start)), Math.round(span.start))
    const expected = graphOf(song, placed, [])
    let max = 0
    for (let i = 0; i < length; i++) max = Math.max(max, Math.abs(bounced[0][i] - expected[0][i]))
    expect(max).toBeLessThan(1e-4)
    expect(rms(bounced[0], 0, Math.round(rate * 0.15))).toBeGreaterThan(0.02)
    expect(correlate(bounced[0].subarray(0, pcm.length), tone(pcm.length, 440, 0.2))).toBeLessThan(0.35)
  })

  it('places a synth and a step hit on the tempo map', async () => {
    const song = project([
      makeTrack({ id: 'keys', name: 'Keys', type: 'midi', volume: 1, pan: 0, input: 'none', instrument: 'synth' }),
      makeTrack({ id: 'steps', name: 'Steps', type: 'midi', volume: 1, pan: 0, input: 'none' }),
    ])
    song.tempo = 120
    song.tempoMap = [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }]
    song.tracks[0].midiClips = [{
      id: 'm',
      name: 'note',
      startBeat: 0,
      durationBeats: 4,
      notes: [{ id: 'n', pitch: 69, startBeat: 2, durationBeats: 0.5, velocity: 0.9 }],
    }]
    const steps = createStepsPlugin()
    steps.params.song = 0
    const pattern = steps.steps!.patterns[0]
    for (const channel of pattern.channels) {
      channel.mute = channel.kind !== 'kick'
      for (const cell of channel.cells) cell.on = false
    }
    const kick = pattern.channels.find((channel) => channel.kind === 'kick')!
    kick.cells[8] = { ...kick.cells[8], on: true, velocity: 1, gate: 0.8 }
    song.tracks[1].plugins = [steps]
    const length = rate * 4
    const bounced = await renderArrangement(song, new Map(), 0, length, false)
    const mapped = Math.round(beatSpanSamples(song, 2, 0.5).start)
    const linear = Math.round(beatsToSamples(2, rate, song.tempo))
    expect(Math.abs(mapped - linear)).toBeGreaterThan(rate * 0.2)
    const onset = firstAbove(bounced[0], 0.002)
    expect(onset).toBeGreaterThan(0)
    expect(Math.abs(onset - mapped)).toBeLessThan(rate * 0.02)
    expect(Math.abs(onset - linear)).toBeGreaterThan(rate * 0.1)
    expect(rms(bounced[0], mapped, mapped + Math.round(rate * 0.05))).toBeGreaterThan(0.005)
    expect(rms(bounced[0], linear, linear + Math.round(rate * 0.02))).toBeLessThan(0.001)
  })

  it('prints a Beat Machine pad sample and a drum-machine voice', async () => {
    const pcm = tone(Math.round(rate * 0.18), 220, 0.7)
    const kit = normalizePadKit(undefined)
    const pad = kit.banks.flat().find((item) => item.pitch === 36)!
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: 'pad' }]
    pad.decay = 1
    pad.filter = 1
    pad.level = 1
    pad.pan = 0
    const pads = makeTrack({ id: 'pads', name: 'Pads', type: 'midi', volume: 1, pan: 0, input: 'none', instrument: 'pads', padKit: kit })
    pads.midiClips = [{
      id: 'p',
      name: 'pad',
      startBeat: 0,
      durationBeats: 1,
      notes: [{ id: 'n', pitch: 36, startBeat: 0, durationBeats: 0.5, velocity: 0.9 }],
    }]
    const drums = makeTrack({ id: 'drums', name: 'Drums', type: 'midi', volume: 1, pan: 0, input: 'none', instrument: 'drum-machine' })
    drums.midiClips = [{
      id: 'd',
      name: 'drum',
      startBeat: 1,
      durationBeats: 1,
      notes: [{ id: 'k', pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 1 }],
    }]
    const song = project([pads, drums])
    const length = rate * 2
    const bounced = await renderArrangement(song, new Map([['pad', asset('pad', pcm)]]), 0, length, false)
    const earlyFrom = Math.round(rate * 0.008)
    const earlyTo = Math.round(rate * 0.03)
    expect(correlate(bounced[0].subarray(earlyFrom, earlyTo), pcm.subarray(earlyFrom, earlyTo))).toBeGreaterThan(0.85)
    expect(rms(bounced[0], Math.round(rate * 0.12), pcm.length)).toBeLessThan(rms(bounced[0], earlyFrom, earlyTo))
    const drum = residentDrums(rate).find((item) => item.pitch === 36)!
    const at = Math.round(beatsToSamples(1, rate, 120))
    const heard = bounced[0].subarray(at, at + drum.samples.length)
    const shaped = new Float32Array(drum.samples.length)
    const peak = drumLevel(1)
    for (let i = 0; i < shaped.length; i++) {
      const t = i / rate
      const gain = t < ATTACK_SEC ? 0.0001 * (peak / 0.0001) ** (t / ATTACK_SEC) : peak
      shaped[i] = drum.samples[i] * gain
    }
    expect(correlate(heard, shaped)).toBeGreaterThan(0.9)
    expect(correlate(heard, tone(heard.length, 440, 0.2))).toBeLessThan(0.35)
  })

  it('keeps pan, a pre-fader send, an insert, and the master fader in the file', async () => {
    const pcm = tone(rate, 1000, 0.4)
    const bus = makeTrack({ id: 'bus', name: 'Bus', type: 'bus', volume: 1, pan: 0, input: 'none' })
    const vocal = makeTrack({ id: 'v', name: 'Vocal', type: 'audio', volume: 1, pan: 1, input: 'none' })
    vocal.clips = [{
      id: 'c', name: 'c', bufferId: 'a', startSample: 0, offsetSamples: 0, durationSamples: pcm.length,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import',
    }]
    const song = project([vocal, bus])
    const panned = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    expect(rms(panned[1])).toBeGreaterThan(0.05)
    expect(rms(panned[0])).toBeLessThan(rms(panned[1]) * 0.05)
    vocal.volume = 0
    vocal.pan = 0
    vocal.sends = [{ id: 's', busId: bus.id, gain: 1, preFader: true, enabled: true }]
    const sent = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    vocal.sends = []
    const dry = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    expect(rms(sent[0])).toBeGreaterThan(0.02)
    expect(rms(dry[0])).toBeLessThan(0.001)
    vocal.volume = 1
    vocal.pan = 0
    vocal.sends = []
    song.masterVolume = 0.5
    const quiet = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    song.masterVolume = 1
    const loud = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    expect(rms(quiet[0]) / rms(loud[0])).toBeCloseTo(0.5, 2)
    const eq = createPlugin('eq')
    eq.params.midF = 1000
    eq.params.midG = 12
    eq.params.midQ = 1
    song.tracks[0].plugins = [eq]
    const colored = await renderArrangement(song, new Map([['a', asset('a', pcm)]]), 0, pcm.length, false)
    expect(Math.abs(rms(colored[0]) / rms(loud[0]) - 1)).toBeGreaterThan(0.15)
  })

  it('puts a requested limiter last and leaves the speaker compressor out of the file', async () => {
    const opened = normalizeProject(createEmptyProject(rate))
    expect(opened.masterPlugins.at(-1)?.pluginId).toBe('limiter')
    expect(opened.masterPlugins.at(-1)?.enabled).toBe(false)
    const chain = bounceMasterPlugins([createPlugin('eq'), createPlugin('compressor')], true)
    expect(chain.at(-1)?.pluginId).toBe('limiter')
    expect(chain.at(-1)?.enabled).toBe(true)
    expect(chain.slice(0, -1).some((plugin) => plugin.pluginId === 'limiter')).toBe(false)
    const parked = createPlugin('limiter', 'Transparent')
    parked.enabled = false
    const moved = bounceMasterPlugins([parked, createPlugin('eq')], true)
    expect(moved[0].enabled).toBe(false)
    expect(moved.at(-1)?.pluginId).toBe('limiter')
    expect(moved.at(-1)?.enabled).toBe(true)
    const hot = tone(Math.round(rate * 0.25), 220, 1)
    const song = project()
    song.tracks[0].volume = 2
    song.tracks[0].clips = [{
      id: 'c', name: 'c', bufferId: 'a', startSample: 0, offsetSamples: 0, durationSamples: hot.length,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import',
    }]
    const open = await renderArrangement(song, new Map([['a', asset('a', hot)]]), 0, hot.length, false)
    const limited = await renderArrangement(song, new Map([['a', asset('a', hot)]]), 0, hot.length, true)
    const openPeak = peakIndex(open[0]).best
    const limitedPeak = peakIndex(limited[0]).best
    expect(openPeak).toBeGreaterThan(1.2)
    expect(limitedPeak).toBeLessThan(1.02)
    expect(limitedPeak).toBeLessThan(openPeak * 0.85)

    const user = createPlugin('limiter', 'Transparent')
    user.enabled = true
    user.params.ceiling = -20
    const kept = bounceMasterPlugins([user, createPlugin('eq')], false)
    expect(kept.map((plugin) => plugin.pluginId)).toEqual(['limiter', 'eq'])
    expect(kept[0].enabled).toBe(true)
    expect(kept[0].params.ceiling).toBe(-20)
    const toneAsset = asset('hot', tone(Math.round(rate * 0.3), 220, 0.9))
    const mastered = project()
    mastered.masterPlugins = [{ ...user, params: { ...user.params } }]
    mastered.tracks[0].clips = [{
      id: 'c', name: 'c', bufferId: 'hot', startSample: 0, offsetSamples: 0, durationSamples: toneAsset.channels[0].length,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import',
    }]
    const buffers = new Map([[toneAsset.id, toneAsset]])
    const sheetOff = await renderArrangement(mastered, buffers, 0, toneAsset.channels[0].length, false)
    const sheetOn = await renderArrangement(mastered, buffers, 0, toneAsset.channels[0].length, true)
    const quick = decodeWavPCM(await new AudioEngine().exportMix(mastered, buffers))
    expect(peakIndex(sheetOff[0]).best).toBeLessThan(0.2)
    expect(peakIndex(sheetOn[0]).best).toBeLessThan(0.2)
    expect(peakIndex(quick.channels[0]).best).toBeLessThan(0.2)
    mastered.masterPlugins = [{ ...user, enabled: false, params: { ...user.params } }]
    const bypassed = await renderArrangement(mastered, buffers, 0, toneAsset.channels[0].length, false)
    expect(peakIndex(bypassed[0]).best).toBeGreaterThan(0.5)
    mastered.masterPlugins = [{ ...user, enabled: true, params: { ...user.params } }]
    const [zip] = await runBounce({
      kind: 'stems', project: mastered, assets: [toneAsset], scope: 'time', startSample: 0, endSample: toneAsset.channels[0].length, tail: 0,
      sampleRate: rate, bits: 32, dither: 'none', normalize: 'off', normalizeTarget: -1, limiter: false,
      stemIds: null, trackId: null, mp3Mode: 'cbr', mp3Bitrate: 128, mp3Quality: 4, title: '', artist: '', artwork: null, projectAudio: 'wav',
    })
    const stemFile = (await unzip(zip.bytes))[0]
    const stem = decodeWavPCM(stemFile.data.buffer.slice(stemFile.data.byteOffset, stemFile.data.byteOffset + stemFile.data.byteLength) as ArrayBuffer)
    expect(peakIndex(stem.channels[0]).best).toBeGreaterThan(0.5)
  })

  it('prints a URL-only starter instrument, then keeps that PCM for a reload', async () => {
    const entry: LibraryEntry = { id: 'tone', name: 'Tone', license: 'CC0-1.0', path: 'tone/instrument.sfz', bytes: 8, description: '' }
    const source = tone(Math.round(rate * 0.2), 330, 0.6)
    const wav = encodeWav([source], rate)
    const sfz = '<region> sample=samples/c4.wav key=c4\n'
    let sampleFetches = 0
    const fetchImpl = async (url: string) => {
      expect(url.startsWith('https://huggingface.co/datasets/')).toBe(true)
      if (url.endsWith('.sfz')) return new Response(sfz)
      sampleFetches += 1
      return new Response(wav)
    }
    const store = new ProjectStore(createEmptyProject(rate, 'Library'))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    await loadStarterOnto(entry, keys.id, { setLibrary: (id, program) => store.setLibrary(id, program) }, { audition: false, fetchImpl })
    const program = store.track(keys.id)!.library!
    expect(program.samples[0].url).toContain('huggingface.co')
    expect(program.samples[0].bufferId || '').toBe('')
    expect(store.buffers.size).toBe(0)
    keys.volume = 1
    keys.pan = 0
    keys.midiClips = [{
      id: 'm', name: 'note', startBeat: 0, durationBeats: 1,
      notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 0.9 }],
    }]
    store.project.masterPlugins = []
    store.project.masterVolume = 1
    const printed = await renderArrangement(store.project, store.buffers, 0, rate, false, null, rate, undefined, fetchImpl)
    expect(rms(printed[0], 0, source.length)).toBeGreaterThan(0.02)
    expect(sampleFetches).toBe(1)
    expect(correlate(printed[0].subarray(200, 2000), source.subarray(200, 2000))).toBeGreaterThan(0.8)
    const savedId = program.samples[0].bufferId || ''
    expect(store.buffers.get(savedId)?.channels[0].length).toBe(source.length)
    const opened = await unpackProject(await packProject(store.project, store.buffers.values(), { audio: 'wav' }))
    const offline = async (_url: string) => { throw new Error('network') }
    const again = await renderArrangement(opened.project, new Map(opened.assets.map((item) => [item.id, item])), 0, rate, false, null, rate, undefined, offline)
    expect(rms(again[0], 0, source.length)).toBeGreaterThan(0.02)
    expect(correlate(again[0].subarray(200, 2000), printed[0].subarray(200, 2000))).toBeGreaterThan(0.98)

    const broken = new ProjectStore(createEmptyProject(rate, 'Missing'))
    const host = broken.project.tracks.find((track) => track.type === 'midi')!
    await loadStarterOnto(entry, host.id, { setLibrary: (id, program) => broken.setLibrary(id, program) }, { audition: false, fetchImpl })
    host.volume = 1
    host.midiClips = keys.midiClips
    broken.project.masterPlugins = []
    broken.project.masterVolume = 1
    await expect(renderArrangement(broken.project, broken.buffers, 0, rate, false, null, rate, undefined, async (url: string) => {
      if (url.endsWith('.sfz')) return new Response(sfz)
      return new Response('missing', { status: 404 })
    })).rejects.toBeInstanceOf(LibrarySamplesMissing)
    let fetching = false
    await expect(renderArrangement(broken.project, broken.buffers, 0, rate, false, null, rate, () => {
      if (fetching) throw new BounceCancelled()
    }, async (url: string) => {
      if (url.endsWith('.wav')) fetching = true
      return url.endsWith('.sfz') ? new Response(sfz) : new Response(wav)
    })).rejects.toBeInstanceOf(BounceCancelled)
  })

  it('agrees across wav, stems, and mp3, and still cancels', async () => {
    const impulse = new Float32Array(4000)
    impulse[1000] = 0.8
    const song = project([
      makeTrack({ id: 'a', name: 'Kick', type: 'audio', volume: 1, pan: 0, input: 'none' }),
    ])
    song.tracks[0].clips = [{
      id: 'c', name: 'k', bufferId: 'ka', startSample: 0, offsetSamples: 0, durationSamples: 4000,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'import',
    }]
    const assets = [asset('ka', impulse)]
    const job = {
      kind: 'wav' as const,
      project: song,
      assets,
      scope: 'time' as const,
      startSample: 0,
      endSample: 4000,
      tail: 0,
      sampleRate: rate,
      bits: 32 as const,
      dither: 'none' as const,
      normalize: 'off' as const,
      normalizeTarget: -1,
      limiter: false,
      stemIds: null,
      trackId: null,
      mp3Mode: 'cbr' as const,
      mp3Bitrate: 128,
      mp3Quality: 4,
      title: 'Export',
      artist: '',
      artwork: null,
      projectAudio: 'wav' as const,
    }
    const progress: number[] = []
    const [wav] = await runBounce(job, (value) => progress.push(value))
    const decoded = decodeWavPCM(wav.bytes.buffer.slice(wav.bytes.byteOffset, wav.bytes.byteOffset + wav.bytes.byteLength) as ArrayBuffer)
    expect(peakIndex(decoded.channels[0]).at).toBe(1000)
    expect(progress.at(-1)).toBe(1)
    const [zip] = await runBounce({ ...job, kind: 'stems' })
    const files = await unzip(zip.bytes)
    const stem = decodeWavPCM(files[0].data.buffer.slice(files[0].data.byteOffset, files[0].data.byteOffset + files[0].data.byteLength) as ArrayBuffer)
    expect(peakIndex(stem.channels[0]).at).toBe(1000)
    expect(stem.channels[0].length).toBe(decoded.channels[0].length)
    const [mp3] = await runBounce({ ...job, kind: 'mp3', sampleRate: 48000 })
    const decoder = new MPEGDecoder()
    await decoder.ready
    const mpeg = decoder.decode(mp3.bytes)
    decoder.free()
    expect(mpeg.errors).toHaveLength(0)
    expect(mpeg.samplesDecoded / mpeg.sampleRate).toBeGreaterThan(0.05)
    expect(mpeg.samplesDecoded / mpeg.sampleRate).toBeLessThan(0.2)
    await expect(runBounce(job, undefined, () => true)).rejects.toBeInstanceOf(BounceCancelled)
    let calls = 0
    await expect(runBounce({ ...job, kind: 'wav' }, undefined, () => ++calls > 2)).rejects.toBeInstanceOf(BounceCancelled)
  })
})

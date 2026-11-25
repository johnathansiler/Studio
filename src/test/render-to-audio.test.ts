import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CueRackVoice } from '../audio/rack/voice'
import { renderLiveInserts } from '../audio/heardPrint'
import { renderSamplerSpan } from '../audio/plugins/sampler'
import { emptySampler } from '../audio/sample/engine'
import { makeDevice } from '../model/rack'
import { prepareClipNotes } from '../model/midiTools'
import { BASS808_RELEASE_SEC } from '../audio/bass808/voice'
import { releaseTailSamples, renderClipToAudio, SILENCE_AMP } from '../audio/renderToAudio'
import { createPlugin } from '../audio/plugins/catalog'
import { rackLanesFor } from '../model/automation'
import { beatSpanSamples, projectSampleBeat } from '../model/tempoMap'
import { renderPattern, starterPattern } from '../model/steps'
import { createEmptyProject, type MidiClip } from '../model/types'
import { decodeWavPCM, parseWavHeader } from '../model/wav'
import { encodedAssetWav } from '../storage/idb'
import { ProjectStore } from '../state/store'
import { RenderAudioSheet } from '../ui/RenderAudioSheet'
import { TrackOptions } from '../ui/TrackOptions'
import { VariationBar } from '../ui/VariationBar'

function studio() {
  const store = new ProjectStore(createEmptyProject(48000, 'Render'))
  const keys = store.project.tracks.find((track) => track.type === 'midi')!
  return { store, keys }
}

function lead(startBeat = 4): MidiClip {
  return {
    id: 'lead',
    name: 'Lead',
    startBeat,
    durationBeats: 1,
    notes: [{ id: 'n1', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }],
  }
}

/** Pull the cueharbor-rack class the worklet instantiates. */
function liveRack(
  rack: NonNullable<ReturnType<typeof studio>['keys']['rack']>,
  tempo: number,
  originBeat: number,
  events: { time: number; pitch: number; vel: number; slide?: boolean }[],
  length: number,
  lanes: ReturnType<typeof rackLanesFor> = [],
) {
  const voice = new CueRackVoice(48000)
  voice.onMessage({ type: 'clock', originTime: 0, originBeat, tempo, lanes })
  voice.onMessage({ type: 'state', rack, tempo, quality: 'full', buffers: [] })
  for (const event of events) voice.onMessage({ type: 'note', pitch: event.pitch, vel: event.vel, time: event.time, slide: !!event.slide })
  return voice.pull(length)
}

function residual(left: ArrayLike<number>, right: ArrayLike<number>) {
  const count = Math.min(left.length, right.length)
  let energy = 0
  let peak = 0
  for (let i = 0; i < count; i++) {
    const delta = (left[i] || 0) - (right[i] || 0)
    energy += delta * delta
    peak = Math.max(peak, Math.abs(delta))
  }
  const rms = Math.sqrt(energy / Math.max(1, count))
  const db = (value: number) => (value <= 1e-12 ? -180 : 20 * Math.log10(value))
  return { samples: count, rmsDb: db(rms), peakDb: db(peak) }
}

async function renderLead(store: ProjectStore, keysId: string, includeEffects = false) {
  return renderClipToAudio({
    project: store.project,
    assets: store.buffers,
    target: { kind: 'midi', trackId: keysId, clipId: 'lead' },
    includeEffects,
    normalize: false,
  })
}

describe('render to audio', () => {
  it('lines the rendered clip up with the MIDI clip and matches the realtime instrument', async () => {
    const { store, keys } = studio()
    keys.midiClips = [lead(4)]
    const rendered = await renderLead(store, keys.id)
    const clipSpan = beatSpanSamples(store.project, 4, 1)
    expect(rendered.startSample).toBe(clipSpan.start)
    expect(rendered.sampleRate).toBe(48000)
    const tail = releaseTailSamples(keys, 48000, false)
    const length = clipSpan.duration + tail
    const reference = liveRack(keys.rack!, store.project.tempo, projectSampleBeat(store.project, clipSpan.start), [
      { time: 0, pitch: 60, vel: 0.8 },
      { time: clipSpan.duration / 48000, pitch: 60, vel: 0 },
    ], length, rackLanesFor(store.project, keys.id))
    const left = residual(rendered.channels[0], reference[0])
    const right = residual(rendered.channels[1], reference[1])
    expect(left.peakDb).toBeLessThanOrEqual(-60)
    expect(right.peakDb).toBeLessThanOrEqual(-60)
    expect(left.rmsDb).toBeLessThanOrEqual(-60)
    expect(right.rmsDb).toBeLessThanOrEqual(-60)
    expect(rendered.channels[0].length).toBeLessThanOrEqual(length)
    let attack = 0
    for (let i = 0; i < Math.min(rendered.channels[0].length, 960); i++) {
      attack = Math.max(attack, Math.abs(rendered.channels[0][i] || 0))
    }
    expect(attack).toBeGreaterThan(SILENCE_AMP)
    console.info(`null-test peak ${left.peakDb.toFixed(1)} dB / ${right.peakDb.toFixed(1)} dB, rms ${left.rmsDb.toFixed(1)} dB / ${right.rmsDb.toFixed(1)} dB, start sample ${rendered.startSample}`)
  })

  it('keeps the release tail and trims only silence below -90 dBFS', async () => {
    const { store, keys } = studio()
    const device = keys.rack!.devices[0]
    device.params = { ...device.params, release: 800, sustain: 0.8 }
    keys.midiClips = [lead(0)]
    const long = await renderLead(store, keys.id)
    expect(long.channels[0].length).toBeGreaterThan(long.musicalSamples)
    const tailStart = long.musicalSamples
    let tailPeak = 0
    for (let i = tailStart; i < Math.min(long.channels[0].length, tailStart + 4800); i++) {
      tailPeak = Math.max(tailPeak, Math.abs(long.channels[0][i] || 0), Math.abs(long.channels[1][i] || 0))
    }
    expect(tailPeak).toBeGreaterThan(SILENCE_AMP)
    const last = Math.max(Math.abs(long.channels[0].at(-1) || 0), Math.abs(long.channels[1].at(-1) || 0))
    expect(last).toBeGreaterThanOrEqual(SILENCE_AMP)

    device.params = { ...device.params, release: 20, sustain: 0 }
    const short = await renderLead(store, keys.id)
    expect(short.channels[0].length).toBeLessThan(long.channels[0].length)
    expect(short.channels[0].length).toBeGreaterThan(short.musicalSamples)
  })

  it.skipIf(typeof OfflineAudioContext !== 'function')('renders every drum hit in a Beat Machine pattern', async () => {
    const { store, keys } = studio()
    const pattern = starterPattern()
    pattern.swing = 0
    store.project.beats = { activeId: pattern.id, patterns: [pattern] }
    store.project.patternClips = [{
      id: 'beat',
      patternId: pattern.id,
      startBeat: 2,
      lengthBeats: 4,
      scene: null,
      trackId: keys.id,
      placed: true,
    }]
    const rendered = await renderClipToAudio({
      project: store.project,
      assets: store.buffers,
      target: { kind: 'pattern', clipId: 'beat' },
      includeEffects: false,
      normalize: false,
    })
    const origin = beatSpanSamples(store.project, 2, 4).start
    expect(rendered.startSample).toBe(origin)
    const hits = renderPattern(pattern, 0, 4)
    expect(hits.length).toBeGreaterThan(8)
    for (const hit of hits) {
      const at = beatSpanSamples(store.project, 2 + hit.startBeat, 0.05).start - origin
      let peak = 0
      const end = Math.min(rendered.channels[0].length, at + 1500)
      for (let i = Math.max(0, at); i < end; i++) {
        peak = Math.max(peak, Math.abs(rendered.channels[0][i] || 0), Math.abs(rendered.channels[1][i] || 0))
      }
      expect(peak, `${hit.kind} at ${hit.startBeat}`).toBeGreaterThan(0.005)
    }
  })

  it('places the audio in one undo, then reloads the 24-bit wav', async () => {
    const { store, keys } = studio()
    keys.midiClips = [lead(4)]
    store.selectClip(keys.id, 'lead', true)
    store.openRenderForSelection()
    store.setRenderChoice({ includeEffects: false, normalize: false, place: 'mute' })
    const before = store.project.tracks.map((track) => track.id)
    await store.runRenderAudio()
    const added = store.project.tracks.find((track) => !before.includes(track.id))!
    expect(added.type).toBe('audio')
    expect(added.kind).toBe('loop')
    expect(added.name).toBe('Lead (audio)')
    expect(added.clips[0].name).toBe('Lead (audio)')
    expect(added.clips[0].startSample).toBe(beatSpanSamples(store.project, 4, 1).start)
    expect(added.clips[0].stretch?.followTempo).toBe(false)
    expect(added.clips[0].playback).toBeUndefined()
    expect(keys.midiClips[0].muted).toBe(true)
    expect(store.project.tracks[store.project.tracks.findIndex((track) => track.id === keys.id) + 1].id).toBe(added.id)
    const asset = store.buffers.get(added.clips[0].bufferId)!
    expect(asset.pcmBits).toBe(24)
    expect(asset.sampleRate).toBe(48000)

    store.undo()
    expect(store.project.tracks.map((track) => track.id)).toEqual(before)
    expect(keys.midiClips[0].muted).toBeFalsy()
    store.redo()
    expect(keys.midiClips[0].muted).toBe(true)
    expect(store.project.tracks.some((track) => track.id === added.id)).toBe(true)
    expect(store.buffers.get(asset.id)?.channels[0].length).toBe(asset.channels[0].length)

    const encoded = await encodedAssetWav(asset)
    const wav = encoded.wav.buffer.slice(encoded.wav.byteOffset, encoded.wav.byteOffset + encoded.wav.byteLength) as ArrayBuffer
    const header = parseWavHeader(wav)
    expect(header.bits).toBe(24)
    expect(header.format).toBe(1)
    expect(header.sampleRate).toBe(48000)
    const decoded = decodeWavPCM(wav)
    let error = 0
    for (let i = 0; i < decoded.channels[0].length; i++) {
      error = Math.max(error, Math.abs((decoded.channels[0][i] || 0) - (asset.channels[0][i] || 0)))
    }
    expect(error).toBeLessThan(1e-5)
    const reloaded = new ProjectStore(createEmptyProject())
    const project = structuredClone(store.project)
    reloaded.loadProject(project, new Map([[asset.id, { ...asset, channels: decoded.channels, pcmBits: 24 }]]))
    const clip = reloaded.project.tracks.flatMap((track) => track.clips).find((item) => item.bufferId === asset.id)!
    expect(clip.name).toBe('Lead (audio)')
    expect(clip.stretch?.followTempo).toBe(false)
    expect(reloaded.buffers.get(asset.id)?.sampleRate).toBe(48000)
    reloaded.setClipStretch(added.id, clip.id, { followTempo: true, tempoMode: 'follow', sourceBpm: 120 })
    expect(reloaded.project.tracks.find((track) => track.id === added.id)?.clips[0].stretch?.followTempo).toBe(true)
    reloaded.applyKeyShift({ trackId: added.id, clipId: clip.id, semitones: 2, from: 'C major', to: 'D major', tonicOnly: false, always: false })
    expect(reloaded.project.tracks.find((track) => track.id === added.id)?.clips[0].stretch?.semitones).toBe(2)
  })

  it('replace and keep are each a single undo', async () => {
    const replaced = studio()
    replaced.keys.midiClips = [lead(0)]
    replaced.store.selectClip(replaced.keys.id, 'lead', true)
    replaced.store.openRenderForSelection()
    replaced.store.setRenderChoice({ includeEffects: false, place: 'replace' })
    await replaced.store.runRenderAudio()
    expect(replaced.keys.midiClips.some((clip) => clip.id === 'lead')).toBe(false)
    expect(replaced.store.project.tracks.some((track) => track.name === 'Lead (audio)')).toBe(true)
    replaced.store.undo()
    expect(replaced.keys.midiClips.some((clip) => clip.id === 'lead')).toBe(true)
    expect(replaced.store.project.tracks.some((track) => track.name === 'Lead (audio)')).toBe(false)

    const kept = studio()
    kept.keys.midiClips = [lead(0)]
    kept.store.selectClip(kept.keys.id, 'lead', true)
    kept.store.openRenderForSelection()
    kept.store.setRenderChoice({ includeEffects: false, place: 'keep' })
    await kept.store.runRenderAudio()
    expect(kept.keys.midiClips[0].muted).toBeFalsy()
    expect(kept.store.project.tracks.some((track) => track.name === 'Lead (audio)')).toBe(true)
    kept.store.undo()
    expect(kept.store.project.tracks.some((track) => track.name === 'Lead (audio)')).toBe(false)
  })

  it('includes track inserts and leaves the master bus out', async () => {
    const { store, keys } = studio()
    keys.midiClips = [lead(0)]
    const dry = await renderLead(store, keys.id, false)
    const limiter = createPlugin('limiter')
    limiter.params = { ...limiter.params, kind: 0, threshold: -30, ceiling: -12, release: 20 }
    keys.plugins = [limiter]
    const wet = await renderLead(store, keys.id, true)
    expect(wet.peak).toBeLessThan(dry.peak)
    store.project.masterVolume = 0.01
    store.project.masterPlugins = [createPlugin('limiter')]
    const still = await renderLead(store, keys.id, true)
    const delta = residual(wet.channels[0], still.channels[0])
    expect(delta.peakDb).toBeLessThanOrEqual(-60)
  })

  it('renders a 16-bar part faster than realtime', async () => {
    const { store, keys } = studio()
    const notes = Array.from({ length: 64 }, (_, index) => ({
      id: `n${index}`,
      pitch: 48 + (index % 7),
      startBeat: index,
      durationBeats: 0.9,
      velocity: 0.75,
    }))
    keys.midiClips = [{ id: 'part', name: 'Part', startBeat: 0, durationBeats: 64, notes }]
    const started = performance.now()
    const rendered = await renderClipToAudio({
      project: store.project,
      assets: store.buffers,
      target: { kind: 'midi', trackId: keys.id, clipId: 'part' },
      includeEffects: true,
      normalize: false,
      onProgress: () => undefined,
    })
    const elapsed = performance.now() - started
    const seconds = rendered.musicalSamples / rendered.sampleRate
    expect(seconds).toBeGreaterThan(30)
    expect(elapsed).toBeLessThan(seconds * 1000)
    expect(rendered.channels[0].some((sample) => Math.abs(sample) > SILENCE_AMP)).toBe(true)
    console.info(`render-speed ${elapsed.toFixed(1)} ms for ${seconds.toFixed(2)} s (${(seconds / (elapsed / 1000)).toFixed(1)}x realtime)`)
  }, 60_000)

  it('shows a working control for the clip, the pattern, and the track', () => {
    const { store, keys } = studio()
    keys.midiClips = [lead(0)]
    store.selectClip(keys.id, 'lead', true)
    const vary = renderToStaticMarkup(createElement(VariationBar, { store }))
    expect(vary).toContain('Render to audio')
    expect(vary).toContain('Variation')
    store.openRenderForSelection()
    const sheet = renderToStaticMarkup(createElement(RenderAudioSheet, { store }))
    expect(sheet).toContain('Include track effects')
    expect(sheet).toContain('Normalize')
    expect(sheet).toContain('Mute original')
    expect(sheet).toContain('Replace')
    expect(sheet).toContain('Keep both')
    expect(sheet).toContain('>Render<')
    expect(sheet).toContain('Close')
    const options = renderToStaticMarkup(createElement(TrackOptions, {
      store,
      track: keys,
      level: 0.4,
      automationOpen: false,
      participants: [],
      onClose() {},
      onPerform() {},
      onAnalyze() {},
    }))
    expect(options).toContain('Render track to audio')
    store.cancelRenderAudio()
    const pattern = starterPattern()
    store.project.beats = { activeId: pattern.id, patterns: [pattern] }
    store.project.patternClips = [{ id: 'beat', patternId: pattern.id, startBeat: 0, lengthBeats: 4, scene: null, trackId: keys.id, placed: true }]
    store.selectClip(keys.id, 'beat')
    expect(renderToStaticMarkup(createElement(VariationBar, { store }))).toContain('Render to audio')
  })

  it('matches the live worklet, including a legato retrigger and automation at the clip', async () => {
    const { store, keys } = studio()
    const device = keys.rack!.devices[0]
    device.params = { ...device.params, famt: 0, sustain: 1, release: 400 }
    keys.midiClips = [{
      id: 'lead',
      name: 'Lead',
      startBeat: 4,
      durationBeats: 2,
      notes: [
        { id: 'a', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 },
        { id: 'b', pitch: 60, startBeat: 1, durationBeats: 1, velocity: 0.72 },
      ],
    }]
    store.project.rackAutomation = [{
      id: 'cut',
      deviceId: device.id,
      param: 'cutoff',
      points: [{ beat: 0, value: 180 }, { beat: 8, value: 9000 }],
    }]
    const rendered = await renderLead(store, keys.id)
    const clip = keys.midiClips[0]
    const span = beatSpanSamples(store.project, clip.startBeat, clip.durationBeats)
    const events: { time: number; pitch: number; vel: number }[] = []
    for (const note of prepareClipNotes(store.project, keys, clip)) {
      const noteSpan = beatSpanSamples(store.project, clip.startBeat + note.startBeat, note.durationBeats)
      events.push({ time: Math.max(0, (noteSpan.start - span.start) / 48000), pitch: note.pitch, vel: note.velocity })
      events.push({ time: Math.max(0, (noteSpan.start + noteSpan.duration - span.start) / 48000), pitch: note.pitch, vel: 0 })
    }
    const originBeat = projectSampleBeat(store.project, span.start)
    const live = liveRack(keys.rack!, store.project.tempo, originBeat, events, rendered.channels[0].length, rackLanesFor(store.project, keys.id))
    const left = residual(rendered.channels[0], live[0])
    const right = residual(rendered.channels[1], live[1])
    expect(left.peakDb).toBeLessThanOrEqual(-60)
    expect(right.peakDb).toBeLessThanOrEqual(-60)
    expect(left.rmsDb).toBeLessThanOrEqual(-60)
    expect(right.rmsDb).toBeLessThanOrEqual(-60)
    const shifted = liveRack(keys.rack!, store.project.tempo, 0, events, rendered.channels[0].length, rackLanesFor(store.project, keys.id))
    expect(residual(rendered.channels[0], shifted[0]).peakDb).toBeGreaterThan(-40)
  })

  it('prints an 808 slide with the same voice and keeps the release', async () => {
    const store = new ProjectStore(createEmptyProject(48000, '808'))
    const id = store.addQuickTrack('bass808')!
    const track = store.track(id)!
    track.midiClips = [{
      id: 'slide',
      name: 'Slide',
      startBeat: 0,
      durationBeats: 2,
      notes: [
        { id: 'a', pitch: 36, startBeat: 0, durationBeats: 1, velocity: 0.9 },
        { id: 'b', pitch: 48, startBeat: 1, durationBeats: 1, velocity: 0.85, slide: true },
      ],
    }]
    const tail = releaseTailSamples(track, 48000, false)
    expect(tail).toBeGreaterThanOrEqual(Math.round(BASS808_RELEASE_SEC * 10.36 * 48000) - 1)
    const rendered = await renderClipToAudio({
      project: store.project,
      assets: store.buffers,
      target: { kind: 'midi', trackId: id, clipId: 'slide' },
      includeEffects: false,
      normalize: false,
    })
    const clip = track.midiClips[0]
    const span = beatSpanSamples(store.project, clip.startBeat, clip.durationBeats)
    const length = span.duration + tail
    const events: { time: number; pitch: number; vel: number; slide?: boolean }[] = []
    for (const note of prepareClipNotes(store.project, track, clip)) {
      const noteSpan = beatSpanSamples(store.project, clip.startBeat + note.startBeat, note.durationBeats)
      events.push({ time: Math.max(0, (noteSpan.start - span.start) / 48000), pitch: note.pitch, vel: note.velocity, slide: !!note.slide })
      events.push({ time: Math.max(0, (noteSpan.start + noteSpan.duration - span.start) / 48000), pitch: note.pitch, vel: 0 })
    }
    expect(events.some((event) => event.slide)).toBe(true)
    const originBeat = projectSampleBeat(store.project, span.start)
    const reference = liveRack(track.rack!, store.project.tempo, originBeat, events, length, rackLanesFor(store.project, id))
    const left = residual(rendered.channels[0], reference[0])
    const right = residual(rendered.channels[1], reference[1])
    expect(left.peakDb).toBeLessThanOrEqual(-60)
    expect(right.peakDb).toBeLessThanOrEqual(-60)
    expect(left.rmsDb).toBeLessThanOrEqual(-60)
    expect(right.rmsDb).toBeLessThanOrEqual(-60)
    expect(rendered.channels[0].length).toBeGreaterThan(rendered.musicalSamples)
    const after = rendered.musicalSamples + Math.round(0.2 * 48000)
    let release = 0
    for (let i = rendered.musicalSamples; i < Math.min(rendered.channels[0].length, after); i++) {
      release = Math.max(release, Math.abs(rendered.channels[0][i] || 0))
    }
    expect(release).toBeGreaterThan(SILENCE_AMP)
    const end = Math.max(Math.abs(rendered.channels[0].at(-1) || 0), Math.abs(rendered.channels[1].at(-1) || 0))
    expect(end).toBeLessThan(SILENCE_AMP * 4)
  })

  it('nulls Keys with filter and reverb devices, a track reverb insert, and a sampler voice', async () => {
    const { store, keys } = studio()
    keys.rack!.devices.push(makeDevice('filter'), makeDevice('reverb'))
    keys.midiClips = [lead(0)]
    const devices = await renderLead(store, keys.id)
    const span = beatSpanSamples(store.project, 0, 1)
    const deviceLive = liveRack(keys.rack!, store.project.tempo, 0, [
      { time: 0, pitch: 60, vel: 0.8 },
      { time: span.duration / 48000, pitch: 60, vel: 0 },
    ], devices.channels[0].length)
    expect(residual(devices.channels[0], deviceLive[0]).peakDb).toBeLessThanOrEqual(-60)
    expect(residual(devices.channels[1], deviceLive[1]).peakDb).toBeLessThanOrEqual(-60)

    const { store: wetStore, keys: wetKeys } = studio()
    wetKeys.midiClips = [lead(0)]
    const reverb = createPlugin('reverb')
    reverb.params = { ...reverb.params, kind: 2, mix: 0.45, size: 0.8, decay: 0.7 }
    wetKeys.plugins = [reverb]
    const wet = await renderLead(wetStore, wetKeys.id, true)
    const dryLive = liveRack(wetKeys.rack!, wetStore.project.tempo, 0, [
      { time: 0, pitch: 60, vel: 0.8 },
      { time: span.duration / 48000, pitch: 60, vel: 0 },
    ], Math.max(1, span.duration + releaseTailSamples(wetKeys, 48000, true)))
    const inserted = await renderLiveInserts(wetKeys, dryLive, wetStore.project, 0, 48000)
    const wetLeft = residual(wet.channels[0], inserted[0].slice(0, wet.channels[0].length))
    expect(wetLeft.peakDb).toBeLessThanOrEqual(-60)

    const { store: sampStore, keys: samp } = studio()
    const tone = new Float32Array(4800)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.5
    const plugin = createPlugin('sampler')
    plugin.sampler = { ...emptySampler(), bufferId: 'tone', root: 60, loopMode: 2 }
    samp.instrument = 'sampler'
    samp.plugins = [plugin]
    samp.midiClips = [lead(0)]
    sampStore.buffers.set('tone', { id: 'tone', name: 'tone', sampleRate: 48000, channels: [tone] })
    const sampled = await renderClipToAudio({
      project: sampStore.project,
      assets: sampStore.buffers,
      target: { kind: 'midi', trackId: samp.id, clipId: 'lead' },
      includeEffects: false,
      normalize: false,
    })
    const reference = renderSamplerSpan(plugin, tone, [
      { time: 0, pitch: 60, vel: 0.8 },
      { time: span.duration / 48000, pitch: 60, vel: 0 },
    ], 48000, sampled.channels[0].length, false)
    expect(residual(sampled.channels[0], reference[0]).peakDb).toBeLessThanOrEqual(-60)
    expect(residual(sampled.channels[1], reference[1]).peakDb).toBeLessThanOrEqual(-60)
  })
})

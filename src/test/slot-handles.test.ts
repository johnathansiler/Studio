import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createLooper } from '../audio/plugins/looper'
import { createSampler } from '../audio/plugins/sampler'
import { createPlugin } from '../audio/plugins/catalog'
import { emptyLooper } from '../audio/sample/engine'
import {
  assetFromClip,
  captureSlot,
  clampSlotPoints,
  decodeSlotBytes,
  dragSlotPoint,
  fitOverdub,
  placeLooper,
  placeSampler,
  readSlotPoints,
} from '../audio/sample/slot'
import { encodeWav } from '../model/wav'
import { createEmptyProject, type AudioClip, type PluginInstance } from '../model/types'
import { ProjectStore } from '../state/store'
import { SamplePanel } from '../ui/SamplePanel'

function tone(length: number, value: number, from = 0, to = length) {
  const out = new Float32Array(length)
  for (let i = from; i < to && i < length; i++) out[i] = value
  return out
}

function block() {
  return {
    sampleRate: 48000,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    quality: 'full' as const,
  }
}

function playSampler(plugin: PluginInstance, channel: Float32Array, frames: number, note = 60) {
  const proc = createSampler(48000)
  proc.bind(plugin, () => channel)
  proc.note(note, 1)
  const output = [new Float32Array(frames), new Float32Array(frames)]
  const silent = [new Float32Array(frames), new Float32Array(frames)]
  proc.process(silent, output, plugin.params, block())
  return output[0]
}

describe('slot handles, slices, and overdub', () => {
  it('keeps the loop inside the start and end handles', () => {
    expect(readSlotPoints(null)).toEqual({ start: 0, end: 1, loopStart: 0, loopEnd: 1 })
    const dragged = dragSlotPoint({ start: 0, end: 1, loopStart: 0, loopEnd: 1 }, 'start', 0.4)
    expect(dragged.start).toBeCloseTo(0.4)
    expect(dragged.loopStart).toBeGreaterThanOrEqual(dragged.start)
    const squeezed = dragSlotPoint(dragged, 'end', 0.42)
    expect(squeezed.end).toBeGreaterThan(squeezed.start)
    expect(squeezed.loopEnd).toBeLessThanOrEqual(squeezed.end)
    expect(squeezed.loopEnd).toBeGreaterThan(squeezed.loopStart)
    expect(clampSlotPoints({ start: 2, end: -1, loopStart: 5, loopEnd: -3 }).start).toBe(1)
  })

  it('drops the count-in and keeps the recorded samples', async () => {
    let deliver: (frame: Float32Array) => void = () => undefined
    const audio = await captureSlot({
      sampleRate: 1000,
      start(onFrame) {
        deliver = onFrame
        onFrame(Float32Array.from([1, 1, 1]))
        return () => undefined
      },
    }, {
      countIn: true,
      tempo: 120,
      signature: { numerator: 1, denominator: 4 },
      maxSamples: 4,
    }, {
      shouldStop: () => false,
      onLevel: () => undefined,
      onPhase: () => undefined,
      wait: async () => { deliver(Float32Array.from([0.25, 0.5])) },
    })
    expect(Array.from(audio?.channels[0] ?? [])).toEqual([0.25, 0.5, 0.25, 0.5])
    expect(audio?.sampleRate).toBe(1000)
  })

  it('fits an overdub to the loop without resampling a matching take', () => {
    const channel = Float32Array.from([0.2, 0.4, 0.6, 0.8])
    expect(fitOverdub(channel, 48000, 48000, 4)).toBe(channel)
    const padded = fitOverdub(channel, 48000, 48000, 6)
    expect(Array.from(padded).map((sample) => Math.round(sample * 10) / 10)).toEqual([0.2, 0.4, 0.6, 0.8, 0, 0])
    const trimmed = fitOverdub(channel, 48000, 48000, 2)
    expect(Array.from(trimmed).map((sample) => Math.round(sample * 10) / 10)).toEqual([0.2, 0.4])
    const resampled = fitOverdub(channel, 24000, 48000, 8)
    expect(resampled.length).toBe(8)
    expect(resampled.every((sample) => Number.isFinite(sample))).toBe(true)
  })

  it('layers an overdub and leaves the first loop in place', () => {
    const looper = emptyLooper()
    looper.sync = false
    looper.loopStart = 0.25
    looper.loopEnd = 0.75
    const first = placeLooper(looper, {
      id: 'loop-a',
      name: 'Loop',
      sampleRate: 48000,
      channels: [Float32Array.from([0.5, 0.5, 0.5, 0.5])],
    }, 'replace', { tempo: 120, timeSignature: { numerator: 4, denominator: 4 } })
    expect(looper.layers).toHaveLength(1)
    expect(looper.loopStart).toBe(0)
    expect(first.channels[0]).toHaveLength(4)
    looper.loopStart = 0.25
    looper.loopEnd = 0.75
    const second = placeLooper(looper, {
      id: 'loop-b',
      name: 'Overdub',
      sampleRate: 48000,
      channels: [Float32Array.from([0.1, 0.2])],
    }, 'overdub', { tempo: 120, timeSignature: { numerator: 4, denominator: 4 } })
    expect(looper.layers).toHaveLength(2)
    expect(looper.layers[0].bufferId).toBe('loop-a')
    expect(looper.loopStart).toBeCloseTo(0.25)
    expect(Array.from(second.channels[0]).map((sample) => Math.round(sample * 10) / 10)).toEqual([0.1, 0.2, 0, 0])
    expect(looper.lengthSamples).toBe(4)
  })

  it('round-trips a wav into the slot and copies a clip region', () => {
    const channel = Float32Array.from([0, 0.5, -0.5, 0.25])
    const decoded = decodeSlotBytes(encodeWav([channel], 44100, { bits: 32 }))
    expect(decoded?.sampleRate).toBe(44100)
    expect(decoded?.channels[0][1]).toBeCloseTo(0.5, 5)
    const clip: Pick<AudioClip, 'name' | 'offsetSamples' | 'durationSamples'> = { name: 'Phrase', offsetSamples: 1, durationSamples: 2 }
    const region = assetFromClip({ id: 'src', name: 'Src', sampleRate: 44100, channels: [channel] }, clip, 'part')
    expect(Array.from(region?.channels[0] ?? [])).toEqual([0.5, -0.5])
    const sampler = createPlugin('sampler').sampler!
    placeSampler(sampler, { id: 'new', name: 'New', sampleRate: 44100, channels: [channel] })
    sampler.slices = [{ id: 'z', bufferId: 'old', root: 40, lo: 40, hi: 40, loopStart: 0, loopEnd: 1, tune: 0, gain: 1, pan: 0, reverse: false, choke: 0 }]
    placeSampler(sampler, { id: 'new', name: 'New', sampleRate: 44100, channels: [channel] })
    expect(sampler.bufferId).toBe('new')
    expect(sampler.slices).toEqual([])
    expect(sampler.sourceRate).toBe(44100)
  })

  it('stores an overdub, slices the handle window, and undoes one drag', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'sampler')
    store.addPlugin(track.id, 'looper')
    const sampler = track.plugins.find((plugin) => plugin.pluginId === 'sampler')!
    const looper = track.plugins.find((plugin) => plugin.pluginId === 'looper')!
    const channel = tone(96000, 0, 0, 96000)
    channel.fill(0.2, 48000)
    store.loadSlotAudio(track.id, sampler.id, { id: 'tone', name: 'Tone', sampleRate: 48000, channels: [channel] })
    store.setSlotPoints(track.id, sampler.id, { start: 0.5, end: 1, loopStart: 0.5, loopEnd: 1 })
    store.setSlotPoints(track.id, sampler.id, { start: 0.55, end: 1, loopStart: 0.55, loopEnd: 1 })
    store.endDraft()
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.start).toBeCloseTo(0.55)
    store.undo()
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.start).toBe(0)
    store.loadSlotAudio(track.id, sampler.id, { id: 'tone', name: 'Tone', sampleRate: 48000, channels: [channel] })
    store.setSlotPoints(track.id, sampler.id, { start: 0.5, end: 1, loopStart: 0.5, loopEnd: 1 })
    store.endDraft()
    store.chopSample(track.id, sampler.id, 'beat')
    const slices = store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.slices
    expect(slices.length).toBeGreaterThan(1)
    expect(slices.every((slice) => slice.loopStart >= 0.5 - 1e-6)).toBe(true)
    expect(slices[0].loopEnd).toBeGreaterThan(slices[0].loopStart)
    store.chopSample(track.id, sampler.id, 'grid')
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.slices).toHaveLength(16)
    store.exportSlices(track.id, sampler.id)
    const midi = store.project.tracks.find((item) => item.type === 'midi')!
    expect(midi.midiClips.some((clip) => clip.name === 'Slices' && clip.notes.length === 16)).toBe(true)

    store.loadSlotAudio(track.id, looper.id, { id: 'base', name: 'Base', sampleRate: 48000, channels: [Float32Array.from([0.4, 0.4, 0.4, 0.4])] })
    store.setSlotPoints(track.id, looper.id, { start: 0.1, end: 0.9, loopStart: 0.2, loopEnd: 0.8 })
    store.endDraft()
    store.loadSlotAudio(track.id, looper.id, { id: 'dub', name: 'Dub', sampleRate: 48000, channels: [Float32Array.from([0.05, 0.05, 0.05, 0.05])] }, 'overdub')
    const loop = store.track(track.id)!.plugins.find((plugin) => plugin.id === looper.id)!.looper!
    expect(loop.layers).toHaveLength(2)
    expect(loop.loopStart).toBeCloseTo(0.2)
    expect(loop.layers[0].bufferId).toBe('base')
    store.loadSlotAudio(track.id, looper.id, { id: 'next', name: 'Next', sampleRate: 48000, channels: [Float32Array.from([0.3, 0.3, 0.3, 0.3])] }, 'replace')
    const replaced = store.track(track.id)!.plugins.find((plugin) => plugin.id === looper.id)!.looper!
    expect(replaced.layers).toHaveLength(1)
    expect(replaced.layers[0].bufferId).toBe('next')

    const clip: AudioClip = {
      id: 'clip',
      name: 'Clip',
      bufferId: 'tone',
      startSample: 0,
      offsetSamples: 100,
      durationSamples: 50,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local',
    }
    const live = store.project.tracks[0]
    store.buffers.set('tone', { id: 'tone', name: 'Tone', sampleRate: 48000, channels: [channel] })
    live.clips.push(clip)
    expect(store.sendClipToSlot(live.id, sampler.id, live.id, 'clip')).toBe(true)
    const loaded = store.buffers.get(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.bufferId)
    expect(loaded?.channels[0].length).toBe(50)
    expect(store.sendClipToSlot(track.id, sampler.id, track.id, 'missing')).toBe(false)
  })

  it('plays from the start handle, then repeats between the loop handles', () => {
    const channel = tone(1000, 1)
    channel.fill(0.5, 200, 400)
    channel.fill(-0.75, 400, 700)
    const plugin = createPlugin('sampler')
    plugin.sampler!.bufferId = 'tone'
    plugin.sampler!.sourceRate = 48000
    plugin.sampler!.start = 0.2
    plugin.sampler!.end = 0.7
    plugin.sampler!.loopStart = 0.4
    plugin.sampler!.loopEnd = 0.7
    plugin.sampler!.loopMode = 0
    plugin.params = { ...plugin.params, stretch: 0, keys: 1, attack: 0, gain: 1, cutoff: 20000, release: 5 }
    const looped = playSampler(plugin, channel, 32)
    expect(looped[24]).toBeGreaterThan(0.35)
    const later = playSampler(plugin, channel, 320)
    expect(later[280]).toBeLessThan(-0.4)

    plugin.sampler!.loopMode = 2
    const once = playSampler(plugin, channel, 64)
    expect(once[24]).toBeGreaterThan(0.35)
    expect(once.every((sample) => sample < 0.9)).toBe(true)
  })

  it('plays a slice and a loop only inside the dragged window', () => {
    const channel = tone(1000, 0.2)
    channel.fill(0.8, 0, 100)
    const plugin = createPlugin('sampler')
    plugin.sampler!.sourceRate = 48000
    plugin.sampler!.bufferId = 'tone'
    plugin.sampler!.slices = [{
      id: 'pad',
      bufferId: 'tone',
      root: 48,
      lo: 48,
      hi: 48,
      loopStart: 0.5,
      loopEnd: 1,
      tune: 0,
      gain: 1,
      pan: 0,
      reverse: false,
      choke: 0,
    }]
    plugin.params = { ...plugin.params, stretch: 0, keys: 1, attack: 0, gain: 1, cutoff: 20000 }
    const sliced = playSampler(plugin, channel, 32, 48)
    expect(sliced[20]).toBeGreaterThan(0.1)
    expect(sliced[20]).toBeLessThan(0.35)

    const loopPlugin = createPlugin('looper')
    const data = tone(100, 0.25)
    data.fill(0.8, 50)
    loopPlugin.looper = {
      ...emptyLooper(),
      layers: [{ id: 'layer', bufferId: 'loop', gain: 1, mute: false, reverse: false, speed: 1 }],
      lengthSamples: 100,
      sourceRate: 48000,
      transport: 1,
      start: 0,
      end: 1,
      loopStart: 0.5,
      loopEnd: 1,
    }
    loopPlugin.params = { ...loopPlugin.params, transport: 1, level: 1, sync: 0 }
    const proc = createLooper(48000)
    proc.bind(loopPlugin, () => data)
    const output = [new Float32Array(16), new Float32Array(16)]
    proc.process([new Float32Array(16), new Float32Array(16)], output, loopPlugin.params, block())
    expect(output[0][0]).toBeCloseTo(0.8, 2)
    expect(output[0].every((sample) => sample > 0.7)).toBe(true)
  })

  it('shows start, end, and loop handles on the waveform', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'looper')
    const plugin = track.plugins.find((item) => item.pluginId === 'looper')!
    store.loadSlotAudio(track.id, plugin.id, { id: 'loop', name: 'Loop', sampleRate: 48000, channels: [tone(32, 0.2)] })
    const engine = {
      takeLoop: () => null,
      currentTimelineSample: () => 0,
      rewindLoop: () => undefined,
      previewSample: () => undefined,
    } as unknown as AudioEngine
    const html = renderToStaticMarkup(createElement(SamplePanel, { store, engine, trackId: track.id, plugin }))
    expect(html).toContain('aria-label="Start. Drag to set where the sample begins."')
    expect(html).toContain('aria-label="End. Drag to set where the sample ends."')
    expect(html).toContain('aria-label="Loop start. Drag to set where the loop repeats."')
    expect(html).toContain('aria-label="Loop end. Drag to set where the loop returns."')
    expect(html).toContain('Dub')
    expect(html).toContain('Record')
  })
})

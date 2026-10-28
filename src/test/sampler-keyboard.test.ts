import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createSampler } from '../audio/plugins/sampler'
import { createPlugin } from '../audio/plugins/catalog'
import { gainStep, playbackRateFor } from '../audio/sample/pitch'
import { yinPitch } from '../audio/stretch/voice'
import { createEmptyProject, type PluginInstance } from '../model/types'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'

function sine(freq: number, rate: number, seconds: number) {
  const length = Math.floor(rate * seconds)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.6
  return out
}

function renderNote(plugin: PluginInstance, channel: Float32Array, note: number, frames: number, releaseAt = -1) {
  const rate = 48000
  const proc = createSampler(rate)
  proc.bind(plugin, () => channel)
  proc.note(note, 0.9)
  const left = new Float32Array(frames)
  const block = 128
  let offset = 0
  let released = false
  while (offset < frames) {
    const n = Math.min(block, frames - offset)
    if (!released && releaseAt >= 0 && offset >= releaseAt) {
      proc.note(note, 0)
      released = true
    }
    const input = [new Float32Array(n), new Float32Array(n)]
    const output = [new Float32Array(n), new Float32Array(n)]
    proc.process(input, output, plugin.params, {
      sampleRate: rate,
      tempo: 120,
      sampleTime: offset,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [],
      quality: 'full',
    })
    left.set(output[0], offset)
    offset += n
  }
  return left
}

describe('chromatic sampler', () => {
  it('maps every key to playbackRate 2^((note-root)/12)', () => {
    expect(playbackRateFor(60, 60)).toBe(1)
    expect(playbackRateFor(72, 60)).toBe(2)
    expect(playbackRateFor(48, 60)).toBeCloseTo(0.5)
    expect(playbackRateFor(67, 60)).toBeCloseTo(2 ** (7 / 12))
    for (let note = 36; note <= 84; note++) {
      expect(playbackRateFor(note, 60)).toBeCloseTo(2 ** ((note - 60) / 12))
    }
  })

  it('plays a sample up an octave and follows a root override', () => {
    const rate = 48000
    const channel = sine(440, rate, 1)
    const plugin = createPlugin('sampler', 'Keys')
    plugin.sampler!.bufferId = 'a'
    plugin.sampler!.sourceRate = rate
    plugin.sampler!.root = 69
    plugin.sampler!.loopMode = 0
    plugin.params = { ...plugin.params, keys: 1, stretch: 0, attack: 4, decay: 20, sustain: 1, release: 40, gain: 1, cutoff: 18000 }
    const up = renderNote(plugin, channel, 81, rate)
    const heard = yinPitch(up.subarray(rate / 4, rate / 4 + 4096), rate, 600, 1400).hz
    expect(heard).toBeGreaterThan(800)
    expect(heard).toBeLessThan(960)

    plugin.sampler!.root = 57
    const overridden = renderNote(plugin, channel, 69, rate)
    const shifted = yinPitch(overridden.subarray(rate / 4, rate / 4 + 4096), rate, 600, 1400).hz
    expect(shifted).toBeGreaterThan(800)
    expect(shifted).toBeLessThan(960)
  })

  it('ramps gain on note start and stop instead of jumping', () => {
    expect(gainStep(0, 1, 0)).toBeGreaterThan(0)
    expect(gainStep(0, 1, 0)).toBeLessThan(1)
    expect(Math.abs(gainStep(0.8, 0, 1) - 0.8)).toBeLessThan(0.7)
    expect(gainStep(0.8, 0, 1)).toBeGreaterThan(0)

    const rate = 48000
    const channel = new Float32Array(rate).fill(0.8)
    const plugin = createPlugin('sampler', 'Keys')
    plugin.sampler!.bufferId = 'dc'
    plugin.sampler!.sourceRate = rate
    plugin.sampler!.root = 60
    plugin.sampler!.loopMode = 2
    plugin.params = { ...plugin.params, keys: 1, stretch: 0, attack: 30, decay: 10, sustain: 1, release: 40, gain: 1, cutoff: 18000 }
    const audio = renderNote(plugin, channel, 60, 8000, 4000)
    expect(Math.abs(audio[0])).toBeGreaterThan(0)
    expect(Math.abs(audio[0])).toBeLessThan(0.2)
    expect(Math.abs(audio[2000])).toBeGreaterThan(0.4)
    const before = Math.abs(audio[3990])
    const after = Math.abs(audio[4010])
    expect(before).toBeGreaterThan(0.3)
    expect(after).toBeGreaterThan(0.05)
    expect(before - after).toBeLessThan(before * 0.5)
    expect(Math.abs(audio[7000])).toBeLessThan(before * 0.35)
  })

  it('stores a root override on the sampler instrument', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    const channel = sine(330, 48000, 0.2)
    store.loadSamplerSound(track.id, { id: 'tone', name: 'Tone', sampleRate: 48000, channels: [channel] })
    expect(store.track(track.id)?.instrument).toBe('sampler')
    const plugin = store.track(track.id)!.plugins.find((item) => item.pluginId === 'sampler')!
    expect(plugin.sampler?.bufferId).toBe('tone')
    expect(plugin.params.keys).toBe(1)
    store.setSamplerRoot(track.id, 64)
    expect(store.track(track.id)!.plugins.find((item) => item.pluginId === 'sampler')!.sampler!.root).toBe(64)
  })
})

describe('piano roll button', () => {
  it('opens the clicked instrument track and leaves the others alone', () => {
    const store = new ProjectStore(createEmptyProject())
    store.addTrack('midi')
    const [first, second] = store.project.tracks.filter((track) => track.type === 'midi')
    store.preparePianoClip(second.id, 0)
    expect(store.selectedTrackId).toBe(second.id)
    expect(store.selectedMidiClipId).toBe(store.track(second.id)!.midiClips[0].id)
    expect(store.track(first.id)!.midiClips).toHaveLength(0)
    expect(store.track(second.id)!.midiClips[0].notes).toHaveLength(0)
  })

  it('draws a piano roll button only on instrument tracks', () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} })
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine: {
        positionSamples: 0,
        subscribe: () => () => undefined,
        currentTimelineSample: () => 0,
        stopPreview() {},
        previewPcm() {},
        unlock() {},
      },
      session: { state: { participants: [], selfId: 'me' } },
      onSeek: () => undefined,
      onOpenPiano: () => undefined,
      onPerform: () => undefined,
      onQuickPunch: () => undefined,
      onAnalyze: () => undefined,
    } as never))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    const audio = store.project.tracks.find((track) => track.type === 'audio')!
    expect(html).toContain(`data-piano="${keys.id}"`)
    expect(html).toContain('aria-label="Piano roll"')
    expect(html).not.toContain(`data-piano="${audio.id}"`)
  })
})

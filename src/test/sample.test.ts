import { describe, expect, it } from 'vitest'
import { createSampler } from '../audio/plugins/sampler'
import { automationAt, createPlugin } from '../audio/plugins/catalog'
import {
  detectRoot,
  layerGain,
  mixTakes,
  nextBar,
  overdubTake,
  recordTake,
  redoTake,
  renderLooped,
  sampleVoiceLimit,
  sliceBeats,
  sliceTransients,
  snapZero,
  syncedLoopSamples,
  tempoFromLoop,
  undoTake,
  zoneFor,
  type LoopBox,
  type SampleZone,
} from '../audio/sample/engine'
import { createEmptyProject, type PluginInstance } from '../model/types'
import { ProjectStore } from '../state/store'

function sine(length: number, freq: number, sampleRate: number) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

function clean(channel: Float32Array) {
  for (const sample of channel) {
    expect(Number.isFinite(sample)).toBe(true)
    expect(sample === 0 || Math.abs(sample) >= 1e-15).toBe(true)
  }
}

describe('sampler and looper', () => {
  it('slices transients on the impulse', () => {
    const rate = 48000
    const channel = new Float32Array(rate)
    for (const at of [1000, 5000, 9000]) channel[at] = 1
    const slices = sliceTransients(channel, rate, 0.9)
    const starts = slices.map((slice) => slice.start)
    expect(starts).toContain(0)
    expect(starts).toContain(1000)
    expect(starts).toContain(5000)
    expect(starts).toContain(9000)
  })

  it('crossfades a loop so the wrap does not click', () => {
    const channel = new Float32Array(400)
    for (let i = 0; i < channel.length; i++) channel[i] = i < 200 ? 0.8 : -0.8
    const played = renderLooped(channel, 0, 400, 420, 48, 0)
    clean(played)
    const jump = Math.abs((played[400] || 0) - (played[399] || 0))
    expect(jump).toBeLessThan(0.08)
    const bare = renderLooped(channel, 0, 400, 420, 0, 0)
    expect(Math.abs((bare[400] || 0) - (bare[399] || 0))).toBeGreaterThan(jump)
  })

  it('keeps a synced loop an exact number of bars', () => {
    expect(syncedLoopSamples(1, 120, 48000, 4)).toBe(96000)
    expect(syncedLoopSamples(4, 120, 48000, 4)).toBe(384000)
    expect(tempoFromLoop(96000, 48000, 4)).toBe(120)
    expect(nextBar(4.2, 4)).toBe(8)
    expect(nextBar(4, 4)).toBe(4)
  })

  it('layers an overdub and undoes it', () => {
    const box: LoopBox = { length: 0, takes: [], undone: [], feedback: 0.5 }
    const first = recordTake(box, new Float32Array(8).fill(0.5), 8)
    const second = overdubTake(first, new Float32Array(8).fill(0.25))
    const mixed = mixTakes(second)
    clean(mixed)
    expect(mixed[0]).toBeCloseTo(0.5 * layerGain(second.takes[0], 1, 0.5) + 0.25, 5)
    const undone = undoTake(second)
    expect(undone.takes).toHaveLength(1)
    expect(mixTakes(undone)[0]).toBeCloseTo(0.5, 5)
    expect(redoTake(undone).takes).toHaveLength(2)
  })

  it('round-trips slices, layers, and undo through the project', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'sampler')
    store.addPlugin(track.id, 'looper')
    const sampler = track.plugins.find((plugin) => plugin.pluginId === 'sampler')!
    const looper = track.plugins.find((plugin) => plugin.pluginId === 'looper')!
    const data = sine(8000, 440, 48000)
    data[10] = 0
    store.addAsset({ id: 'tone', name: 'Tone', sampleRate: 48000, channels: [data] })
    store.setSampleBuffer(track.id, sampler.id, 'tone')
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.root).toBe(69)
    store.chopSample(track.id, sampler.id, 'grid')
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === sampler.id)!.sampler!.slices).toHaveLength(16)
    store.exportSlices(track.id, sampler.id)
    const midi = store.project.tracks.find((item) => item.type === 'midi')!
    expect(midi.midiClips.some((clip) => clip.name === 'Slices' && clip.notes.length === 16)).toBe(true)
    store.addLooperLayer(track.id, looper.id, new Float32Array(96000).fill(0.2))
    store.addLooperLayer(track.id, looper.id, new Float32Array(96000).fill(0.1))
    store.undoLooper(track.id, looper.id)
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === looper.id)!.looper!.layers).toHaveLength(1)
    store.undo()
    expect(store.track(track.id)!.plugins.find((plugin) => plugin.id === looper.id)!.looper!.layers).toHaveLength(2)
    const saved = JSON.parse(JSON.stringify(store.project)) as { tracks: { plugins: PluginInstance[] }[] }
    const savedSampler = saved.tracks[0].plugins.find((plugin) => plugin.pluginId === 'sampler')
    expect(savedSampler?.sampler?.bufferId).toBeTruthy()
    expect(savedSampler?.sampler?.slices.length).toBe(16)
    expect(saved.tracks[0].plugins.find((plugin) => plugin.pluginId === 'looper')?.looper?.layers).toHaveLength(2)
    store.bounceLooper(track.id, looper.id, 0)
    expect(store.track(track.id)!.clips.some((clip) => clip.name === 'Loop')).toBe(true)
  })

  it('snaps to a zero crossing and picks the nearest zone', () => {
    const channel = sine(200, 100, 8000)
    const snapped = snapZero(channel, 3, 40)
    expect(Math.abs(channel[snapped] || 0)).toBeLessThan(0.2)
    const zones: SampleZone[] = [
      { id: 'a', bufferId: 'b', root: 60, lo: 0, hi: 127, loopStart: 0, loopEnd: 1, tune: 0, gain: 1, pan: 0, reverse: false, choke: 0 },
      { id: 'c', bufferId: 'b', root: 72, lo: 48, hi: 84, loopStart: 0, loopEnd: 1, tune: 0, gain: 1, pan: 0, reverse: false, choke: 1 },
    ]
    expect(zoneFor(zones, 70)?.id).toBe('c')
  })

  it('limits voices on eco and stays finite', () => {
    expect(sampleVoiceLimit('eco')).toBe(4)
    const plugin = createPlugin('sampler')
    plugin.sampler!.bufferId = 'tone'
    const tone = sine(480, 440, 48000)
    const proc = createSampler(48000)
    proc.bind(plugin, () => tone)
    for (let note = 60; note < 66; note++) proc.note(note, 0.8)
    const input = [new Float32Array(64), new Float32Array(64)]
    const output = [new Float32Array(64), new Float32Array(64)]
    proc.process(input, output, { ...plugin.params, stretch: 0, keys: 1 }, {
      sampleRate: 48000,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'eco',
    })
    expect(proc.sounding()).toBeLessThanOrEqual(4)
    clean(output[0])
    const lane = automationAt([{ id: 'a', pluginId: plugin.id, param: 'gain', points: [{ beat: 0, value: 0.25 }] }], plugin.id, plugin.params, 0)
    expect(lane.gain).toBeCloseTo(0.25)
  })

  it('uses the offline stretch for a bounce and the preview stretch while playing', () => {
    const play = (offline: boolean) => {
      const plugin = createPlugin('sampler')
      plugin.sampler!.bufferId = 'tone'
      const proc = createSampler(48000)
      proc.bind(plugin, () => sine(4000, 220, 48000))
      proc.note(48, 0.8)
      const output = [new Float32Array(256), new Float32Array(256)]
      proc.process([new Float32Array(256), new Float32Array(256)], output, { ...plugin.params, stretch: 1, keys: 0 }, {
        sampleRate: 48000,
        tempo: 120,
        sampleTime: 0,
        sidechain: null,
        scaleRoot: 0,
        scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
        quality: 'full',
        offline,
      })
      return output[0]
    }
    const bounced = play(true)
    const live = play(false)
    clean(bounced)
    clean(live)
    expect(bounced.some((sample, index) => sample !== live[index])).toBe(true)
  })

  it('places beat slices on exact beat boundaries', () => {
    const slices = sliceBeats(48000, 48000, 120, 1)
    expect(slices[0]).toEqual({ start: 0, end: 24000 })
    expect(slices[1]).toEqual({ start: 24000, end: 48000 })
    expect(detectRoot(sine(48000, 440, 48000), 48000)).toBe(69)
  })
})

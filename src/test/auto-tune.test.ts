import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { activeTunePreset, orderedInserts, tuneBlockScale, tuneLiveLatency, tuneScaleOf, tuneSnapMidi } from '../audio/plugins/autoTune'
import { CATALOG, FACTORY, createPlugin, defaultParams, tuneLatency } from '../audio/plugins/catalog'
import { createTune } from '../audio/plugins/tune'
import { yinPitch } from '../audio/plugins/psola'
import { renderGraph } from '../audio/renderGraph'
import { MASTERING_IDS } from '../audio/master/assistant'
import type { Processor } from '../audio/plugins/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { loadScaleCatalog } from '../theory'
import { AutoTuneFace, AutoTuneTrackButton } from '../ui/AutoTuneFace'

const rate = 48000
const major = [0, 2, 4, 5, 7, 9, 11]
const majorCents = major.map((interval) => interval * 100)
const bayati = [0, 150, 300, 500, 700, 900, 1050]

function hzOf(midi: number) {
  return 440 * 2 ** ((midi - 69) / 12)
}

function midiOf(hz: number) {
  return 69 + 12 * Math.log2(hz / 440)
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function sine(freq: number, seconds: number, amp = 0.35) {
  const n = Math.floor(rate * seconds)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return data
}

function hard() {
  return {
    ...defaultParams('tune'),
    amount: 1,
    retune: 1,
    humanize: 0,
    flex: 0,
    formant: 0,
    mode: 1,
    root: -1,
    scaleIndex: -1,
    minHz: 80,
    maxHz: 1200,
    transpose: 0,
    mask: 0,
  }
}

function run(
  processor: Processor,
  input: Float32Array,
  params: Record<string, number>,
  extra: { scaleRoot?: number; scaleIntervals?: readonly number[]; scaleCents?: readonly number[]; offline?: boolean } = {},
) {
  const left = new Float32Array(input.length)
  const rightIn = Float32Array.from(input)
  const right = new Float32Array(input.length)
  const context = {
    sampleRate: rate,
    tempo: 120,
    sampleTime: 0,
    sidechain: null,
    scaleRoot: extra.scaleRoot ?? 0,
    scaleIntervals: extra.scaleIntervals ?? major,
    scaleCents: extra.scaleCents ?? majorCents,
    quality: 'full' as const,
    offline: extra.offline ?? false,
  }
  const block = 128
  for (let offset = 0; offset < input.length; offset += block) {
    const count = Math.min(block, input.length - offset)
    processor.process(
      [input.subarray(offset, offset + count), rightIn.subarray(offset, offset + count)],
      [left.subarray(offset, offset + count), right.subarray(offset, offset + count)],
      params,
      { ...context, sampleTime: offset },
    )
  }
  return left
}

function pitchAt(buffer: Float32Array, skip: number) {
  return yinPitch(buffer.subarray(skip, skip + 4096), rate, 80, 1200).hz
}

describe('Auto-Tune insert', () => {
  it('leads the plugin list and starts audible in the project key', () => {
    expect(CATALOG[0].id).toBe('tune')
    expect(CATALOG[0].name).toBe('Auto-Tune')
    expect(orderedInserts([{ id: 'eq' }, { id: 'reverb' }, { id: 'tune' }]).map((item) => item.id)).toEqual(['tune', 'eq', 'reverb'])
    const listed = orderedInserts(CATALOG.filter((plugin) => plugin.id !== 'meter' && !(MASTERING_IDS as readonly string[]).includes(plugin.id)))
    expect(listed[0].id).toBe('tune')
    expect(defaultParams('tune').amount).toBeGreaterThan(0.5)
    expect(defaultParams('tune').root).toBe(-1)
    expect(defaultParams('tune').scaleIndex).toBe(-1)
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    store.addPlugin(vocal.id, 'tune')
    const plugin = store.track(vocal.id)!.plugins.at(-1)!
    expect(plugin.pluginId).toBe('tune')
    expect(plugin.params.amount).toBeGreaterThan(0.5)
    expect(plugin.params.root).toBe(-1)
    expect(plugin.params.scaleIndex).toBe(-1)
    expect(activeTunePreset(plugin.params, FACTORY.tune)).toBe('Hard tune/T-Pain')
    store.applyPluginPreset(vocal.id, plugin.id, 'Natural')
    const natural = store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!
    expect(activeTunePreset(natural.params, FACTORY.tune)).toBe('Natural')
    expect(natural.params.root).toBe(-1)
    expect(natural.params.amount).toBeGreaterThan(0.5)
    store.setScale({ root: 9, scale: 'aeolian' })
    expect(tuneScaleOf(store.scaleState())).toMatchObject({ root: 9, note: 'A', scaleName: 'Minor' })
    expect(tuneBlockScale(store.project.scale).scaleRoot).toBe(9)
  })

  it('snaps to the project key, and to a quarter tone when the scale has one', () => {
    const follow = { mode: 1, root: -1, scaleIndex: -1, mask: 0 }
    const cMajor = { scaleRoot: 0, scaleIntervals: major, scaleCents: majorCents }
    const aMajor = { scaleRoot: 9, scaleIntervals: major, scaleCents: majorCents }
    const near = midiOf(360)
    expect(tuneSnapMidi(near, follow, cMajor)).toBe(65)
    expect(tuneSnapMidi(near, follow, aMajor)).toBe(66)
    expect(tuneSnapMidi(near, { ...follow, root: 0, scaleIndex: 0 }, cMajor)).toBe(65)
    const quarter = tuneSnapMidi(61.4, follow, { scaleRoot: 0, scaleIntervals: [0, 2, 3, 5, 7, 9, 11], scaleCents: bayati })
    expect(Math.abs(quarter - 61.5)).toBeLessThan(0.02)
    expect(Math.abs(quarter - 62)).toBeGreaterThan(0.4)
  })

  it('corrects on the live path and again on playback', () => {
    const input = sine(360, 0.55)
    const params = hard()
    const liveSkip = Math.max(tuneLiveLatency(rate), 1536) + 6000
    const liveC = run(createTune(rate), input, params, { scaleRoot: 0, scaleIntervals: major, scaleCents: majorCents, offline: false })
    const liveA = run(createTune(rate), input, params, { scaleRoot: 9, scaleIntervals: major, scaleCents: majorCents, offline: false })
    expect(cents(pitchAt(liveC, liveSkip), hzOf(65))).toBeLessThan(25)
    expect(cents(pitchAt(liveA, liveSkip), hzOf(66))).toBeLessThan(25)
    const plugin = createPlugin('tune', 'Hard tune/T-Pain')
    Object.assign(plugin.params, params)
    const played = renderGraph({
      tracks: [{
        id: 'v',
        type: 'audio',
        input: 'none',
        buffer: [input, input],
        volume: 1,
        pan: 0,
        mute: false,
        solo: false,
        plugins: [plugin],
        sends: [],
        output: null,
        groupId: null,
      }],
      masterPlugins: [],
      masterVolume: 1,
      sampleRate: rate,
      tempo: 120,
      length: input.length,
      ...tuneBlockScale({ root: 9, scale: 'ionian' }),
      automation: [],
      offline: true,
      create: (id) => (id === 'tune' ? createTune(rate) : createTune(rate)),
    })
    expect(cents(pitchAt(played.master[0], tuneLatency(rate) + 6000), hzOf(66))).toBeLessThan(25)
  })

  it('lands a bayati degree between the piano keys and draws it on the trace', async () => {
    await loadScaleCatalog()
    const frame = tuneScaleOf({ root: 0, scale: 'ionian', library: 'maqam-bayati' })
    expect(frame.scaleName).toBe('Bayati')
    expect(frame.cents).toContain(150)
    const input = sine(hzOf(61.4), 0.55)
    const params = hard()
    const processor = createTune(rate)
    const heard = run(processor, input, params, { scaleRoot: frame.root, scaleIntervals: frame.intervals, scaleCents: frame.cents, offline: true })
    const target = hzOf(61.5)
    expect(cents(pitchAt(heard, tuneLatency(rate) + 6000), target)).toBeLessThan(25)
    expect(cents(pitchAt(heard, tuneLatency(rate) + 6000), hzOf(62))).toBeGreaterThan(30)
    const pairs = processor.trace ?? new Float32Array()
    let voiced = 0
    for (let i = 0; i + 1 < pairs.length; i += 2) if (pairs[i] > 0 && pairs[i + 1] > 0) voiced += 1
    expect(voiced).toBeGreaterThan(4)
  })

  it('shows the project key, the loaded preset, and a phone preset row', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setScale({ root: 9, scale: 'aeolian' })
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const before = renderToStaticMarkup(createElement(AutoTuneTrackButton, { store, trackId: vocal.id }))
    expect(before).toContain('Auto-Tune')
    expect(before).toContain('aria-pressed="false"')
    store.addPlugin(vocal.id, 'tune')
    const after = renderToStaticMarkup(createElement(AutoTuneTrackButton, { store, trackId: vocal.id }))
    expect(after).toContain('class="autotune-add inserted on"')
    expect(after).toContain('aria-pressed="true"')
    const plugin = store.track(vocal.id)!.plugins.at(-1)!
    const song = tuneScaleOf(store.scaleState())
    const html = renderToStaticMarkup(createElement(AutoTuneFace, {
      values: plugin.params,
      trace: null,
      revision: 0,
      enabled: true,
      projectKey: song.note,
      projectScale: song.scaleName,
      active: 'Hard tune/T-Pain',
      onChange: () => undefined,
      onScale: () => undefined,
      onPreset: () => undefined,
      onBypass: () => undefined,
    }))
    expect(html).toContain('Project · A')
    expect(html).toContain('Project · Minor')
    expect(html).toContain('data-preset="Hard tune/T-Pain"')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('Waiting for a note')
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1)
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../ui/autoTune.css'), 'utf8')
    expect(css).toContain('.shell.phone .head .autotune-add')
    expect(css).toContain('.shell.phone .autotune-presets')
    expect(css).toContain('.autotune-presets button.on')
  })
})

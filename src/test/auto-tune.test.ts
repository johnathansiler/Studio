import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  TUNE_APPENDED_IDS,
  TUNE_ORIGINAL_IDS,
  activeNoteMask,
  activeTunePreset,
  blobMidi,
  correctionRate,
  detectKey,
  dragNudge,
  dragRegionCents,
  graphNotes,
  harmonyName,
  keyFromHist,
  matchRegion,
  nextScaleMask,
  nudgeKey,
  orderedInserts,
  readMeter,
  regionPatch,
  stepHarmony,
  trackingGate,
  tuneBlockScale,
  tuneLiveLatency,
  tuneScaleOf,
  tuneSnapMidi,
  vocalNotes,
} from '../audio/plugins/autoTune'
import { CATALOG, FACTORY, createPlugin, defaultParams, descriptor, latencyOf, tuneLatency } from '../audio/plugins/catalog'
import { createTune } from '../audio/plugins/tune'
import { yinPitch } from '../audio/plugins/psola'
import { renderGraph } from '../audio/renderGraph'
import { MASTERING_IDS } from '../audio/master/assistant'
import type { Processor } from '../audio/plugins/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { loadScaleCatalog } from '../theory'
import { AutoTuneFace, AutoTuneTrackButton } from '../ui/AutoTuneFace'
import { InsertList, insertLabel } from '../ui/PluginSheet'

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
    expect(plugin.enabled).toBe(true)
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

  it('drives scale notes, nudges, reference pitch, bypass, and hold', () => {
    const follow = { mode: 1, root: 0, scaleIndex: 0, mask: 0, custom: 0 }
    const cMajor = { scaleRoot: 0, scaleIntervals: major, scaleCents: majorCents }
    const derived = activeNoteMask(follow, 0, major)
    const withoutF = nextScaleMask(0, false, derived, 5)
    expect(tuneSnapMidi(midiOf(360), { ...follow, custom: 1, mask: withoutF }, cMajor)).toBe(67)
    expect(tuneSnapMidi(midiOf(360), follow, cMajor)).toBe(65)
    const input = sine(360, 0.5)
    const params = hard()
    const nudged = run(createTune(rate), input, { ...params, n5: 100 }, { offline: true })
    expect(cents(pitchAt(nudged, tuneLatency(rate) + 5000), hzOf(66))).toBeLessThan(30)
    const bypassed = run(createTune(rate), sine(445, 0.5), { ...params, mode: 0, bypassMask: 1 << 9 }, { offline: true })
    expect(cents(pitchAt(bypassed, tuneLatency(rate) + 5000), 445)).toBeLessThan(25)
    const reference = run(createTune(rate), sine(450, 0.45), { ...params, mode: 0, a4: 450 }, { offline: true })
    expect(cents(pitchAt(reference, tuneLatency(rate) + 4000), 450)).toBeLessThan(25)
    const held = run(createTune(rate), sine(392, 0.45), { ...params, mode: 0, holdMidi: 69 }, { offline: true })
    expect(cents(pitchAt(held, tuneLatency(rate) + 4000), 440)).toBeLessThan(30)
    const live = createTune(rate)
    run(live, sine(440, 0.2), { ...params, hq: 1 }, { offline: false })
    expect(live.latencySamples).toBe(tuneLatency(rate))
    const monitor = createTune(rate)
    run(monitor, sine(440, 0.2), params, { offline: false })
    expect(monitor.latencySamples).toBe(tuneLiveLatency(rate))
    const dragged = dragNudge(65, 66, 0)
    expect(dragged).toEqual({ id: 'n5', cents: 100 })
    const sharp = 440 * 2 ** (0.5 / 12)
    const nudgedNote = { start: 0, end: 4, midi: 70, detected: 440, corrected: sharp }
    expect(blobMidi(nudgedNote, 440)).toBeCloseTo(69.5, 2)
    expect(nudgeKey(69.5, { n9: 50 })).toBe('n9')
    expect(dragNudge(69.5, 70.5, 50, 9)).toEqual({ id: 'n9', cents: 150 })
    expect(latencyOf('tune', { ...params, hq: 1 }, rate, true, true)).toBe(tuneLatency(rate))
    expect(latencyOf('tune', params, rate, true, true)).toBe(tuneLiveLatency(rate))
    const low = sine(82, 0.55)
    const lowOut = run(createTune(rate), low, { ...params, minHz: 70 }, { offline: false })
    const lowSkip = tuneLiveLatency(rate) + 1500
    let energy = 0
    for (let i = lowSkip; i < lowSkip + 4000; i++) energy += lowOut[i] * lowOut[i]
    expect(Math.sqrt(energy / 4000)).toBeGreaterThan(0.2)
    expect(cents(pitchAt(lowOut, lowSkip), 82)).toBeLessThan(30)
    const trace = new Float32Array(16)
    for (let i = 4; i < 8; i++) {
      trace[i * 2] = 440
      trace[i * 2 + 1] = 440
    }
    const blobs = graphNotes(trace)
    expect(blobs.length).toBe(1)
    expect(blobs[0].midi).toBe(69)
    expect(readMeter(trace)?.name).toBe('A')
    expect(readMeter(trace)?.cents).toBe(0)
  })

  it('shows the meter, knobs, keyboard, and graph without a popup menu', () => {
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
      projectRoot: song.root,
      projectIntervals: song.intervals,
      active: 'Hard tune/T-Pain',
      onChange: () => undefined,
      onPreset: () => undefined,
      onBypass: () => undefined,
    }))
    expect(html).toContain('Project · A')
    expect(html).toContain('Project · Minor')
    expect(html).toContain('data-preset="Hard tune/T-Pain"')
    expect(html).toContain('Waiting for a note')
    expect(html).toContain('Retune')
    expect(html).toContain('data-note="F#"')
    expect(html).toContain('data-key="60"')
    expect(html).toContain('Graph')
    expect(html).toContain('Auto Key')
    expect(html).toContain('Follow key')
    expect(html).toContain('MIDI control')
    expect(html).toContain('Tracking')
    expect(html).toContain('Note transition')
    expect(html).toContain('Throat')
    expect(html).toContain('Harmony')
    expect(html).toContain('Vocal MIDI')
    expect(html).toContain('Voice 1')
    expect(html).not.toContain('<select')
    expect(html).toContain('aria-pressed="true"')
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../ui/autoTune.css'), 'utf8')
    expect(css).toContain('.tune-meter')
    expect(css).toContain('.tune-knob')
    expect(css).toContain('.tune-resize')
    expect(css).toContain('.shell.phone .tune-board .side')
    expect(css).toContain('.keybed')
    expect(css).toContain('.tune-board.graph .tune-graph')
    expect(css).toContain('.bypass-toggle.lit')
    expect(css).toContain('.tune-tools,\n.tune-actions { flex-wrap: wrap; }')
    expect(css).toContain('.shell.phone .tune-notes')
    expect(css).toContain('.tune-drawer')
    expect(css).toContain('.tune-regions')
    expect(css).toContain('min-height: 40px')
  })

  it('starts active and opens from one strip click', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    store.addPlugin(vocal.id, 'tune')
    const plugin = store.track(vocal.id)!.plugins.at(-1)!
    expect(plugin.enabled).toBe(true)
    expect(insertLabel('tune')).toBe('Auto-Tune')
    expect(insertLabel('eq')).toBe('EQ')
    const song = tuneScaleOf(store.scaleState())
    const html = renderToStaticMarkup(createElement(AutoTuneFace, {
      values: plugin.params,
      trace: null,
      revision: 0,
      enabled: plugin.enabled,
      projectKey: song.note,
      projectScale: song.scaleName,
      projectRoot: song.root,
      projectIntervals: song.intervals,
      onChange: () => undefined,
      onPreset: () => undefined,
      onBypass: () => undefined,
    }))
    expect(html).toContain('data-bypass="off"')
    expect(html).toContain('>Bypass<')
    expect(html).not.toContain('>Bypassed<')
    expect(html).not.toContain('bypass-toggle lit')
    const bypassed = renderToStaticMarkup(createElement(AutoTuneFace, {
      values: plugin.params,
      trace: null,
      revision: 0,
      enabled: false,
      projectKey: song.note,
      projectScale: song.scaleName,
      onChange: () => undefined,
      onPreset: () => undefined,
      onBypass: () => undefined,
    }))
    expect(bypassed).toContain('data-bypass="on"')
    expect(bypassed).toContain('bypass-toggle lit')
    expect(bypassed).toContain('>Bypassed<')
    const button = findButton(InsertList({ store, trackId: vocal.id }), 'Auto-Tune')
    expect(button.props.children).toBe('Auto-Tune')
    expect(button.props['aria-label']).toContain('Auto-Tune')
    expect(button.props.onPointerDown).toBeUndefined()
    button.props.onClick()
    expect(store.pluginFocus).toEqual({ trackId: vocal.id, pluginId: plugin.id })
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(true)
    button.props.onDoubleClick()
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(false)
    store.undo()
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(true)
    store.redo()
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(false)
    store.undo()
    store.updatePlugin(vocal.id, plugin.id, { enabled: false })
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(false)
    store.undo()
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === plugin.id)!.enabled).toBe(true)
  })
})

describe('Auto-Tune upgrades', () => {
  it('appends parameters after n11 and keeps the Rust key order', () => {
    const spec = descriptor('tune')
    expect(spec).toBeTruthy()
    const ids = spec!.params.map((param) => param.id)
    expect(ids.slice(0, TUNE_ORIGINAL_IDS.length)).toEqual([...TUNE_ORIGINAL_IDS])
    expect(ids.slice(TUNE_ORIGINAL_IDS.length)).toEqual([...TUNE_APPENDED_IDS])
    const rust = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../core/dsp/src/plugin.rs'), 'utf8')
    const keys = rustList(rust, 'TUNE_KEYS').map((item) => item.replaceAll('"', ''))
    const defaults = rustList(rust, 'TUNE_DEFAULTS').map(Number)
    expect(keys).toEqual(ids)
    expect(defaults).toHaveLength(ids.length)
    spec!.params.forEach((param, index) => expect(defaults[index]).toBe(param.default))
    expect(defaultParams('tune').tracking).toBe(0.5)
    expect(defaultParams('tune').transition).toBe(1)
    expect(defaultParams('tune').harmony).toBe(0)
    expect(defaultParams('tune').amount).toBeGreaterThan(0.5)
    expect(FACTORY.tune.map((preset) => preset.name)).toEqual(expect.arrayContaining(['Hard tune/T-Pain', 'Classic', 'Harmony', 'MIDI target']))
  })

  it('finds a key, edits one note, and lists vocal MIDI', () => {
    expect(trackingGate(0.5)).toBe(0.7)
    expect(trackingGate(0)).toBeCloseTo(0.95)
    expect(correctionRate(1, false, 1, true)).toBe(1)
    expect(correctionRate(1, false, 0.25, true)).toBeCloseTo(0.25)
    expect(correctionRate(1, true, 1, false)).toBe(1)
    const hist = new Array(12).fill(0)
    hist[0] = 8
    hist[4] = 6
    hist[7] = 6
    expect(keyFromHist(hist)).toMatchObject({ root: 0, scaleIndex: 0, name: 'C Major' })
    const trace = new Float32Array(16)
    for (let i = 0; i < 4; i++) {
      trace[i * 2] = 261.63
      trace[i * 2 + 1] = 261.63
    }
    for (let i = 4; i < 8; i++) {
      trace[i * 2] = 329.63
      trace[i * 2 + 1] = 329.63
    }
    expect(detectKey(trace)?.name).toBe('C Major')
    expect(vocalNotes(trace).map((note) => note.name)).toEqual(['C4', 'E4'])
    const placed = regionPatch({}, 65, 0)
    expect(placed.slot).toBe(0)
    expect(placed.patch).toEqual({ r0lo: 65, r0hi: 65, r0ct: 0, r0amt: 1 })
    const moved = { ...placed.patch, r0ct: dragRegionCents(65, 66, 0) }
    expect(matchRegion(moved, 65)).toMatchObject({ ct: 100, amt: 1, slot: 0 })
    expect(matchRegion(moved, 64)).toBeNull()
    expect(harmonyName(7)).toBe('Fifth')
    expect(stepHarmony(7, 1)).toBe(12)
    expect(stepHarmony(0, -1)).toBe(12)
  })

  it('follows MIDI, a correction region, throat, vibrato, harmony, and auto key', () => {
    const params = hard()
    const open = run(createTune(rate), sine(445, 0.45), { ...params, mode: 0, midi: 1, holdMidi: -1 }, { offline: true })
    expect(cents(pitchAt(open, tuneLatency(rate) + 4000), 445)).toBeLessThan(25)
    const aimed = run(createTune(rate), sine(445, 0.45), { ...params, mode: 0, midi: 1, holdMidi: 69 }, { offline: true })
    expect(cents(pitchAt(aimed, tuneLatency(rate) + 4000), 440)).toBeLessThan(30)
    const played = createTune(rate)
    played.note(69, 0.8)
    const fromNote = run(played, sine(445, 0.45), { ...params, mode: 0, midi: 1, holdMidi: -1 }, { offline: true })
    expect(cents(pitchAt(fromNote, tuneLatency(rate) + 4000), 440)).toBeLessThan(30)
    played.note(69, 0)
    const region = run(createTune(rate), sine(360, 0.5), { ...params, r0lo: 65, r0hi: 65, r0ct: 100, r0amt: 1 }, { offline: true })
    expect(cents(pitchAt(region, tuneLatency(rate) + 5000), hzOf(66))).toBeLessThan(30)
    const plain = run(createTune(rate), sine(360, 0.4), params, { offline: true })
    const bright = run(createTune(rate), sine(360, 0.4), { ...params, throat: 1 }, { offline: true })
    let changed = 0
    for (let i = 0; i < plain.length; i++) changed = Math.max(changed, Math.abs(plain[i] - bright[i]))
    expect(changed).toBeGreaterThan(0.01)
    const still = run(createTune(rate), sine(440, 0.45), { ...params, mode: 0 }, { offline: true })
    const wobbled = run(createTune(rate), sine(440, 0.45), { ...params, mode: 0, vibeDepth: 80, vibeRate: 5.5 }, { offline: true })
    let wobble = 0
    for (let i = 0; i < still.length; i++) wobble = Math.max(wobble, Math.abs(still[i] - wobbled[i]))
    expect(wobble).toBeGreaterThan(0.01)
    const lead = run(createTune(rate), sine(440, 0.45), { ...params, mode: 0 }, { offline: true })
    const stacked = run(createTune(rate), sine(440, 0.45), { ...params, mode: 0, harmony: 0.8, h1: 12, h2: 7, h3: 0, h4: 0 }, { offline: true })
    let stack = 0
    let peak = 0
    for (let i = 0; i < lead.length; i++) {
      stack = Math.max(stack, Math.abs(lead[i] - stacked[i]))
      peak = Math.max(peak, Math.abs(stacked[i]))
    }
    expect(stack).toBeGreaterThan(0.02)
    expect(peak).toBeLessThan(1.5)
    expect(cents(pitchAt(stacked, tuneLatency(rate) + 4000), 440)).toBeLessThan(40)
    const between = 440 * 2 ** ((60.4 - 69) / 12)
    const melody = phrase([hzOf(60), hzOf(64), hzOf(67), between])
    const followed = run(createTune(rate), melody, { ...params, autoKey: 1 }, { scaleRoot: 9, scaleIntervals: major, scaleCents: majorCents, offline: true })
    const skip = tuneLatency(rate) + Math.floor(rate * 0.78)
    expect(cents(pitchAt(followed, skip), hzOf(60))).toBeLessThan(35)
    expect(cents(pitchAt(followed, skip), hzOf(61))).toBeGreaterThan(40)
    const processor = createTune(rate)
    run(processor, sine(440, 0.35), { ...params, mode: 0, vocal: 1 }, { offline: true })
    expect(processor.vocalMidi.some((note) => note.name === 'A4')).toBe(true)
  })
})

function phrase(steps: number[]) {
  const data = new Float32Array(Math.floor(rate * 0.22) * steps.length)
  steps.forEach((hz, index) => {
    const start = Math.floor(rate * 0.22) * index
    const end = start + Math.floor(rate * 0.22)
    for (let i = start; i < end; i++) data[i] = Math.sin((2 * Math.PI * hz * (i - start)) / rate) * 0.35
  })
  return data
}

function rustList(source: string, name: string) {
  const match = source.match(new RegExp(`const ${name}:[\\s\\S]*?= &\\[([\\s\\S]*?)\\];`))
  if (!match) throw new Error(`missing ${name}`)
  return match[1].split(',').map((item) => item.trim()).filter(Boolean)
}

function findButton(node: unknown, label: string): { props: { children: string; onClick: () => void; onDoubleClick: () => void; onPointerDown?: (event: { button: number; stopPropagation: () => void }) => void; 'aria-label': string } } {
  if (Array.isArray(node)) {
    for (const child of node) {
      try {
        return findButton(child, label)
      } catch {
        /* keep looking */
      }
    }
    throw new Error(`missing ${label} button`)
  }
  if (!node || typeof node !== 'object') throw new Error(`missing ${label} button`)
  const element = node as { props?: { children?: unknown; onClick?: () => void } }
  const children = element.props?.children
  if (children === label && element.props?.onClick) return element as never
  const list = Array.isArray(children) ? children : children ? [children] : []
  for (const child of list) {
    try {
      return findButton(child, label)
    } catch {
      /* keep looking */
    }
  }
  throw new Error(`missing ${label} button`)
}

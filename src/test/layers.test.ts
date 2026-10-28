import { describe, expect, it } from 'vitest'
import { normalizeProject } from '../audio/plugins/catalog'
import { renderLayerNotes, type LayerBuffer } from '../layers/engine'
import { applyRoutes, morphValues, rangeMap, writeSounding } from '../layers/matrix'
import { makeLayer, normalizeLayerPatch, starterPatch } from '../layers/presets'
import { registerLayerSource } from '../layers/source'
import { MOD_SOURCES, type LayerPatch, type ModRoute } from '../layers/types'
import { freeWaveform } from '../layers/wave'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

const rate = 48000
const cutoffRange = { cutoff: { min: 0, max: 2000 } }

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / channel.length)
}

function assertClean(channel: Float32Array) {
  for (const sample of channel) {
    expect(Number.isFinite(sample)).toBe(true)
    expect(Math.abs(sample)).toBeLessThanOrEqual(1.01)
  }
}

function measureHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.05))
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 12)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return sampleRate / mean
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function route(source: string, destination: string, amount: number): ModRoute {
  return { id: source + destination, source, destination, amount }
}

registerLayerSource({
  kind: 'probe',
  params: [],
  create: () => ({
    start() {},
    release() {},
    render: () => 0.25,
  }),
})

function probePatch(level: number): LayerPatch {
  return normalizeLayerPatch({
    id: 'probe',
    name: 'Probe',
    layers: [{
      id: 'ly',
      name: 'Probe',
      enabled: true,
      source: { kind: 'probe', params: {} },
      params: {
        level,
        attack: 0,
        decay: 5,
        sustain: 1,
        release: 30,
        cutoff: 16000,
        res: 0,
        drive: 0,
        chorus: 0,
        delay: 0,
        pan: 0,
        tune: 0,
        fine: 0,
        fAmt: 0,
        filterMode: 0,
      },
    }],
    routes: [],
    corners: [],
    xy: { x: 0, y: 0 },
    modWheel: 0,
    aftertouch: 0,
    globals: { master: 1 },
    polyphony: 2,
  })
}

function play(patch: LayerPatch, frames = 2400, pitch = 60, buffers?: Map<string, LayerBuffer>) {
  return renderLayerNotes(patch, [
    { sample: 0, pitch, vel: 1 },
    { sample: frames - 200, pitch, vel: 0 },
  ], rate, frames, buffers)
}

describe('modulation matrix', () => {
  it('routes every source onto a destination and sums them', () => {
    for (const source of MOD_SOURCES) {
      const base = { cutoff: 1000 }
      const out = applyRoutes(base, [route(source.id, 'cutoff', 0.5)], { [source.id]: 1 }, cutoffRange)
      expect(out.cutoff).toBeCloseTo(2000)
      expect(base.cutoff).toBe(1000)
    }
    const summed = applyRoutes(
      { cutoff: 1000 },
      [route('lfo1', 'cutoff', 0.1), route('velocity', 'cutoff', 0.1)],
      { lfo1: 1, velocity: 1 },
      cutoffRange,
    )
    expect(summed.cutoff).toBeCloseTo(1400)
  })

  it('inverts a bipolar LFO and clamps at the range', () => {
    const down = applyRoutes({ cutoff: 1000 }, [route('lfo1', 'cutoff', 0.5)], { lfo1: -1 }, cutoffRange)
    expect(down.cutoff).toBeCloseTo(0)
    const clipped = applyRoutes({ cutoff: 1000 }, [route('modwheel', 'cutoff', 1)], { modwheel: 1 }, cutoffRange)
    expect(clipped.cutoff).toBe(2000)
    const ignored = applyRoutes({ cutoff: 1000 }, [route('aftertouch', 'missing', 1)], { aftertouch: 1 }, cutoffRange)
    expect(ignored.cutoff).toBe(1000)
    const silent = applyRoutes({ cutoff: 1000 }, [route('env1', 'cutoff', 1)], {}, cutoffRange)
    expect(silent.cutoff).toBe(1000)
  })

  it('applies a route after the morph', () => {
    const morphed = morphValues([{ level: 0 }, { level: 1 }, { level: 0 }, { level: 0 }], 1, 0, { level: 0 })
    const routed = applyRoutes(morphed, [route('velocity', 'level', -0.5)], { velocity: 1 }, { level: { min: 0, max: 1 } })
    expect(morphed.level).toBeCloseTo(1)
    expect(routed.level).toBeCloseTo(0.5)
  })
})

describe('xy morph', () => {
  it('blends the four corners and falls back when a corner omits a key', () => {
    const corners: Record<string, number>[] = [{ cutoff: 0, pan: 1 }, { cutoff: 100 }, { cutoff: 0 }, { cutoff: 100 }]
    const fallback = { cutoff: 5, pan: 0.2 }
    expect(morphValues(corners, 0, 0, fallback).cutoff).toBeCloseTo(0)
    expect(morphValues(corners, 1, 0, fallback).cutoff).toBeCloseTo(100)
    expect(morphValues(corners, 0, 1, fallback).cutoff).toBeCloseTo(0)
    expect(morphValues(corners, 1, 1, fallback).cutoff).toBeCloseTo(100)
    expect(morphValues(corners, 0.5, 0, fallback).cutoff).toBeCloseTo(50)
    expect(morphValues(corners, 0.5, 0.5, fallback).cutoff).toBeCloseTo(50)
    expect(morphValues(corners, 0, 0, fallback).pan).toBeCloseTo(1)
    expect(morphValues(corners, 1, 0, fallback).pan).toBeCloseTo(0.2)
    expect(morphValues(corners, 2, -1, fallback).cutoff).toBeCloseTo(100)
  })

  it('writes the sounding value into the nearest corner, and shifts every corner in the middle', () => {
    const corners = [{ cutoff: 0 }, { cutoff: 100 }, { cutoff: 0 }, { cutoff: 100 }]
    writeSounding(corners, 0, 0, { cutoff: 0 }, 'cutoff', 40)
    expect(corners[0].cutoff).toBeCloseTo(40)
    expect(corners[1].cutoff).toBeCloseTo(100)
    const mid = [{ a: 10 }, { a: 10 }, { a: 10 }, { a: 10 }]
    writeSounding(mid, 0.5, 0.5, { a: 10 }, 'a', 4)
    expect(mid.every((corner) => Math.abs(corner.a - 4) < 1e-6)).toBe(true)
  })

  it('crossfades a starter between two layer levels', () => {
    const patch = starterPatch('duo-morph')
    const id = patch.layers[0].id
    const key = `${id}:level`
    const a = patch.corners[0].values[key]
    const b = patch.corners[1].values[key]
    expect(a).not.toBeCloseTo(b)
    const bags = patch.corners.map((corner) => corner.values)
    expect(morphValues(bags, 0, 0, {}).level ?? morphValues(bags, 0, 0, {})[key]).toBeCloseTo(a)
    expect(morphValues(bags, 0.5, 0, {})[key]).toBeCloseTo((a + b) / 2)
    const ranges = rangeMap(patch)
    for (const item of patch.routes) {
      expect(MOD_SOURCES.some((source) => source.id === item.source)).toBe(true)
      expect(ranges[item.destination]).toBeTruthy()
    }
  })
})

describe('layered playback', () => {
  it('changes level from the mod wheel and from the morph pad', () => {
    const quietWheel = probePatch(0)
    quietWheel.routes = [route('modwheel', 'ly:level', 1)]
    quietWheel.modWheel = 0
    const openWheel = probePatch(0)
    openWheel.routes = [route('modwheel', 'ly:level', 1)]
    openWheel.modWheel = 1
    const quiet = play(quietWheel)
    const loud = play(openWheel)
    assertClean(quiet[0])
    assertClean(loud[0])
    expect(rms(quiet[0])).toBeLessThan(0.02)
    expect(rms(loud[0])).toBeGreaterThan(0.1)

    const morphed = probePatch(0)
    for (const corner of morphed.corners) corner.values['ly:level'] = 0
    morphed.corners[1].values['ly:level'] = 1
    morphed.xy = { x: 0, y: 0 }
    const atA = play(morphed)
    morphed.xy = { x: 1, y: 0 }
    const atB = play(morphed)
    expect(rms(atA[0])).toBeLessThan(0.02)
    expect(rms(atB[0])).toBeGreaterThan(0.1)
  })

  it('plays starter patches from synthesis and the built-in public-domain wave', () => {
    const wave = freeWaveform(rate)
    let peak = 0
    for (const sample of wave) {
      expect(Number.isFinite(sample)).toBe(true)
      peak = Math.max(peak, Math.abs(sample))
    }
    expect(peak).toBeGreaterThan(0.5)
    expect(peak).toBeLessThanOrEqual(0.91)
    for (const starter of ['glass-pad', 'fm-stack', 'grain-cloud', 'duo-morph']) {
      const patch = starterPatch(starter)
      const rendered = play(patch, 3600, 60)
      assertClean(rendered[0])
      assertClean(rendered[1])
      expect(rms(rendered[0])).toBeGreaterThan(0.01)
    }
  })

  it('tracks pitch for a sample layer and a sine synth layer', () => {
    const hz = 440 * 2 ** ((60 - 69) / 12)
    const data = new Float32Array(rate)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / rate)
    const sample = normalizeLayerPatch({
      id: 'samp',
      name: 'Sample',
      layers: [makeLayer('Sample', 'sample', undefined, {
        level: 0.8, attack: 1, decay: 20, sustain: 1, release: 40, cutoff: 15000, res: 0, chorus: 0, delay: 0, drive: 0,
      }, { root: 60, tune: 0, loop: 0, start: 0, end: 1, crossfade: 0 })],
      routes: [],
      corners: [],
      xy: { x: 0, y: 0 },
      modWheel: 0,
      aftertouch: 0,
      globals: { master: 0.9 },
      polyphony: 2,
    })
    const buffers = new Map<string, LayerBuffer>([['sine', { sampleRate: rate, channel: data }]])
    sample.layers[0].source.bufferId = 'sine'
    const low = play(sample, 8000, 60, buffers)
    const high = play(sample, 8000, 72, buffers)
    assertClean(low[0])
    expect(cents(measureHz(low[0], rate), hz)).toBeLessThan(15)
    expect(cents(measureHz(high[0], rate), hz * 2)).toBeLessThan(15)

    const sine = normalizeLayerPatch({
      id: 'sine',
      name: 'Sine',
      layers: [makeLayer('Sine', 'synth', 'analog', {
        level: 0.7, attack: 1, decay: 10, sustain: 1, release: 40, cutoff: 15000, res: 0, chorus: 0, delay: 0, drive: 0,
      }, { wave: 4, mix2: 0, detune: 0, uni: 1, pw: 0.5 })],
      routes: [],
      corners: [],
      xy: { x: 0, y: 0 },
      modWheel: 0,
      aftertouch: 0,
      globals: { master: 0.8 },
      polyphony: 2,
    })
    const tone = play(sine, 12000, 69)
    assertClean(tone[0])
    expect(cents(measureHz(tone[0], rate), 440)).toBeLessThan(12)
    expect(rms(tone[0])).toBeGreaterThan(0.05)
  })

  it('gives a layers track a starter patch and heals a saved track that lost one', () => {
    const store = new ProjectStore(createEmptyProject())
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'layers', input: 'mic', channels: 1, armed: false })
    const track = store.project.tracks.find((item) => item.id === ids[0])!
    expect(track.instrument).toBe('layers')
    expect(track.name).toBe('Layers 1')
    expect(track.layerPatch?.layers.length).toBeGreaterThan(1)
    store.openLayers(track.id)
    expect(store.layerTrackId).toBe(track.id)
    store.setLayerModWheel(track.id, 0.4)
    expect(track.layerPatch?.modWheel).toBeCloseTo(0.4)

    const project = createEmptyProject()
    project.tracks[0].type = 'midi'
    project.tracks[0].instrument = 'layers'
    project.tracks[0].layerPatch = undefined
    const healed = normalizeProject(project).tracks[0]
    expect(healed.layerPatch?.name).toBe('Glass Pad')
    expect(healed.layerPatch?.corners).toHaveLength(4)
  })
})

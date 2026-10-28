import { describe, expect, it } from 'vitest'
import { createLayerSource } from '../instruments/patch/adapters'
import { PatchEngine } from '../instruments/patch/engine'
import {
  CONTROL_HELP,
  MAX_LAYERS,
  addLayer,
  addRoute,
  bilinear,
  captureCorner,
  controlHelp,
  editLayer,
  editRoute,
  emptyOmni,
  inRange,
  morphedPatch,
  setLayerKind,
} from '../instruments/patch'
import { connectedDestination } from '../instruments/patch/source'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

function rms(channel: Float32Array, from = 0, to = channel.length) {
  let sum = 0
  let count = 0
  const end = Math.min(channel.length, to)
  for (let i = from; i < end; i++) {
    sum += channel[i] * channel[i]
    count += 1
  }
  return Math.sqrt(sum / Math.max(1, count))
}

function clean(channel: Float32Array) {
  for (const sample of channel) {
    expect(Number.isFinite(sample)).toBe(true)
    expect(Math.abs(sample)).toBeLessThanOrEqual(1.01)
  }
}

function measureHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.08))
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
  const window = periods.slice(2, 14)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return sampleRate / mean
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function sine(freq: number, seconds: number, sampleRate = 48000) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return data
}

function brightness(channel: Float32Array) {
  const start = Math.round(channel.length * 0.2)
  let sum = 0
  for (let i = start + 1; i < channel.length; i++) sum += Math.abs(channel[i] - channel[i - 1])
  return sum / Math.max(1, channel.length - start)
}

function play(patch = emptyOmni(), note = 69, velocity = 0.9, frames = 12000, buffers?: Map<string, Float32Array>) {
  const engine = new PatchEngine(48000)
  engine.setPatch(patch)
  buffers?.forEach((channel, id) => engine.setBuffer(id, channel))
  engine.noteOn(note, velocity)
  const audio = engine.render(frames)
  clean(audio.left)
  clean(audio.right)
  return audio
}

describe('layered patch', () => {
  it('describes every control in a sentence', () => {
    const ids = ['level', 'pan', 'cutoff', 'resonance', 'fxSend', 'keyLo', 'keyHi', 'velLo', 'velHi', 'position', 'size', 'density', 'spray', 'pitch', 'freeze', 'depth', 'lfo1', 'lfo2', 'modwheel', 'aftertouch', 'morph', 'filterMode', 'root', 'kind', 'buffer', 'source', 'target', 'corner', 'tabLayers', 'tabGrain', 'tabMod', 'tabXY']
    for (const id of ids) expect(controlHelp(id).length).toBeGreaterThan(12)
    for (const text of Object.values(CONTROL_HELP)) expect(text.length).toBeGreaterThan(12)
  })

  it('blends four snapshots and lands on each corner', () => {
    expect(bilinear(0, 10, 20, 30, 0, 0)).toBeCloseTo(0)
    expect(bilinear(0, 10, 20, 30, 1, 0)).toBeCloseTo(10)
    expect(bilinear(0, 10, 20, 30, 0, 1)).toBeCloseTo(20)
    expect(bilinear(0, 10, 20, 30, 1, 1)).toBeCloseTo(30)
    expect(bilinear(0, 10, 20, 30, 0.5, 0.5)).toBeCloseTo(15)
    const patch = emptyOmni()
    const levels = [0.1, 0.4, 0.7, 1]
    patch.morph.corners.forEach((corner, index) => {
      corner.values.layers[0].level = levels[index]
      corner.captured = true
    })
    patch.morph.x = 1
    patch.morph.y = 1
    expect(morphedPatch(patch).layers[0].level).toBeCloseTo(1)
    patch.morph.x = 0
    patch.morph.y = 0
    expect(morphedPatch(patch).layers[0].level).toBeCloseTo(0.1)
    captureCorner(patch, 2)
    expect(patch.morph.corners[2].captured).toBe(true)
  })

  it('keeps analog, wavetable, and FM on pitch through the layer interface', () => {
    const target = 440
    for (const kind of ['analog', 'wavetable', 'fm'] as const) {
      const patch = emptyOmni()
      const layer = patch.layers[0]
      setLayerKind(patch, layer.id, kind)
      editLayer(patch, layer.id, {
        cutoff: 14000,
        resonance: 0,
        params: kind === 'analog'
          ? { wave1: 4, mix2: 0, detune: 0, uni: 1 }
          : kind === 'fm'
            ? { index: 0, ratio: 1, feedback: 0, algo: 0 }
            : { table: 0, position: 0, uni: 1 },
      })
      const audio = play(patch, 69, 0.9, 16000)
      expect(rms(audio.left, 2000)).toBeGreaterThan(0.02)
      expect(cents(measureHz(audio.left, 48000), target)).toBeLessThan(12)
    }
  })

  it('gates layers by key and velocity and pans hard left', () => {
    const low = emptyOmni()
    editLayer(low, low.layers[0].id, { keyLo: 0, keyHi: 64, params: { wave1: 4, mix2: 0 } })
    expect(inRange(low.layers[0], 72, 0.8)).toBe(false)
    const missed = play(low, 72, 0.9, 4000)
    expect(rms(missed.left)).toBeLessThan(0.001)
    const hit = play(low, 60, 0.9, 8000)
    expect(rms(hit.left, 1000)).toBeGreaterThan(0.02)

    const soft = emptyOmni()
    editLayer(soft, soft.layers[0].id, { velLo: 0.75, velHi: 1, params: { wave1: 4, mix2: 0 } })
    expect(rms(play(soft, 60, 0.2, 4000).left)).toBeLessThan(0.001)
    expect(rms(play(soft, 60, 0.95, 8000).left, 1000)).toBeGreaterThan(0.02)

    const side = emptyOmni()
    editLayer(side, side.layers[0].id, { pan: -1, params: { wave1: 4, mix2: 0 } })
    const panned = play(side, 69, 0.9, 8000)
    expect(rms(panned.left, 1000)).toBeGreaterThan(0.02)
    expect(rms(panned.right)).toBeLessThan(0.001)
  })

  it('mixes four layers, darkens with the filter, and keeps a send tail', () => {
    const one = emptyOmni()
    editLayer(one, one.layers[0].id, { level: 0.35, params: { wave1: 4, mix2: 0 } })
    const four = emptyOmni()
    editLayer(four, four.layers[0].id, { level: 0.35, params: { wave1: 4, mix2: 0 } })
    addLayer(four, 'analog')
    addLayer(four, 'wavetable')
    addLayer(four, 'fm')
    expect(four.layers).toHaveLength(MAX_LAYERS)
    expect(addLayer(four, 'analog')).toBeNull()
    for (const layer of four.layers) editLayer(four, layer.id, { level: 0.35, cutoff: 14000, resonance: 0 })
    const single = play(one, 60, 0.9, 8000)
    const stack = play(four, 60, 0.9, 8000)
    expect(rms(stack.left, 1000)).toBeGreaterThan(rms(single.left, 1000) * 1.4)

    const dark = emptyOmni()
    const bright = emptyOmni()
    editLayer(dark, dark.layers[0].id, { cutoff: 180, resonance: 0 })
    editLayer(bright, bright.layers[0].id, { cutoff: 14000, resonance: 0 })
    expect(brightness(play(bright, 48, 0.9, 8000).left)).toBeGreaterThan(brightness(play(dark, 48, 0.9, 8000).left) * 1.5)

    const dry = emptyOmni()
    const wet = emptyOmni()
    editLayer(dry, dry.layers[0].id, { fxSend: 0, params: { release: 20, attack: 4, sustain: 1 } })
    editLayer(wet, wet.layers[0].id, { fxSend: 1, params: { release: 20, attack: 4, sustain: 1 } })
    const tail = (patch: ReturnType<typeof emptyOmni>) => {
      const engine = new PatchEngine(48000)
      engine.setPatch(patch)
      engine.noteOn(60, 0.9)
      engine.render(6000)
      engine.noteOff(60)
      return rms(engine.render(18000).left, 8000)
    }
    expect(tail(wet)).toBeGreaterThan(tail(dry) * 1.8)
  })

  it('routes velocity onto level', () => {
    const patch = emptyOmni()
    editLayer(patch, patch.layers[0].id, { level: 0.15, params: { wave1: 4, mix2: 0, attack: 4, sustain: 1 } })
    const route = addRoute(patch)
    expect(route).toBeTruthy()
    editRoute(patch, route!.id, { source: 'velocity', target: 'layer:0:level', depth: 1 })
    const quiet = rms(play(patch, 69, 0.15, 8000).left, 1500)
    const loud = rms(play(patch, 69, 1, 8000).left, 1500)
    expect(loud).toBeGreaterThan(quiet * 1.6)
  })

  it('plays a sampler and a frozen grain cloud from loaded audio', () => {
    const rate = 48000
    const tone = sine(440, 1, rate)
    const buffers = new Map([['tone', tone]])
    const sampled = emptyOmni()
    setLayerKind(sampled, sampled.layers[0].id, 'sampler')
    editLayer(sampled, sampled.layers[0].id, { bufferId: 'tone', root: 60, cutoff: 14000, resonance: 0 })
    const sample = play(sampled, 60, 0.9, 16000, buffers)
    expect(rms(sample.left, 2000)).toBeGreaterThan(0.02)
    expect(cents(measureHz(sample.left, rate), 440)).toBeLessThan(20)

    const cloud = emptyOmni()
    setLayerKind(cloud, cloud.layers[0].id, 'granular')
    editLayer(cloud, cloud.layers[0].id, {
      bufferId: 'tone',
      root: 60,
      cutoff: 14000,
      resonance: 0,
      granular: { position: 0.2, size: 120, density: 28, spray: 0, pitch: 0, freeze: true },
    })
    const grains = play(cloud, 60, 0.9, 16000, buffers)
    expect(rms(grains.left, 2000)).toBeGreaterThan(0.02)
    expect(cents(measureHz(grains.left, rate), 440)).toBeLessThan(30)
    editLayer(cloud, cloud.layers[0].id, { granular: { position: 0.2, size: 120, density: 28, spray: 0, pitch: 12, freeze: true } })
    const up = play(cloud, 60, 0.9, 16000, buffers)
    expect(cents(measureHz(up.left, rate), 880)).toBeLessThan(35)

    const sweep = new Float32Array(rate)
    for (let i = Math.round(rate * 0.75); i < sweep.length; i++) sweep[i] = 0.8 * Math.sin((2 * Math.PI * 330 * i) / rate)
    const where = emptyOmni()
    setLayerKind(where, where.layers[0].id, 'granular')
    const grain = { position: 0.05, size: 40, density: 24, spray: 0, pitch: 0, freeze: true }
    editLayer(where, where.layers[0].id, { bufferId: 'tone', root: 60, cutoff: 14000, resonance: 0, granular: grain })
    const early = play(where, 60, 1, 8000, new Map([['tone', sweep]]))
    editLayer(where, where.layers[0].id, { granular: { ...grain, position: 0.9 } })
    const late = play(where, 60, 1, 8000, new Map([['tone', sweep]]))
    expect(rms(early.left)).toBeLessThan(0.01)
    expect(rms(late.left, 1000)).toBeGreaterThan(0.04)
  })

  it('connects, notes, and releases a layer source', () => {
    for (const kind of ['analog', 'wavetable', 'fm', 'sampler', 'granular'] as const) {
      const source = createLayerSource(kind, 48000)
      expect(typeof source.noteOn).toBe('function')
      expect(typeof source.noteOff).toBe('function')
      expect(typeof source.connect).toBe('function')
      const dest = { context: {} } as AudioNode
      source.connect(dest)
      expect(connectedDestination(source)).toBe(dest)
      if (kind === 'sampler' || kind === 'granular') source.setBuffer?.(sine(220, 0.4))
      source.noteOn(60, 0.8)
      const body = source.render(4000)
      source.noteOff(60)
      const tail = source.render(12000)
      expect(rms(body, 500)).toBeGreaterThan(0.005)
      expect(rms(tail, 8000)).toBeLessThan(rms(body, 500))
      source.disconnect()
      expect(connectedDestination(source)).toBeNull()
      source.dispose()
    }
  })

  it('saves and reloads the patch with the project', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')
    expect(track).toBeTruthy()
    store.openPatch(track!.id)
    store.updateOmni(track!.id, (patch) => {
      patch.name = 'Harbor pad'
      editLayer(patch, patch.layers[0].id, { cutoff: 900, bufferId: 'local-audio' })
    })
    store.saveOmniPatch(track!.id)
    store.loadOmniPatch(track!.id, store.project.omniLibrary![0].id)
    const raw = JSON.parse(JSON.stringify(store.project))
    const migrated = migrateProject(raw)
    const restored = new ProjectStore(migrated)
    const again = restored.project.tracks.find((item) => item.id === track!.id)
    expect(restored.project.omniLibrary?.map((item) => item.name)).toContain('Harbor pad')
    expect(again?.omniPatch?.name).toBe('Harbor pad')
    expect(again?.omniPatch?.layers[0].cutoff).toBeCloseTo(900)
    expect(again?.omniPatch?.layers[0].bufferId).toBe('local-audio')
    expect(again?.omniPatch?.layers.length).toBeGreaterThan(0)
    expect(again?.omniPatch?.morph.corners).toHaveLength(4)
  })
})

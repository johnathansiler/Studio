import { describe, expect, it } from 'vitest'
import { RackRuntime } from '../audio/rack/dsp'
import { makeDevice, FACTORY_PRESETS, type DeviceKind } from '../model/rack'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / channel.length)
}

function assertClean(channel: Float32Array) {
  for (const sample of channel) {
    expect(Number.isFinite(sample)).toBe(true)
    expect(Math.abs(sample)).toBeLessThanOrEqual(1.5)
    expect(sample === 0 || Math.abs(sample) >= 1e-15).toBe(true)
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

function tone(kind: DeviceKind, params: Record<string, number>, note = 69, bend = 0) {
  const device = makeDevice(kind)
  Object.assign(device.params, params)
  const runtime = new RackRuntime(48000)
  runtime.note(note, 0.9, 8)
  if (bend) runtime.express(note, bend, 0.4)
  const rendered = runtime.render({ devices: [device], cables: [], polyphony: 8 }, 12000, 120, 'full', new Map())
  assertClean(rendered[0])
  return rendered[0]
}

describe('synth engines', () => {
  it('keeps a sine analog, wavetable, and FM voice on pitch', () => {
    const rate = 48000
    const target = 440
    const analog = tone('sub', { wave1: 4, mix2: 0, mix3: 0, cutoff: 14000, res: 0, famt: 0, attack: 1, sustain: 1, detune: 0, uni: 1 })
    const wave = tone('wave', { table: 0, position: 0, warp: 0, uni: 1, cutoff: 14000, res: 0, attack: 1, sustain: 1 })
    const fm = tone('fm', { index: 0, ratio: 1, algo: 0, feedback: 0, attack: 1, sustain: 1, lv3: 0, lv4: 0 })
    expect(cents(measureHz(analog, rate), target)).toBeLessThan(8)
    expect(cents(measureHz(wave, rate), target)).toBeLessThan(8)
    expect(cents(measureHz(fm, rate), target)).toBeLessThan(8)
    expect(rms(analog)).toBeGreaterThan(0.02)
  })

  it('bends a held note by two semitones', () => {
    const bent = tone('sub', { wave1: 4, mix2: 0, mix3: 0, cutoff: 14000, res: 0, famt: 0, attack: 1, sustain: 1, uni: 1 }, 69, 2)
    expect(cents(measureHz(bent, 48000), 440 * 2 ** (2 / 12))).toBeLessThan(8)
  })

  it('caps sounding voices when the phone quality is eco', () => {
    const runtime = new RackRuntime(48000)
    for (let note = 60; note < 66; note++) runtime.note(note, 0.8, 8)
    expect(runtime.activeVoices()).toBe(6)
    runtime.render({ devices: [makeDevice('sub')], cables: [], polyphony: 8 }, 128, 120, 'eco', new Map())
    expect(runtime.activeVoices()).toBeLessThanOrEqual(4)
  })

  it('ships a categorized preset list and round-trips a saved favorite', () => {
    for (const kind of ['sub', 'fm', 'wave'] as const) {
      expect(FACTORY_PRESETS[kind].length).toBeGreaterThanOrEqual(15)
      expect(new Set(FACTORY_PRESETS[kind].map((item) => item.category).filter(Boolean)).size).toBeGreaterThan(3)
    }
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    const device = track.rack!.devices[0]
    store.setDeviceParam(track.id, device.id, 'cutoff', 333)
    store.saveDevicePreset(device.kind, 'Mine', { ...device.params })
    store.setDeviceParam(track.id, device.id, 'cutoff', 900)
    store.applyDevicePreset(track.id, device.id, 'Mine')
    expect(store.track(track.id)!.rack!.devices[0].params.cutoff).toBe(333)
    store.togglePresetFavorite(device.kind, 'Mine')
    const before = store.track(track.id)!.rack!.devices[0].params.cutoff
    store.mutateDevice(track.id, device.id, () => 0.1)
    expect(store.track(track.id)!.rack!.devices[0].params.cutoff).not.toBe(before)
    store.undo()
    expect(store.track(track.id)!.rack!.devices[0].params.cutoff).toBe(before)
    const saved = JSON.parse(JSON.stringify(store.project)) as { presetFavorites: string[]; devicePresets: { name: string; params: { cutoff: number } }[] }
    expect(saved.presetFavorites).toContain(`${device.kind}:Mine`)
    expect(saved.devicePresets.find((item) => item.name === 'Mine')?.params.cutoff).toBe(333)
  })

  it('plays an imported wavetable without denormals', () => {
    const device = makeDevice('wave')
    const data = new Float32Array(1024)
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 3 * i) / 256)
    device.zones = [{ id: 'z', bufferId: 'buf', root: 60, lo: 0, hi: 127, loopStart: 0, loopEnd: 1, tune: 0 }]
    device.params.attack = 1
    device.params.sustain = 1
    device.params.position = 0.5
    const runtime = new RackRuntime(48000)
    runtime.note(60, 0.8, 2)
    const rendered = runtime.render({ devices: [device], cables: [], polyphony: 2 }, 4000, 120, 'full', new Map([['buf', { sampleRate: 48000, channels: [data] }]]))
    expect(rms(rendered[0])).toBeGreaterThan(0.01)
    assertClean(rendered[0])
  })
})

import { describe, expect, it } from 'vitest'
import { chokeTargets, normalizePadKit } from '../model/padMachine'
import {
  assignPlan,
  detectToneKey,
  evenSlices,
  fitToTempo,
  parseVintagePresets,
  scaleVintage,
  tempoSlices,
  transientPoints,
  upsertVintagePreset,
  vintageTable,
  FACTORY_VINTAGE,
} from '../model/padChop'
import { setPadRegion, setPadVintage } from '../ui/padVoiceAdapter'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('beat machine chop', () => {
  it('splits a 4-bar loop at 120 BPM into sixteen quarter-note slices', () => {
    const rate = 48000
    const bpm = 120
    const beats = 16
    const length = Math.round(rate * 60 / bpm * beats)
    const slices = tempoSlices({ length, sampleRate: rate, bpm, grid: 'quarter' })
    expect(slices).toHaveLength(16)
    expect(slices[0]).toEqual({ start: 0, end: 24000 })
    expect(slices[15]).toEqual({ start: 15 * 24000, end: 16 * 24000 })
    expect(slices.every((slice, index) => slice.end - slice.start === 24000 && slice.start === index * 24000)).toBe(true)
  })

  it('cuts even counts and hears the impulses in a transient chop', () => {
    expect(evenSlices(1600, 4).map((slice) => slice.start)).toEqual([0, 400, 800, 1200])
    const rate = 1000
    const samples = new Float32Array(1000)
    samples[100] = 1
    samples[500] = 1
    const points = transientPoints(samples, rate, 0.9)
    expect(points.some((point) => Math.abs(point - 100) < 30)).toBe(true)
    expect(points.some((point) => Math.abs(point - 500) < 30)).toBe(true)
  })

  it('assigns the first 16 slices and reports how many are left', () => {
    expect(assignPlan(16)).toEqual({ assigned: 16, left: 0 })
    expect(assignPlan(20)).toEqual({ assigned: 16, left: 4 })
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const samples = new Float32Array(1600)
    store.setChopSample(id, samples, 1000, 'Loop')
    store.patchChop(id, { mode: 'even', even: 8 })
    const plan = store.assignChopToPads(id)
    expect(plan).toEqual({ assigned: 8, left: 0 })
    const kit = store.trackKit(id)
    expect(kit.banks[0][0].layers[0].bufferId).toBe(kit.chop?.bufferId)
    expect(kit.banks[0][0].region?.start).toBeCloseTo(0)
    expect(kit.banks[0][1].region?.start).toBeCloseTo(0.125)
    expect(kit.banks[0][7].name).toBe('Slice 8')
  })

  it('saves the chopped kit and the vintage macro with the project', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.setChopSample(id, new Float32Array(800), 8000, 'Dust')
    store.patchTrackKit(id, { vintage: { macro: 0.5, table: FACTORY_VINTAGE[0].table, presetName: 'SP-1200' } })
    const saved = JSON.parse(JSON.stringify(store.project))
    const loaded = new ProjectStore(saved)
    const kit = loaded.trackKit(id)
    expect(kit.chop?.name).toBe('Dust')
    expect(kit.chop?.mode).toBe('tempo')
    expect(kit.vintage?.presetName).toBe('SP-1200')
    expect(normalizePadKit(kit).vintage?.macro).toBeCloseTo(0.5)
  })

  it('moves 80 BPM to about 89.8 at plus two semitones', () => {
    const fit = fitToTempo(80, 90)
    expect(fit.semitones).toBe(2)
    expect(fit.bpm).toBeCloseTo(89.8, 1)
  })

  it('names a C sine as C minor', () => {
    const rate = 48000
    const hz = 261.625565
    const samples = new Float32Array(48000)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / rate)
    const key = detectToneKey(samples, rate)
    expect(key.name).toBe('C')
    expect(key.label).toBe('C minor')
  })

  it('scales every vintage depth by the macro', () => {
    const table = vintageTable({
      wow: { amount: 0.5, curve: 'linear' },
      crackle: { amount: 1, curve: 'linear' },
      lowpass: { amount: 0.4 },
      bits: { amount: 0.8 },
      rate: { amount: 0.2, curve: 'late' },
    })
    expect(scaleVintage(0, table)).toEqual({ wow: 0, crackle: 0, lowpass: 0, bits: 0, rate: 0 })
    const full = scaleVintage(1, table)
    expect(full.wow).toBeCloseTo(0.5)
    expect(full.crackle).toBeCloseTo(1)
    expect(full.rate).toBeCloseTo(0.2)
    const half = scaleVintage(0.5, table)
    expect(half.wow).toBeCloseTo(0.25)
    expect(half.rate).toBeCloseTo(0.05)
    const ease = scaleVintage(0.25, vintageTable({ wow: { amount: 1, curve: 'ease' } }))
    expect(ease.wow).toBeCloseTo(0.15625)
    const call = setPadVintage({ macro: 1, table, presetName: 'SP-1200' })
    expect(call.bits).toBeCloseTo(0.8)
    expect(call.macro).toBe(1)
    expect(call.table.wow.amount).toBeCloseTo(0.5)
    const saved = upsertVintagePreset([], 'Dusty Vinyl', FACTORY_VINTAGE[1].table)
    const replaced = upsertVintagePreset(saved, 'Dusty Vinyl', vintageTable({ crackle: { amount: 0.4 } }))
    expect(replaced).toHaveLength(1)
    expect(parseVintagePresets(JSON.stringify(replaced))[0].table.crackle.amount).toBeCloseTo(0.4)
    expect(parseVintagePresets('not json')).toEqual([])
  })

  it('cuts a pad when another pad shares its choke group', () => {
    const pads = [
      { pitch: 36, choke: 2 },
      { pitch: 38, choke: 2 },
      { pitch: 42, choke: 0 },
    ]
    expect(chokeTargets(pads, 36)).toEqual([38])
    expect(chokeTargets(pads, 42)).toEqual([])
    const region = setPadRegion({ ...makeBare(), choke: 2 }, 'smp', 0.25, 0.5, { reverse: true, gate: 'hold' })
    expect(region.region).toMatchObject({ start: 0.25, end: 0.5, reverse: true })
    expect(region.gate).toBe('hold')
    expect(region.layers[0].bufferId).toBe('smp')
  })
})

function makeBare() {
  return {
    pitch: 36,
    name: 'Kick',
    level: 1,
    pan: 0,
    send: 0,
    choke: 0,
    poly: 'poly' as const,
    tune: 0,
    filter: 1,
    filterEnv: 0,
    attack: 0,
    decay: 1,
    sustain: 1,
    release: 0.1,
    layerMode: 'velocity' as const,
    layers: [],
  }
}

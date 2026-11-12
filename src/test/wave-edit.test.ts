import { describe, expect, it } from 'vitest'
import { renderArrangement } from '../audio/bounce'
import { renderClipChannels } from '../audio/stretch/engine'
import { loopBoundaryStats, renderLoopedCycles } from '../audio/loopSeam'
import { fadeCurve } from '../audio/wave/edit'
import {
  applyEditToClip,
  bodyLength,
  copyRange,
  deleteRange,
  documentFromClip,
  gainToDb,
  normalizeGain,
  pasteRegions,
  reverseRange,
  setFades,
  setGainDb,
  silenceRange,
  trimDocument,
} from '../audio/wave/edit'
import { displayColumns, renderWaveRange } from '../audio/wave/render'
import { createEmptyProject, makeTrack, type AudioClip } from '../model/types'
import { musicalClone } from '../state/ops'
import { ProjectStore } from '../state/store'

function clip(length: number, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id: 'take',
    name: 'Take',
    bufferId: 'buf',
    startSample: 0,
    offsetSamples: 0,
    durationSamples: length,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'local',
    ...patch,
  }
}

function ramp(length: number): Float32Array {
  const data = new Float32Array(length)
  for (let index = 0; index < length; index++) data[index] = index
  return data
}

describe('wave edit model', () => {
  it('trims the start and keeps the remaining audio on the same timeline sample', () => {
    const length = 1000
    const data = ramp(length)
    const before = clip(length)
    const edit = trimDocument(documentFromClip(before, length), 'start', 40)
    const next = applyEditToClip(before, edit, length)
    expect(next.startSample).toBe(40)
    expect(next.offsetSamples).toBe(40)
    expect(next.durationSamples).toBe(960)
    expect(next.wave).toBeUndefined()
    const again = documentFromClip(next, length)
    expect(again.head).toBe(40)
    expect(renderWaveRange([data], again, 0, 4)[0][0]).toBe(40)
  })

  it('reveals dimmed audio when the start handle moves outward', () => {
    const before = clip(80, { startSample: 40, offsetSamples: 40, durationSamples: 80 })
    const edit = trimDocument(documentFromClip(before, 200), 'start', -20)
    const next = applyEditToClip(before, edit, 200)
    expect(next.offsetSamples).toBe(20)
    expect(next.startSample).toBe(20)
    expect(next.durationSamples).toBe(100)
    expect(next.startSample + next.durationSamples).toBe(120)
  })

  it('splits, fades, silences, reverses, and pastes inside the clip', () => {
    const data = ramp(8)
    const base = documentFromClip(clip(8), 8)
    const cut = deleteRange(base, 2, 6)
    expect([...renderWaveRange([data], cut, 0, bodyLength(cut))[0]]).toEqual([0, 1, 6, 7])
    const quiet = silenceRange(base, 2, 4)
    expect([...renderWaveRange([data], quiet, 0, 8)[0]]).toEqual([0, 1, 0, 0, 4, 5, 6, 7])
    const flipped = reverseRange(base, 2, 6)
    expect([...renderWaveRange([data], flipped, 0, 8)[0]]).toEqual([0, 1, 5, 4, 3, 2, 6, 7])
    const copied = copyRange(base, 0, 2)
    const pasted = pasteRegions(base, 4, copied)
    expect([...renderWaveRange([data], pasted, 0, bodyLength(pasted))[0]]).toEqual([0, 1, 2, 3, 0, 1, 4, 5, 6, 7])
  })

  it('fades with a curve, normalizes, and softens a discontinuous join', () => {
    expect(fadeCurve(0.5, 'linear')).toBeCloseTo(0.5)
    expect(fadeCurve(0, 'equal')).toBeCloseTo(0)
    expect(fadeCurve(1, 's')).toBeCloseTo(1)
    expect(fadeCurve(0.5, 'log')).toBeCloseTo(0.25)
    const data = new Float32Array(400)
    data.fill(0.5)
    const faded = setFades(documentFromClip(clip(400), 400), { fadeIn: 100, fadeInShape: 'linear' })
    const heard = renderWaveRange([data], faded, 0, 120, { fades: true })[0]
    expect(heard[0]).toBeCloseTo(0)
    expect(heard[50]).toBeCloseTo(0.25)
    expect(heard[100]).toBeCloseTo(0.5)

    const quiet = new Float32Array(200)
    quiet.fill(0.25)
    const gained = normalizeGain(documentFromClip(clip(200), 200), [quiet])
    expect(gained.gainDb).toBeCloseTo(gainToDb(0.99 / 0.25), 5)

    const step = new Float32Array(400)
    step.fill(0.8)
    for (let index = 200; index < 400; index++) step[index] = -0.8
    const broken = documentFromClip(clip(400), 400)
    broken.regions = [
      { id: 'a', source: 0, length: 200, reverse: false, gain: 1 },
      { id: 'b', source: 200, length: 200, reverse: true, gain: 1 },
    ]
    const joined = renderWaveRange([step], broken, 0, 400)[0]
    expect(joined[199]).toBeCloseTo(0, 4)
    expect(joined[200]).toBeCloseTo(0, 4)
    expect(Math.abs(joined[199] - joined[200])).toBeLessThan(1e-4)
    expect(joined[0]).toBeCloseTo(0.8)
    expect(joined[20]).toBeCloseTo(0.8)
    expect(joined[120]).toBeCloseTo(0.8)
  })

  it('reads a window of a long clip and keeps the samples outside that window untouched', () => {
    const length = 48000 * 30
    const data = new Float32Array(length)
    data[1000] = 0.42
    data[length - 3] = -0.7
    const edit = documentFromClip(clip(length), length)
    const heard = renderWaveRange([data], edit, 990, 1010)[0]
    expect(heard).toHaveLength(20)
    expect(heard[10]).toBeCloseTo(0.42)
    expect(heard[0]).toBe(0)
  })

  it('draws both channels and keeps edits through undo, save, playback, and export', async () => {
    const length = 240
    const mark = 80
    const left = new Float32Array(length)
    const right = new Float32Array(length)
    left[mark] = 0.8
    right[mark] = -0.4
    const project = createEmptyProject(48000)
    project.snap = false
    project.masterVolume = 1
    project.masterPlugins = []
    project.tracks = [makeTrack({
      id: 'vocal',
      name: 'Vocal',
      type: 'audio',
      volume: 1,
      pan: 0,
      input: 'none',
      clips: [clip(length)],
    })]
    const store = new ProjectStore(project, new Map([['buf', { id: 'buf', name: 'take', sampleRate: 48000, channels: [left, right] }]]))
    store.project.snap = false
    store.project.masterVolume = 1
    store.project.masterPlugins = []
    const stereo = displayColumns([left, right], documentFromClip(clip(length), length), 0, length, 16)
    expect(stereo).toHaveLength(2)
    expect(stereo[1].some((bar) => bar.min < 0)).toBe(true)

    const edit = setGainDb(documentFromClip(store.project.tracks[0].clips[0], length), -6)
    store.applyWave('vocal', 'take', edit, 'Gain')
    expect(store.project.tracks[0].clips[0].gain).toBeCloseTo(10 ** (-6 / 20), 5)
    store.undo()
    expect(store.project.tracks[0].clips[0].gain).toBe(1)
    store.redo()
    expect(store.project.tracks[0].clips[0].gain).toBeCloseTo(10 ** (-6 / 20), 5)
    store.undo()

    const flipped = reverseRange(documentFromClip(store.project.tracks[0].clips[0], length), 0, length)
    store.applyWave('vocal', 'take', flipped, 'Reverse')
    const saved = musicalClone(store.project)
    expect(saved.tracks[0].clips[0].wave?.regions[0].reverse).toBe(true)
    const played = renderClipChannels([left], saved.tracks[0].clips[0], saved, 'hq')[0]
    expect(played[length - 1 - mark]).toBeCloseTo(0.8)
    expect(played[length - 1]).toBe(0)

    store.project.masterPlugins = []
    const printed = await renderArrangement(store.project, store.buffers, 0, length, false)
    let peakAt = 0
    let peak = 0
    for (let index = 0; index < printed[0].length; index++) {
      if (Math.abs(printed[0][index]) > peak) {
        peak = Math.abs(printed[0][index])
        peakAt = index
      }
    }
    expect(peakAt).toBe(length - 1 - mark)

    store.splitWaveClip('vocal', 'take', 100)
    const parts = store.project.tracks[0].clips
    expect(parts).toHaveLength(2)
    expect(parts[0].durationSamples + parts[1].durationSamples).toBe(length)
    expect(parts[0].fadeOutSamples).toBeGreaterThanOrEqual(8)
    expect(parts[1].fadeInSamples).toBeGreaterThanOrEqual(8)
    store.undo()
    expect(store.project.tracks[0].clips).toHaveLength(1)
    expect(store.project.tracks[0].clips[0].wave?.regions[0].reverse).toBe(true)
  })

  it('loops a reversed, faded, and silenced clip on the cycle and exports the edit', async () => {
    const rate = 48000
    const length = rate
    const mark = 4000
    const data = new Float32Array(length)
    for (let index = 0; index < length; index++) data[index] = Math.cos((2 * Math.PI * 12 * index) / length) * 0.45
    data[mark] = 0.9
    const reversed = reverseRange(documentFromClip(clip(length), length), 0, length)
    const faded = setFades(reversed, { fadeIn: 64, fadeOut: 64, fadeInShape: 'equal', fadeOutShape: 'equal' })
    const heard = renderWaveRange([data], faded, 0, length, { fades: true })[0]
    expect(heard[0]).toBeCloseTo(0, 4)
    expect(Math.abs(heard[length - 1])).toBeLessThan(0.02)
    expect(heard[length - 1 - mark]).toBeGreaterThan(0.7)
    const stats = loopBoundaryStats(heard, rate)
    expect(stats.hole).toBeLessThan(rate * 0.01)
    expect(stats.seamRms).toBeGreaterThan(stats.bodyRms * 0.2)
    const played = renderLoopedCycles(heard, rate, 2)
    expect(played[length + (length - 1 - mark)]).toBeGreaterThan(0.7)
    expect(Math.abs((played[length] || 0) - (played[length - 1] || 0))).toBeLessThan(0.05)

    const quiet = silenceRange(documentFromClip(clip(length), length), 2000, 2200)
    const silenced = renderWaveRange([data], quiet, 0, length)[0]
    expect(silenced[2100]).toBe(0)
    expect(Math.abs(silenced[100])).toBeGreaterThan(0.2)
    expect(loopBoundaryStats(silenced, rate).hole).toBeLessThan(rate * 0.01)

    const project = createEmptyProject(rate)
    project.snap = false
    project.masterVolume = 1
    project.masterPlugins = []
    project.loopEnabled = true
    project.loopStartSample = 0
    project.loopEndSample = length
    project.tracks = [makeTrack({
      id: 'vocal',
      name: 'Vocal',
      type: 'audio',
      volume: 1,
      pan: 0,
      input: 'none',
      clips: [clip(length)],
    })]
    const store = new ProjectStore(project, new Map([['buf', { id: 'buf', name: 'take', sampleRate: rate, channels: [data] }]]))
    store.project.masterPlugins = []
    store.project.masterVolume = 1
    store.applyWave('vocal', 'take', reversed, 'Reverse')
    const printed = await renderArrangement(store.project, store.buffers, 0, length, false)
    let peakAt = 0
    let peak = 0
    for (let index = 0; index < printed[0].length; index++) {
      if (Math.abs(printed[0][index]) > peak) {
        peak = Math.abs(printed[0][index])
        peakAt = index
      }
    }
    expect(peakAt).toBe(length - 1 - mark)
  })
})

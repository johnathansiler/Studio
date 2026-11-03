import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createPlugin, normalizeProject } from '../audio/plugins/catalog'
import { migratePlugin } from '../audio/plugins/ids'
import { defaultParams } from '../audio/plugins/catalog'
import {
  arrangeSong,
  chopsFor,
  expandChord,
  hitRoute,
  humanizeHit,
  humanizeNotes,
  kitFromSlices,
  loadsIntoSampler,
  mpcTempo,
  repeatSetting,
  repeatVelocity,
  setStepVelocity,
  shapeVelocity,
  smoothPad,
  stepOn,
  stepVelocity,
  toggleStep,
  touchVelocity,
} from '../instruments/mpc/model'
import { pointerVelocity } from '../audio/performer'
import { preparePadPcm, renderMpcAudio } from '../instruments/mpc/render'
import { createKit } from '../model/padMachine'
import { createEmptyProject, type PluginInstance } from '../model/types'
import { soundFileUrl } from '../sounds/source'
import { ProjectStore } from '../state/store'
import { PadsPanel } from '../ui/PadsPanel'

const engine = {
  unlock() {},
  resume: async () => {},
  status: 'stopped',
  positionSamples: 0,
  sampleRate: 48000,
  subscribe: () => () => {},
  setPadRoute() {},
  setBeatPump() {},
  setRepeatWatch() {},
  tempo: 120,
} as unknown as AudioEngine

function tone(length: number) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 4 * i) / length)
  return data
}

describe('sampler drums', () => {
  it('loads sampler, pads, looper, and drum ids as the Sampler plugin', () => {
    expect(loadsIntoSampler('sampler')).toBe(true)
    expect(loadsIntoSampler('pads')).toBe(true)
    expect(loadsIntoSampler('looper')).toBe(true)
    expect(loadsIntoSampler('drum-machine')).toBe(true)
    expect(loadsIntoSampler('808')).toBe(true)
    const pads = migratePlugin(plugin('pads'), defaultParams)
    const drums = migratePlugin(plugin('drum-machine'), defaultParams)
    const eight = migratePlugin(plugin('808'), defaultParams)
    const loop = migratePlugin(plugin('looper', {
      looper: { layers: [{ id: 'a', bufferId: 'loop-buf', gain: 1, mute: false, reverse: false, speed: 1 }], undone: [], sync: true, bars: 1, feedback: 0, transport: 0, startBeat: 0, lengthSamples: 10, sourceRate: 44100 },
    }), defaultParams)
    expect(pads).toMatchObject({ pluginId: 'sampler', params: { kind: 1 } })
    expect(drums).toMatchObject({ pluginId: 'sampler', params: { kind: 1 } })
    expect(eight).toMatchObject({ pluginId: 'sampler', params: { kind: 1 } })
    expect(loop?.pluginId).toBe('sampler')
    expect(loop?.params.kind).toBe(0)
    expect(loop?.sampler?.bufferId).toBe('loop-buf')
    const opened = normalizeProject({
      ...createEmptyProject(),
      tracks: [{ ...createEmptyProject().tracks[0], plugins: [createPlugin('pads'), createPlugin('808')] }],
    })
    expect(opened.tracks[0].plugins.every((item) => item.pluginId === 'sampler' && item.params.kind === 1)).toBe(true)
  })

  it('keeps the beat machine on a MIDI track and chooses MIDI, audio, or both', () => {
    const store = new ProjectStore(createEmptyProject())
    const audio = store.project.tracks.find((track) => track.type === 'audio')!
    const midi = store.project.tracks.find((track) => track.type === 'midi')!
    store.addPlugin(audio.id, 'drum-machine')
    expect(store.track(midi.id)?.instrument).toBe('pads')
    expect(store.track(midi.id)?.plugins.some((plugin) => plugin.pluginId === 'sampler' && plugin.params.kind === 1)).toBe(true)
    expect(store.track(audio.id)?.plugins.some((plugin) => plugin.pluginId === 'sampler')).toBe(false)
    const kit = createKit()
    expect(hitRoute(kit, { muted: false, busId: 'bus' })).toEqual({ midi: true, audio: true, busId: '' })
    expect(hitRoute({ ...kit, output: 'midi', multiOut: true }, { muted: false, busId: 'bus' })).toEqual({ midi: true, audio: false, busId: 'bus' })
    expect(hitRoute({ ...kit, output: 'audio' }, { muted: true })).toEqual({ midi: false, audio: false, busId: '' })
    store.insertPads(midi.id)
    store.armPadRecord(midi.id, 0)
    store.patchTrackKit(midi.id, { output: 'audio' })
    store.commitPadHits(midi.id, [{ pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 1 }])
    expect(store.track(midi.id)!.midiClips[0].notes).toHaveLength(0)
    store.patchTrackKit(midi.id, { output: 'midi', midiTrackId: '' })
    store.commitPadHits(midi.id, [{ pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 1 }])
    expect(store.track(midi.id)!.midiClips[0].notes.map((note) => note.pitch)).toEqual([36])
  })

  it('records a pad chord and can drive another instrument track', () => {
    const kit = createKit()
    kit.banks[0][0].chord = [38, 42]
    const notes = expandChord([{ pitch: 36, startBeat: 0, durationBeats: 0.2, velocity: 1 }], kit.banks.flat())
    expect(notes.map((note) => note.pitch)).toEqual([36, 38, 42])
    const store = new ProjectStore(createEmptyProject())
    const midi = store.project.tracks.filter((track) => track.type === 'midi')
    store.insertPads(midi[0].id)
    store.addTracks({ kind: 'midi', count: 1, instrument: 'synth', input: 'mic', channels: 1, armed: false })
    const other = store.project.tracks.filter((track) => track.type === 'midi' && track.id !== midi[0].id).at(-1)!
    store.armPadRecord(midi[0].id, 0)
    store.updateTrackPad(midi[0].id, 0, 0, { chord: [40] })
    store.patchTrackKit(midi[0].id, { output: 'both', midiTrackId: other.id })
    store.commitPadHits(midi[0].id, [{ pitch: 36, startBeat: 1, durationBeats: 0.25, velocity: 0.8 }])
    expect(store.track(midi[0].id)!.midiClips[0].notes.map((note) => note.pitch).sort()).toEqual([36, 40])
    expect(store.track(other.id)!.midiClips[0].notes.map((note) => note.pitch).sort()).toEqual([36, 40])
  })

  it('repeats from quarters through thirty-second triplets, with pressure and swing tempo', () => {
    expect(repeatSetting('1/4').beats).toBe(1)
    expect(repeatSetting('1/32').beats).toBeCloseTo(1 / 8)
    expect(repeatSetting('1/8t').triplet).toBe(true)
    expect(repeatSetting('1/8t').beats).toBeCloseTo((1 / 2) * (2 / 3))
    expect(repeatSetting('nope').id).toBe('1/16')
    expect(repeatVelocity(1, 0, true)).toBeCloseTo(0.35)
    expect(repeatVelocity(0.5, 1, false)).toBeCloseTo(0.5)
    expect(mpcTempo(true, 90, 120)).toBe(120)
    expect(mpcTempo(false, 90, 120)).toBe(90)
    let notes = toggleStep([], 36, 0, 0.25)
    notes = toggleStep(notes, 36, 2, 0.25)
    expect(stepOn(notes, 36, 0, 0.25)).toBe(true)
    expect(stepOn(notes, 36, 1, 0.25)).toBe(false)
    notes = toggleStep(notes, 36, 0, 0.25)
    expect(stepOn(notes, 36, 0, 0.25)).toBe(false)
  })

  it('chops by transient, grid, and manual markers, and reverses a window', () => {
    const data = tone(1600)
    data[100] = 1
    data[800] = 1
    expect(chopsFor(data, 1000, 'grid', { regions: 4 })).toHaveLength(4)
    expect(chopsFor(data, 1000, 'manual', { markers: [400, 800] }).map((chop) => chop.start)).toEqual([0, 400, 800])
    const whole = preparePadPcm(data, { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: false })
    expect(whole).toBe(data)
    const reversed = preparePadPcm(data, { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: true })
    expect(reversed[0]).toBeCloseTo(data[data.length - 1])
    expect(reversed).not.toBe(data)
  })

  it('renders audio for audio out and stays silent for MIDI out', () => {
    const kit = createKit()
    const pad = kit.banks[0][0]
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: 'kick' }]
    const buffers = new Map([['kick', { sampleRate: 48000, samples: tone(480) }]])
    const notes = [{ pitch: pad.pitch, startBeat: 0, durationBeats: 0.5, velocity: 1 }]
    const audio = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes, pads: [pad], buffers, output: 'audio' })
    const midi = renderMpcAudio({ sampleRate: 48000, tempo: 120, notes, pads: [pad], buffers, output: 'midi' })
    expect(audio.left.some((sample) => Math.abs(sample) > 0.01)).toBe(true)
    expect(audio.left.every((sample) => Number.isFinite(sample))).toBe(true)
    expect(midi.left).toHaveLength(0)
    const song = arrangeSong({
      ...kit,
      sequences: [{ id: 'A', name: 'Pattern', lengthBeats: 4, notes }],
      song: [{ sequenceId: 'A', repeats: 2 }],
    })
    expect(song.map((span) => span.startBeat)).toEqual([0, 4])
    expect(song[1].notes[0].pitch).toBe(pad.pitch)
  })

  it('prints audio to an audio track and keeps sounds on the Hugging Face library', () => {
    const store = new ProjectStore(createEmptyProject())
    const midi = store.project.tracks.find((track) => track.type === 'midi')!
    store.insertPads(midi.id)
    store.assignTrackPad(midi.id, 0, 0, { name: 'Kick', samples: tone(480), sampleRate: 48000 })
    store.armPadRecord(midi.id, 0)
    store.commitPadHits(midi.id, [{ pitch: 36, startBeat: 0, durationBeats: 0.5, velocity: 1 }])
    const audioId = store.printMpcAudio(midi.id)
    const audio = store.track(audioId!)!
    expect(audio.type).toBe('audio')
    expect(audio.clips[0].durationSamples).toBeGreaterThan(100)
    expect(store.buffers.get(audio.clips[0].bufferId)?.channels).toHaveLength(2)
    store.patchTrackKit(midi.id, { output: 'midi' })
    expect(store.printMpcAudio(midi.id)).toBeNull()
    const slices = kitFromSlices([{ bufferId: 'slice', root: 60, loopStart: 0.1, loopEnd: 0.4, reverse: true }], createKit())
    expect(slices.banks[0][0].layers[0].bufferId).toBe('slice')
    expect(slices.banks[0][0].region?.reverse).toBe(true)
    const url = soundFileUrl('one-shots/drums/kick.wav')
    expect(url.startsWith('https://huggingface.co/datasets/cueharbor/sound-library/')).toBe(true)
    expect(url.includes('render.com') || url.includes('cloudflare')).toBe(false)
    expect(() => soundFileUrl('https://cdn.jsdelivr.net/gh/example/kick.wav')).toThrow()
  })

  it('humanizes live hits and rewrites a recorded pattern', () => {
    const straight = humanizeHit(1, 0.8, 0, 0, 0.2, 0.8)
    expect(straight.beat).toBe(1)
    expect(straight.velocity).toBeCloseTo(0.8)
    const late = humanizeHit(1, 0.5, 0.1, 0.2, 1, 1)
    expect(late.beat).toBeCloseTo(1.1)
    expect(late.velocity).toBeCloseTo(0.7)
    const early = humanizeHit(1, 0.5, 0.1, 0.2, 0, 0)
    expect(early.shift).toBeCloseTo(-0.1)
    expect(early.velocity).toBeCloseTo(0.3)
    const sequence = [{ startBeat: 0, velocity: 0.8 }, { startBeat: 1, velocity: 0.8 }]
    const once = humanizeNotes(sequence, 0.1, 0.25, mulberry(4))
    const twice = humanizeNotes(sequence, 0.1, 0.25, mulberry(4))
    expect(twice).toEqual(once)
    expect(once.some((note) => note.startBeat !== 0 && note.startBeat !== 1 || note.velocity !== 0.8)).toBe(true)
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.armPadRecord(id, 0)
    store.patchTrackKit(id, { humanizeTime: 0.1, humanizeVelocity: 0.3, seed: 3 })
    store.commitPadHits(id, [
      { pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 0.8 },
      { pitch: 36, startBeat: 1, durationBeats: 0.25, velocity: 0.8 },
    ])
    store.toggleMpcStep(id, 0, 0, 0, 0.8)
    store.toggleMpcStep(id, 0, 0, 4, 0.8)
    store.humanizePadTake(id)
    const clip = store.track(id)!.midiClips[0].notes
    expect(clip[0].startBeat !== 0 || clip[1].startBeat !== 1 || clip.some((note) => note.velocity !== 0.8)).toBe(true)
    const pattern = store.trackKit(id).sequences[0].notes
    expect(pattern.length).toBe(2)
    expect(pattern.some((note) => note.velocity !== 0.8 || (note.startBeat !== 0 && note.startBeat !== 1))).toBe(true)
  })

  it('shapes velocity and edits it on a step', () => {
    expect(shapeVelocity(0.25, { curve: 0, amount: 1, min: 0, max: 1, fixed: 1, sensitivity: 1 })).toBeCloseTo(0.25)
    expect(shapeVelocity(0.25, { curve: 1, amount: 1, min: 0, max: 1, fixed: 1, sensitivity: 1 })).toBeCloseTo(0.5)
    expect(shapeVelocity(0.5, { curve: 2, amount: 1, min: 0, max: 1, fixed: 1, sensitivity: 1 })).toBeCloseTo(0.25)
    expect(shapeVelocity(0.2, { curve: 3, amount: 1, min: 0, max: 1, fixed: 0.85, sensitivity: 1 })).toBeCloseTo(0.85)
    expect(shapeVelocity(1, { curve: 0, amount: 1, min: 0.4, max: 0.6, fixed: 0.5, sensitivity: 1 })).toBeCloseTo(0.6)
    expect(shapeVelocity(0.2, { curve: 0, amount: 0, min: 0, max: 1, fixed: 0.9, sensitivity: 0 })).toBeCloseTo(0.9)
    let notes = toggleStep([], 36, 2, 0.25, 0.4)
    notes = setStepVelocity(notes, 36, 2, 0.25, 0.7)
    expect(stepVelocity(notes, 36, 2, 0.25)).toBeCloseTo(0.7)
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.toggleMpcStep(id, 0, 0, 3, 0.4)
    store.setMpcStepVelocity(id, 0, 0, 3, 0.66)
    expect(store.trackKit(id).sequences[0].notes[0].velocity).toBeCloseTo(0.66)
    store.updateTrackPad(id, 0, 0, { velocitySense: 0.25 })
    expect(store.trackKit(id).banks[0][0].velocitySense).toBeCloseTo(0.25)
  })

  it('reads velocity from where the finger lands and blends reported pressure', () => {
    expect(smoothPad(0.25)).toBeLessThan(0.25)
    expect(smoothPad(0.75)).toBeGreaterThan(0.75)
    expect(touchVelocity({ place: 1 })).toBe(1)
    expect(touchVelocity({ place: 0 })).toBeCloseTo(1 / 127)
    expect(touchVelocity({ place: 1 })).toBeGreaterThan(touchVelocity({ place: 0.5 }))
    expect(touchVelocity({ place: 0.5 })).toBeGreaterThan(touchVelocity({ place: 0 }))
    const blended = touchVelocity({ place: 1, pressure: 0.2 })
    expect(blended).toBeLessThan(1)
    expect(blended).toBeGreaterThan(0.7)
    expect(touchVelocity({ place: 0.2, radius: 28 })).toBeGreaterThan(touchVelocity({ place: 0.2 }))
    const pad = { top: 10, height: 100 }
    expect(pointerVelocity({ clientY: 10, pressure: 0.5, pointerType: 'mouse' }, pad)).toBe(1)
    expect(pointerVelocity({ clientY: 110, pressure: 0.5, pointerType: 'mouse' }, pad)).toBeCloseTo(1 / 127)
    const touch = pointerVelocity({ clientY: 10, pressure: 0.2, pointerType: 'touch', width: 2, height: 2 }, pad)
    expect(touch).toBeLessThan(1)
    expect(touch).toBeCloseTo(touchVelocity({ place: 1, pressure: 0.2 }))
  })

  it('shows the drums face with full words, 40px pads, and no covering popup', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).toContain('Sampler')
    expect(html).toContain('Drums')
    expect(html).toContain('MIDI out')
    expect(html).toContain('Audio out')
    expect(html).toContain('Both')
    expect(html).toContain('Note repeat')
    expect(html).toContain('mpc-full')
    expect(html).toContain('ch-raised')
    expect(html).toContain('CueHarbor')
    expect(html).toContain('>F1<')
    expect(html).toContain('aria-label="Data wheel"')
    expect(html).toContain('Play start')
    expect(html).not.toContain('Akai')
    expect(html).toContain('Full level')
    expect(html).toContain('velocity 127')
    expect(html).toContain('Humanize')
    expect(html).toContain('aria-label="Humanize timing"')
    expect(html).toContain('aria-label="Humanize velocity"')
    expect(html).toContain('aria-label="Velocity curve"')
    expect(html).toContain('aria-label="Velocity minimum"')
    expect(html).toContain('aria-label="Velocity maximum"')
    expect(html).toContain('aria-label="Fixed velocity"')
    expect(html).toContain('aria-label="Velocity sensitivity"')
    expect(html).toContain('aria-label="Step velocity"')
    expect(html).toContain('>Linear<')
    expect(html).toContain('>Fixed<')
    expect(html).toContain('Thirty-second triplet')
    expect(html).toContain('aria-label="Step 1"')
    expect(html).toContain('aria-label="Step 16"')
    expect(html).not.toContain('role="dialog"')
    const css = readFileSync(new URL('../ui/pads.css', import.meta.url), 'utf8')
    expect(css).toContain('min-height: 40px')
    expect(css).toContain('white-space: normal')
    expect(css).toContain('overflow: visible')
  })
})

function mulberry(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let next = state
    next = Math.imul(next ^ (next >>> 15), next | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function plugin(id: string, extra: Partial<PluginInstance> = {}): PluginInstance {
  return {
    id,
    pluginId: id,
    version: '1',
    enabled: true,
    wet: 1,
    params: {},
    sidechain: '',
    ...extra,
  }
}

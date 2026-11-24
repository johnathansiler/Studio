import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderBass808, bassActive, bassNote, createBassState, glideLength, midiHz } from '../audio/bass808/voice'
import { bassPadPitches, slideLinks } from '../audio/bass808/pattern'
import { BASS808_SHOTS, shotRoot } from '../audio/bass808/shots'
import { graphPlugins } from '../audio/arrangeSources'
import { RackRuntime } from '../audio/rack/dsp'
import { createPlugin, defaultParams, normalizeProject } from '../audio/plugins/catalog'
import { migratePlugin } from '../audio/plugins/ids'
import { transposeMidiClip } from '../model/harmonize'
import { normalizeProjectRack, makeDevice } from '../model/rack'
import { scaleById } from '../model/scale'
import { createEmptyProject, makeTrack } from '../model/types'
import { soundFileUrl } from '../sounds/source'
import { ProjectStore } from '../state/store'
import { Bass808Panel } from '../ui/Bass808Panel'
import type { AudioEngine } from '../audio/engine'

function measureHz(channel: Float32Array, sampleRate: number, startAt = 0) {
  const start = Math.min(channel.length - 2, Math.max(0, startAt))
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value || 1)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 12)
  const mean = window.reduce((sum, period) => sum + period, 0) / Math.max(1, window.length)
  return sampleRate / mean
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function mag(samples: Float32Array, freq: number, sampleRate: number) {
  const n = samples.length
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = (samples[i] || 0) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) * 2) / n
}

function maxDelta(channel: Float32Array, from: number, to: number) {
  let max = 0
  const end = Math.min(channel.length, to)
  for (let i = Math.max(1, from); i < end; i++) max = Math.max(max, Math.abs(channel[i] - channel[i - 1]))
  return max
}

const clean = {
  glide: 0,
  gmode: 1,
  drop: 0,
  decay: 4000,
  sustain: 1,
  tone: 8000,
  drive: 0,
  sub: 0,
  click: 0,
  level: 0.8,
  source: 0,
  root: 36,
}

describe('808 bass voice', () => {
  it('slides to the target pitch within the glide time without a click', () => {
    const sr = 48000
    const span = glideLength(100, sr)
    const start = 2000
    const rendered = renderBass808(
      { ...clean, glide: 100, gmode: 1 },
      [
        { sample: 0, pitch: 36, vel: 0.9 },
        { sample: start, pitch: 48, vel: 0.9, slide: true },
      ],
      sr,
      start + span + 64,
    )
    expect(span).toBe(4800)
    expect(Math.abs(rendered.midi[start + span] - 48)).toBeLessThan(0.02)
    expect(Math.abs(rendered.midi[start + Math.floor(span / 2)] - 48)).toBeGreaterThan(3)
    expect(Math.abs(rendered.midi[start] - 36)).toBeLessThan(0.02)
    for (let i = start; i < start + span; i++) {
      expect(rendered.midi[i + 1]).toBeGreaterThanOrEqual(rendered.midi[i] - 1e-6)
    }
    expect(maxDelta(rendered.left, start - 8, start + span + 8)).toBeLessThan(0.08)
    for (const sample of rendered.left) expect(Number.isFinite(sample)).toBe(true)
  })

  it('steals the single voice in mono mode', () => {
    const sr = 48000
    const state = createBassState()
    bassNote(state, 36, 0.9, false, clean, sr)
    expect(bassActive(state)).toBe(1)
    bassNote(state, 48, 0.85, false, clean, sr)
    bassNote(state, 40, 0.8, false, clean, sr)
    expect(bassActive(state)).toBe(1)
    expect(state.held).toEqual([36, 48, 40])
    expect(state.glideTo).toBe(40)

    const device = makeDevice('bass808')
    Object.assign(device.params, clean, { gmode: 1, glide: 0 })
    const rack = { devices: [device], cables: [], polyphony: 8 }
    const runtime = new RackRuntime(sr)
    runtime.note(36, 0.9, 8)
    runtime.render(rack, 3000, 120, 'full', new Map())
    runtime.note(48, 0.9, 8)
    runtime.note(55, 0.85, 8)
    const tail = runtime.render(rack, 12000, 120, 'full', new Map())[0]
    const body = tail.subarray(4000)
    expect(cents(measureHz(body, sr), midiHz(55))).toBeLessThan(8)
    expect(mag(body, midiHz(55), sr)).toBeGreaterThan(mag(body, midiHz(36), sr) * 4)
    expect(mag(body, midiHz(55), sr)).toBeGreaterThan(mag(body, midiHz(48), sr) * 4)
  })

  it('tunes a sample so the root plays at that MIDI pitch', () => {
    const sr = 48000
    const root = 36
    const buf = new Float32Array(sr)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * midiHz(root) * i) / sr)
    const played = renderBass808(
      { ...clean, source: 1, root, sub: 0, click: 0, drive: 0, tone: 12000 },
      [{ sample: 0, pitch: 48, vel: 0.9 }],
      sr,
      sr / 2,
      { samples: buf, sampleRate: sr },
    )
    expect(cents(measureHz(played.left, sr, Math.round(sr * 0.05)), midiHz(48))).toBeLessThan(15)
  })
})

describe('808 bass presets and pattern', () => {
  it('loads a preset, undoes it, and keeps it in a saved project', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.addQuickTrack('bass808')
    expect(id).toBeTruthy()
    const track = store.track(id!)!
    expect(track.instrument).toBe('bass808')
    expect(track.name).toBe('808 Bass 1')
    expect(track.plugins.some((plugin) => plugin.pluginId === 'bass808')).toBe(true)
    expect(track.rack?.polyphony).toBe(1)
    const device = track.rack!.devices.find((item) => item.kind === 'bass808')!
    expect(device.params.glide).toBe(90)
    store.applyDevicePreset(id!, device.id, 'Drill Slide (140)')
    expect(device.params.glide).toBe(140)
    expect(device.params.gmode).toBe(0)
    expect(device.params.drive).toBeCloseTo(0.38)
    store.undo()
    expect(store.track(id!)!.rack!.devices.find((item) => item.id === device.id)!.params.glide).toBe(90)
    store.applyDevicePreset(id!, device.id, 'Long Glide')
    const saved = normalizeProjectRack(normalizeProject(JSON.parse(JSON.stringify(store.project))))
    const restored = saved.tracks.find((item) => item.id === id)!
    expect(restored.instrument).toBe('bass808')
    expect(restored.plugins.some((plugin) => plugin.pluginId === 'bass808')).toBe(true)
    expect(restored.rack!.devices.find((item) => item.kind === 'bass808')!.params.glide).toBe(640)
    expect(migratePlugin(createPlugin('bass808'), defaultParams)?.pluginId).toBe('bass808')

    store.project.scale = { ...store.project.scale!, root: 2, scale: 'aeolian' }
    store.insertBassPattern(id!)
    const clip = store.track(id!)!.midiClips.find((item) => item.name === 'Drill / Trap')!
    const scale = scaleById('aeolian').intervals
    expect(clip.notes.length).toBeGreaterThan(4)
    expect(clip.notes.some((note) => note.slide)).toBe(true)
    for (const note of clip.notes) {
      expect(scale).toContain(((note.pitch - 2) % 12 + 12) % 12)
    }
    const slides = clip.notes.filter((note) => note.slide).length
    transposeMidiClip(clip, 3)
    expect(clip.notes.filter((note) => note.slide)).toHaveLength(slides)
    expect(clip.notes[0].pitch % 12).toBe((2 + 3) % 12)
    store.undo()
    expect(store.track(id!)!.midiClips.some((item) => item.name === 'Drill / Trap')).toBe(false)
  })

  it('draws a slide line between a slide note and the note it leaves', () => {
    const links = slideLinks([
      { id: 'a', pitch: 36, startBeat: 0, durationBeats: 1 },
      { id: 'b', pitch: 43, startBeat: 1, durationBeats: 1, slide: true },
      { id: 'c', pitch: 40, startBeat: 3, durationBeats: 1 },
    ])
    expect(links).toEqual([{ from: expect.objectContaining({ id: 'a' }), to: expect.objectContaining({ id: 'b' }) }])
    const pads = bassPadPitches(0, 'ionian')
    expect(pads[0] % 12).toBe(0)
    expect(new Set(pads.map((pitch) => pitch % 12)).size).toBe(pads.length > 7 ? 7 : pads.length)
  })

  it('points sample shots at catalog paths without renaming them', () => {
    expect(BASS808_SHOTS.map((shot) => shot.id)).toEqual([
      'hw-mbase-mbase-11-808-01-808-c1-wav',
      'hw-mbase-mbase-11-808-06-808-f1-wav',
      'hw-mbase-mbase-11-808-10-808-a1-wav',
      'hw-mbase-mbase-11-808-dist-01-808-dist-c1-wav',
    ])
    for (const shot of BASS808_SHOTS) {
      expect(soundFileUrl(shot.path)).toContain(shot.path.split('/').pop()!.replace(/ /g, '%20'))
      expect(shotRoot(shot)).toBeGreaterThan(0)
    }
    expect(shotRoot(BASS808_SHOTS[0])).toBe(24)
  })

  it('keeps the 808 insert out of the audio effect chain and shows the panel', () => {
    const eq = createPlugin('eq')
    const bass = createPlugin('bass808')
    const chain = graphPlugins(makeTrack({ name: '808 Bass', type: 'midi', instrument: 'bass808', plugins: [bass, eq] }))
    expect(chain.find((plugin) => plugin.pluginId === 'bass808')!.enabled).toBe(false)
    expect(chain.find((plugin) => plugin.pluginId === 'eq')!.enabled).toBe(true)

    const store = new ProjectStore(createEmptyProject())
    const id = store.addQuickTrack('bass808')!
    const html = renderToStaticMarkup(createElement(Bass808Panel, {
      store,
      engine: { status: 'stopped', sampleRate: 48000, unlock() {}, playThrough() {}, releaseThrough() {}, currentTimelineSample: () => 0 } as unknown as AudioEngine,
      trackId: id,
      onClose() {},
      onRecord() {},
      onStop() {},
      onPlay() {},
    }))
    expect(html).toContain('808 Bass')
    expect(html).toContain('Drill Slide (140)')
    expect(html).toContain('Trap 808')
    expect(html).toContain('Boom Bap Sub')
    expect(html).toContain('Distorted 808')
    expect(html).toContain('Long Glide')
    expect(html).toContain('Short Punch')
    expect(html).toContain('Drill/Trap pattern')
    expect(html).toContain('Legato only')
    expect(html).toContain('aria-label="Transport"')
    expect(html).toContain('Glide')
  })

  it('offers 808 Bass from Add Track and the instrument list', async () => {
    const { AddTrackButton } = await import('../ui/AddTrack')
    const { INSTRUMENT_DEVICES } = await import('../model/sessionBoard')
    const { insertMenuChoices } = await import('../ui/pluginInserts')
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(AddTrackButton, { store }))
    expect(html).toContain('808 Bass')
    expect(html).toContain('Instrument. Play keys.')
    expect(INSTRUMENT_DEVICES.some((item) => item.id === 'bass808' && item.name === '808 Bass')).toBe(true)
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    expect(insertMenuChoices(store, keys.id).some((item) => item.id === 'bass808')).toBe(true)
    store.addPlugin(keys.id, 'bass808')
    expect(store.track(keys.id)!.instrument).toBe('bass808')
    expect(store.bassTrackId).toBe(keys.id)
  })
})

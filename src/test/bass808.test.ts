import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderBass808, bassActive, bassNote, createBassState, glideLength, midiHz, BASS808_ATTACK_MS } from '../audio/bass808/voice'
import { RackRuntime, renderNotes } from '../audio/rack/dsp'
import { bassPadDegree, bassPadPitches, BASS_PAD_EXTRA, drillTrapPattern, slideLinks } from '../audio/bass808/pattern'
import { BASS808_SHOTS, shotRoot } from '../audio/bass808/shots'
import { graphPlugins } from '../audio/arrangeSources'
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

  it('keeps gliding to the target when the note it left is released', () => {
    const sr = 48000
    const span = glideLength(100, sr)
    const start = 2000
    const off = start + Math.floor(span / 2)
    const rendered = renderBass808(
      { ...clean, glide: 100, gmode: 1 },
      [
        { sample: 0, pitch: 36, vel: 0.9 },
        { sample: start, pitch: 48, vel: 0.9, slide: true },
        { sample: off, pitch: 36, vel: 0 },
      ],
      sr,
      start + span + 32,
    )
    expect(Math.abs(rendered.midi[off] - 36)).toBeGreaterThan(1)
    expect(Math.abs(rendered.midi[start + span] - 48)).toBeLessThan(0.02)
    for (let i = start; i < start + span; i++) {
      expect(rendered.midi[i + 1]).toBeGreaterThanOrEqual(rendered.midi[i] - 1e-6)
    }
    expect(maxDelta(rendered.left, off - 8, off + 8)).toBeLessThan(0.08)
  })

  it('glides a same-sample handoff only in always mode or when the note is marked slide', () => {
    const sr = 48000
    const span = glideLength(80, sr)
    const at = 2400
    const events = [
      { sample: 0, pitch: 36, vel: 0.9 },
      { sample: at, pitch: 36, vel: 0 },
      { sample: at, pitch: 48, vel: 0.85 },
    ]
    const legato = renderBass808({ ...clean, glide: 80, gmode: 1 }, events, sr, at + 8)
    expect(Math.abs(legato.midi[at] - 48)).toBeLessThan(0.02)
    const marked = renderBass808(
      { ...clean, glide: 80, gmode: 1 },
      events.map((event, index) => index === 2 ? { ...event, slide: true } : event),
      sr,
      at + span + 8,
    )
    expect(Math.abs(marked.midi[at] - 36)).toBeLessThan(0.5)
    expect(Math.abs(marked.midi[at + span] - 48)).toBeLessThan(0.02)
    const always = renderBass808({ ...clean, glide: 80, gmode: 0 }, events, sr, at + span + 8)
    expect(Math.abs(always.midi[at] - 36)).toBeLessThan(0.5)
    expect(Math.abs(always.midi[at + span] - 48)).toBeLessThan(0.02)
    for (let i = at; i < at + span; i++) {
      expect(always.midi[i + 1]).toBeGreaterThanOrEqual(always.midi[i] - 1e-6)
    }
  })

  it('matches the rack bounce to the voice, including a queued release', () => {
    const sr = 48000
    const length = 9000
    const params = { ...clean, glide: 90, gmode: 1 }
    const events = [
      { sample: 0, pitch: 36, vel: 0.9 },
      { sample: 4000, pitch: 36, vel: 0 },
      { sample: 4000, pitch: 43, vel: 0.8, slide: true },
      { sample: 7000, pitch: 43, vel: 0 },
    ]
    const voice = renderBass808(params, events, sr, length)
    const device = makeDevice('bass808')
    Object.assign(device.params, params)
    const rack = { devices: [device], cables: [], polyphony: 1 }
    const bounced = renderNotes(rack, events, sr, 140, length)[0]
    const live = new RackRuntime(sr)
    live.note(36, 0.9, 1, false)
    live.render(rack, 4000, 140, 'full', new Map())
    live.note(43, 0.8, 1, true)
    live.note(36, 0, 1, false)
    const mid = live.render(rack, 3000, 140, 'full', new Map())[0]
    live.note(43, 0, 1, false)
    const rest = live.render(rack, 2000, 140, 'full', new Map())[0]
    let bounceGap = 0
    let liveGap = 0
    for (let i = 0; i < length; i++) bounceGap = Math.max(bounceGap, Math.abs(bounced[i] - voice.left[i]))
    for (let i = 0; i < mid.length; i++) liveGap = Math.max(liveGap, Math.abs(mid[i] - voice.left[4000 + i]))
    for (let i = 0; i < rest.length; i++) liveGap = Math.max(liveGap, Math.abs(rest[i] - voice.left[7000 + i]))
    expect(bounceGap).toBeLessThan(1e-5)
    expect(liveGap).toBeLessThan(1e-5)
    expect(Math.abs(voice.midi[4000] - 36)).toBeLessThan(0.5)
    expect(Math.abs(voice.midi[4000 + glideLength(90, sr)] - 43)).toBeLessThan(0.02)
  })

  it('keeps the default attack identical and stays click-free at zero', () => {
    const sr = 48000
    const legacy = renderBass808(clean, [{ sample: 0, pitch: 36, vel: 0.9 }], sr, 4000)
    const named = renderBass808({ ...clean, attack: BASS808_ATTACK_MS }, [{ sample: 0, pitch: 36, vel: 0.9 }], sr, 4000)
    let gap = 0
    for (let i = 0; i < legacy.left.length; i++) gap = Math.max(gap, Math.abs(legacy.left[i] - named.left[i]))
    expect(gap).toBe(0)
    const fast = renderBass808({ ...clean, attack: 0, click: 0, drop: 0 }, [{ sample: 0, pitch: 48, vel: 1 }], sr, 2000)
    expect(maxDelta(fast.left, 0, 64)).toBeLessThan(0.08)
    const slow = renderBass808({ ...clean, attack: 800, sustain: 1, click: 0, drop: 0 }, [{ sample: 0, pitch: 36, vel: 1 }], sr, sr)
    const early = Math.abs(slow.left[Math.round(sr * 0.02)] || 0)
    const late = Math.abs(slow.left[Math.round(sr * 0.5)] || 0)
    expect(early).toBeLessThan(Math.abs(named.left[Math.round(sr * 0.02)] || 0) * 0.5)
    expect(late).toBeGreaterThan(early * 2)
  })

  it('slides from the last pitch in always mode after the note has gone quiet', () => {
    const sr = 48000
    const gap = Math.round(sr * 1.4)
    const rendered = renderBass808(
      { ...clean, glide: 100, gmode: 0, sustain: 0, decay: 40 },
      [
        { sample: 0, pitch: 36, vel: 0.9 },
        { sample: 2000, pitch: 36, vel: 0 },
        { sample: gap, pitch: 48, vel: 0.9 },
      ],
      sr,
      gap + 64,
    )
    expect(Math.abs(rendered.midi[gap] - 36)).toBeLessThan(0.5)
    expect(Math.abs(rendered.midi[gap + 20] - 48)).toBeGreaterThan(0.2)
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
    const overlapped = slideLinks([
      { id: 'held', pitch: 36, startBeat: 0, durationBeats: 1.15 },
      { id: 'into', pitch: 43, startBeat: 1, durationBeats: 0.7, slide: true },
      { id: 'older', pitch: 40, startBeat: 0, durationBeats: 0.4 },
    ])
    expect(overlapped).toEqual([{ from: expect.objectContaining({ id: 'held' }), to: expect.objectContaining({ id: 'into' }) }])
    const pattern = drillTrapPattern(9, 'aeolian').map((note, index) => ({ ...note, id: String(index) }))
    const drawn = slideLinks(pattern)
    expect(drawn).toHaveLength(pattern.filter((note) => note.slide).length)
    for (const link of drawn) {
      expect(link.from.startBeat).toBeLessThan(link.to.startBeat)
      expect(link.from.startBeat + link.from.durationBeats).toBeGreaterThan(link.to.startBeat)
    }
    const pads = bassPadPitches(0, 'ionian')
    expect(pads).toHaveLength(8 + BASS_PAD_EXTRA * 2)
    expect(pads[BASS_PAD_EXTRA]).toBe(bassPadDegree(0, 'ionian', 0))
    expect(new Set(pads.map((pitch) => pitch % 12)).size).toBe(7)
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
    expect(html).toContain('>Close<')
    expect(html).toContain('>Tone<')
    expect(html).toContain('>Play<')
    expect(html).not.toContain('plugin-transport')
    expect(html).not.toContain('data-plugin-transport')
    expect(html).not.toContain('aria-label="Transport"')
    expect(html).not.toContain('aria-label="Record"')
    expect(html).not.toContain('>Record<')
    expect(html).not.toContain('>Stop<')
    expect(html).toContain('Glide')
    expect(html).toContain('Attack')
    expect(html).toContain('aria-label="Attack"')
    expect(html).toContain('Pad F1')
    expect(html).toContain('Pad G3')
    expect(html).toContain('F1 – G3')
  })

  it('keeps an attack edit through undo, automation, and a saved project', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.addQuickTrack('bass808')!
    const device = store.track(id)!.rack!.devices.find((item) => item.kind === 'bass808')!
    expect(device.params.attack).toBe(1.5)
    const spec = { trackId: id, target: 'instrument' as const, param: 'attack', deviceId: device.id, min: 0, max: 2000 }
    store.setAutomated(spec, 240, false, 0)
    expect(store.track(id)!.rack!.devices.find((item) => item.id === device.id)!.params.attack).toBe(240)
    store.undo()
    expect(store.track(id)!.rack!.devices.find((item) => item.id === device.id)!.params.attack).toBe(1.5)
    store.project.automationMode = 'latch'
    store.setAutomated(spec, 640, true, 4800)
    const lane = store.project.rackAutomation.find((item) => item.deviceId === device.id && item.param === 'attack')
    expect(lane?.points.length).toBeGreaterThan(0)
    const saved = JSON.parse(JSON.stringify(store.project))
    expect(saved.tracks.find((item: { id: string }) => item.id === id).rack.devices.find((item: { kind: string }) => item.kind === 'bass808').params.attack).toBe(640)
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

  it('extends each end of the bass pads by four scale degrees', () => {
    const count = 8
    for (const scaleId of ['ionian', 'aeolian', 'majorPentatonic', 'dimHalfWhole']) {
      const pads = bassPadPitches(2, scaleId)
      expect(pads, scaleId).toHaveLength(count + BASS_PAD_EXTRA * 2)
      for (let index = 0; index < pads.length; index++) {
        expect(pads[index], `${scaleId} ${index}`).toBe(bassPadDegree(2, scaleId, index - BASS_PAD_EXTRA))
      }
      const oldLow = bassPadDegree(2, scaleId, 0)
      const oldHigh = bassPadDegree(2, scaleId, count - 1)
      expect(pads[BASS_PAD_EXTRA], scaleId).toBe(oldLow)
      expect(pads[pads.length - 1 - BASS_PAD_EXTRA], scaleId).toBe(oldHigh)
      expect(pads[0], scaleId).toBeLessThan(oldLow)
      expect(pads[pads.length - 1], scaleId).toBeGreaterThan(oldHigh)
      expect(new Set(pads).size, scaleId).toBe(pads.length)
    }
  })

  it('keeps the new low pads tuned and audible, and band-limits a sample played above its root', () => {
    const sr = 48000
    const low = bassPadDegree(0, 'majorPentatonic', -BASS_PAD_EXTRA)
    expect(low).toBeGreaterThanOrEqual(24)
    const played = renderBass808(
      { ...clean, sustain: 1, decay: 4000 },
      [{ sample: 0, pitch: low, vel: 1 }],
      sr,
      sr,
    )
    expect(cents(measureHz(played.left, sr, 8000), midiHz(low))).toBeLessThan(20)
    expect(Math.max(...played.left.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.05)
    for (const sample of played.left) expect(Number.isFinite(sample)).toBe(true)

    const rootHz = midiHz(36)
    const lowBuffer = new Float32Array(sr)
    for (let i = 0; i < lowBuffer.length; i++) lowBuffer[i] = Math.sin((2 * Math.PI * rootHz * i) / sr)
    const sampled = renderBass808(
      { ...clean, source: 1, root: 36, tone: 8000, sustain: 1, decay: 4000 },
      [{ sample: 0, pitch: low, vel: 1 }],
      sr,
      sr,
      { samples: lowBuffer, sampleRate: sr },
    )
    expect(cents(measureHz(sampled.left, sr, 8000), midiHz(low))).toBeLessThan(30)
    expect(Math.max(...sampled.left.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.02)

    const tone = 10000
    const buffer = new Float32Array(sr)
    for (let i = 0; i < buffer.length; i++) buffer[i] = Math.sin((2 * Math.PI * tone * i) / sr)
    const high = renderBass808(
      { ...clean, source: 1, root: 36, tone: 18000, sustain: 1, decay: 4000 },
      [{ sample: 0, pitch: 60, vel: 1 }],
      sr,
      sr / 2,
      { samples: buffer, sampleRate: sr },
    )
    const slice = high.left.subarray(2000, 8000)
    expect(mag(slice, 8000, sr)).toBeLessThan(0.05)
    for (const sample of high.left) expect(Number.isFinite(sample)).toBe(true)
  })
})

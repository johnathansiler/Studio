import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { CATALOG } from '../audio/plugins/catalog'
import {
  applyChoke,
  assignPad,
  chokeGroup,
  clipBeat,
  padRecordWindow,
  pickDefaultKit,
  quantizePadBeat,
  recordPadHits,
  swingPercent,
} from '../instruments/pads/record'
import { createKit } from '../model/padMachine'
import { browserGroup } from '../model/sessionBoard'
import { createEmptyProject } from '../model/types'
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
} as unknown as AudioEngine

describe('pads drum machine', () => {
  it('records pad hits onto the clip at the played beats', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.armPadRecord(id, 0)
    store.commitPadHits(id, [
      { pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 0.9 },
      { pitch: 38, startBeat: 1, durationBeats: 0.2, velocity: 0.8 },
      { pitch: 42, startBeat: 1.5, durationBeats: 0.1, velocity: 0.6 },
    ])
    const clip = store.track(id)!.midiClips.find((item) => item.name === 'Pads')!
    expect(clip.durationBeats).toBeCloseTo(4)
    expect(clip.notes.map((note) => note.pitch)).toEqual([36, 38, 42])
    expect(clip.notes.map((note) => note.startBeat)).toEqual([0, 1, 1.5])
    expect(store.track(id)?.instrument).toBe('pads')
    expect(store.track(id)?.plugins.some((plugin) => plugin.pluginId === 'pads')).toBe(true)
    expect(store.padsTrackId).toBe(id)
  })

  it('overdubs the next loop pass into the same clip', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.armPadRecord(id, 0)
    store.commitPadHits(id, [{ pitch: 36, startBeat: 0, durationBeats: 0.25, velocity: 1 }])
    store.commitPadHits(id, [
      { pitch: 38, startBeat: 4.5, durationBeats: 0.2, velocity: 0.7 },
      { pitch: 36, startBeat: 6, durationBeats: 0.2, velocity: 0.8 },
    ])
    const notes = store.track(id)!.midiClips[0].notes
    expect(notes).toHaveLength(3)
    expect(notes.map((note) => note.pitch)).toEqual([36, 38, 36])
    expect(notes[1].startBeat).toBeCloseTo(0.5)
    expect(notes[2].startBeat).toBeCloseTo(2)
    const replaced = recordPadHits(notes.map((note) => ({ startBeat: note.startBeat })), [{ startBeat: 1 }], 'replace', 0, 4)
    expect(replaced.map((note) => note.startBeat)).toEqual([1])
  })

  it('quantizes with MPC swing and leaves timing alone when quantize is off', () => {
    expect(swingPercent(0)).toBe(50)
    expect(swingPercent(0.5)).toBe(75)
    expect(quantizePadBeat(0.12, 0.25, 1, 50, true)).toBeCloseTo(0)
    expect(quantizePadBeat(0.3, 0.25, 1, 75, true)).toBeCloseTo(0.375)
    expect(quantizePadBeat(0.3, 0.25, 1, 75, false)).toBeCloseTo(0.3)
    expect(clipBeat(5.25, 0, 0, 4)).toBeCloseTo(1.25)
    expect(clipBeat(9.5, 4, 4, 8)).toBeCloseTo(1.5)
    expect(padRecordWindow({ playheadBeat: 5, loopEnabled: false, loopStartBeat: 0, loopEndBeat: 16, barBeats: 4 })).toEqual({ startBeat: 4, durationBeats: 4 })
    expect(padRecordWindow({ playheadBeat: 5, loopEnabled: true, loopStartBeat: 8, loopEndBeat: 12, barBeats: 4 })).toEqual({ startBeat: 8, durationBeats: 4 })
  })

  it('cuts the open hat when the closed hat shares its choke group', () => {
    const pads = [
      { pitch: 42, choke: 1 },
      { pitch: 46, choke: 1 },
      { pitch: 36, choke: 0 },
    ]
    expect(chokeGroup(pads, 42)).toEqual([46])
    expect(chokeGroup(pads, 36)).toEqual([])
    const notes = [
      { pitch: 46, startBeat: 0, durationBeats: 1 },
      { pitch: 36, startBeat: 0, durationBeats: 0.4 },
    ]
    const cut = applyChoke(notes, pads, 42, 0.25)
    expect(cut[0].durationBeats).toBeCloseTo(0.25)
    expect(cut[1].durationBeats).toBeCloseTo(0.4)
  })

  it('assigns a dragged sound without moving the pad pitch', () => {
    const pad = createKit().banks[0][0]
    const next = assignPad(pad, { name: 'Room Kick', bufferId: 'smp_kick' })
    expect(next.pitch).toBe(36)
    expect(next.name).toBe('Room Kick')
    expect(next.layers[0].bufferId).toBe('smp_kick')
    expect(next.choke).toBe(0)
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.assignTrackPad(id, 0, 4, { name: 'Closed Hat', samples: new Float32Array([0.1, -0.1]), sampleRate: 48000 })
    const hat = store.trackKit(id).banks[0][4]
    expect(hat.pitch).toBe(42)
    expect(hat.name).toBe('Closed Hat')
    expect(hat.choke).toBe(1)
    expect(hat.layers[0].bufferId).toBeTruthy()
    store.updateTrackPad(id, 0, 4, { muted: true, level: 0.4, pan: -0.2, tune: 3, decay: 0.5 })
    const edited = store.trackKit(id).banks[0][4]
    expect(edited.muted).toBe(true)
    expect(edited.level).toBeCloseTo(0.4)
    expect(edited.pan).toBeCloseTo(-0.2)
    expect(edited.tune).toBeCloseTo(3)
    expect(edited.decay).toBeCloseTo(0.5)
  })

  it('picks a CC0 kit from drum one-shots and docks the faceplate', () => {
    const picks = pickDefaultKit([
      { id: 'k', name: 'Kit kick', path: 'one-shots/drums/kick.wav', type: 'one-shot', tags: ['drums', 'kick'] },
      { id: 's', name: 'Kit snare', path: 'one-shots/drums/snare.wav', type: 'one-shot', tags: ['drums', 'snare'] },
      { id: 'h', name: 'Closed hat', path: 'one-shots/drums/hat.wav', type: 'one-shot', tags: ['drums', 'hat'] },
      { id: 'o', name: 'Open hat', path: 'one-shots/drums/open-hat.wav', type: 'one-shot', tags: ['drums', 'hat', 'open'] },
      { id: 'loop', name: 'Drum loop', path: 'loops/drums/beat.wav', type: 'loop', tags: ['drums'] },
    ])
    expect(picks.map((pick) => pick.id)).toEqual(['k', 's', 'h', 'o'])
    expect(picks[3].index).toBe(5)
    expect(CATALOG.find((plugin) => plugin.id === 'pads')?.name).toBe('Pads')
    expect(browserGroup('plugins').map((item) => item.name)).toContain('Pads')
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).toContain('data-pads="plugin"')
    expect(html).toContain('aria-label="Pads"')
    expect(html).not.toContain('role="dialog"')
    expect(html.match(/data-pad=/g)?.length).toBe(16)
    expect(html).toContain('>A<')
    expect(html).toContain('>D<')
    expect(html).toContain('>Record<')
    const css = readFileSync(new URL('../ui/pads.css', import.meta.url), 'utf8')
    expect(css).toContain('text-align: center')
    expect(css).toContain('overflow: visible')
    expect(css).toMatch(/box-shadow:[^;]*inset/)
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('PadsPanel')
    expect(app).toContain('insertPads')
  })
})

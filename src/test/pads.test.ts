import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { CATALOG, createPlugin } from '../audio/plugins/catalog'
import { isDrumsPlugin } from '../audio/plugins/ids'
import { isBeatMachineId, showsOpenBeatMachine } from '../instruments/pads/identity'
import {
  applyChoke,
  assignPad,
  chokeGroup,
  clipBeat,
  padFaceName,
  padRecordWindow,
  pickDefaultKit,
  quantizePadBeat,
  recordPadHits,
  shortPadName,
  swingPercent,
} from '../instruments/pads/record'
import { createKit } from '../model/padMachine'
import { browserGroup } from '../model/sessionBoard'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { facePadIndex, PadsPanel } from '../ui/PadsPanel'
import { OpenBeatMachineButton } from '../ui/BeatMachineButton'
import { InsertList, insertChoices, insertLabel } from '../ui/PluginSheet'

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
    const clip = store.track(id)!.midiClips.find((item) => item.name === 'Beat Machine')!
    expect(clip.durationBeats).toBeCloseTo(4)
    expect(clip.notes.map((note) => note.pitch)).toEqual([36, 38, 42])
    expect(clip.notes.map((note) => note.startBeat)).toEqual([0, 1, 1.5])
    expect(store.track(id)?.instrument).toBe('pads')
    expect(store.track(id)?.plugins.some((plugin) => plugin.pluginId === 'sampler' && plugin.params.kind === 1)).toBe(true)
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
    expect(next.name).toBe('Kick')
    expect(next.sampleName).toBe('Room Kick')
    expect(padFaceName(next)).toBe('Kick')
    expect(next.layers[0].bufferId).toBe('smp_kick')
    expect(next.choke).toBe(0)
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.assignTrackPad(id, 0, 4, { name: 'Closed Hat', samples: new Float32Array([0.1, -0.1]), sampleRate: 48000 })
    const hat = store.trackKit(id).banks[0][4]
    expect(hat.pitch).toBe(42)
    expect(hat.name).toBe('Hat')
    expect(hat.sampleName).toBe('Closed Hat')
    expect(padFaceName(hat)).toBe('Hat')
    expect(hat.choke).toBe(1)
    expect(hat.layers[0].bufferId).toBeTruthy()
    const stored = store.buffers.get(hat.layers[0].bufferId!)!.channels[0]
    expect(Math.max(...stored.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.9)
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
    expect(shortPadName('Bass Drum 1 – BDrumNe w hit v2 rr1 Sum')).toBe('Bass Drum 1')
    expect(shortPadName('Gogodze kit hihat closed vel 1 rr1')).toBe('Gogodze kit hihat closed')
    expect(CATALOG.find((plugin) => plugin.id === 'sampler')?.name).toBe('Sampler')
    expect(browserGroup('plugins').map((item) => item.name)).toContain('Sampler')
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    const html = renderToStaticMarkup(createElement(PadsPanel, { store, engine, trackId: id, onRecord: () => {}, onEdit: () => {} }))
    expect(html).toContain('ch-sheet')
    expect(html).toContain('ch-raised')
    expect(html).toContain('ch-tab')
    expect(html).toContain('data-pads="plugin"')
    expect(html).toContain('aria-label="Beat Machine"')
    expect(html).toContain('>Beat Machine<')
    expect(html).not.toContain('role="dialog"')
    expect(html).not.toContain('aria-label="Screen"')
    expect(html.match(/data-pad=/g)?.length).toBe(8)
    expect(html).toContain('>Bank A<')
    expect(html).toContain('>Bank B<')
    expect(html).toContain('>Kit A<')
    expect(html).toContain('>Kit H<')
    expect(html).toContain('>Record<')
    const slots = [0, 1].flatMap((page) => Array.from({ length: 8 }, (_, slot) => facePadIndex(page, slot)))
    expect(slots).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
    store.assignTrackPad(id, 0, 8, { name: 'Saved crash', samples: new Float32Array([0.2, -0.2]), sampleRate: 48000 })
    expect(store.trackKit(id).banks[0][8].sampleName).toBe('Saved crash')
    expect(store.trackKit(id).banks[0][8].pitch).toBe(41)
    expect(facePadIndex(1, 0)).toBe(8)
    const css = readFileSync(new URL('../ui/pads.css', import.meta.url), 'utf8')
    expect(css).toContain('text-align: center')
    expect(css).toContain('overflow: visible')
    expect(css).toContain('var(--raised)')
    expect(css).toContain('.mpc-pad.ch-raised')
    expect(css).toContain('.mpc-meter')
    expect(css).toContain('translateY(8px)')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain('PadsPanel')
    expect(app).toContain('insertPads')
    expect(app).toContain('onOpenBeatMachine')
    const arrange = readFileSync(new URL('../ui/ArrangeView.tsx', import.meta.url), 'utf8')
    expect(arrange).toContain('OpenBeatMachineButton')
    expect(readFileSync(new URL('../ui/chrome.ts', import.meta.url), 'utf8')).toContain('Open Beat Machine')
  })

  it('swaps a MIDI track to the beat machine from the insert picker and reopens from the header', () => {
    for (const id of ['sampler', 'pads', 'drums', 'drum-machine']) expect(isBeatMachineId(id)).toBe(true)
    const drumsPlugin = createPlugin('pads')
    expect(drumsPlugin.pluginId).toBe('sampler')
    expect(isDrumsPlugin(drumsPlugin)).toBe(true)
    expect(insertLabel(drumsPlugin.pluginId, drumsPlugin)).toBe('Beat Machine')
    expect(insertLabel('sampler')).toBe('Sampler')
    const choices = insertChoices(CATALOG, true).map((item) => item.name)
    expect(choices[0]).toBe('Step Sequencer')
    expect(choices[1]).toBe('Beat Machine')
    expect(insertChoices(CATALOG, false).some((item) => item.name === 'Beat Machine')).toBe(false)
    expect(browserGroup('drums')[0]).toMatchObject({ id: 'pads', name: 'Beat Machine' })
    expect(browserGroup('instruments')[0]).toMatchObject({ id: 'steps', name: 'Step Sequencer' })
    expect(browserGroup('instruments')[1]).toMatchObject({ id: 'pads', name: 'Beat Machine' })

    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    expect(showsOpenBeatMachine(store.track(id)!)).toBe(false)
    store.addPlugin(id, 'sampler')
    expect(store.track(id)?.instrument).not.toBe('pads')
    expect(store.track(id)?.plugins.some((plugin) => plugin.pluginId === 'sampler' && !isDrumsPlugin(plugin))).toBe(true)
    store.addPlugin(id, 'drums')
    expect(store.track(id)?.instrument).toBe('pads')
    expect(store.padsTrackId).toBe(id)
    expect(showsOpenBeatMachine(store.track(id)!)).toBe(true)
    store.closePads()
    expect(store.padsTrackId).toBeNull()
    const header = renderToStaticMarkup(createElement(OpenBeatMachineButton, { store, trackId: id }))
    expect(header).toContain('Open Beat Machine')
    expect(header).toContain(`data-beat-machine="${id}"`)
    store.addPlugin(id, 'drum-machine')
    expect(store.track(id)?.instrument).toBe('pads')
    expect(store.padsTrackId).toBe(id)
    const inserts = renderToStaticMarkup(createElement(InsertList, { store, trackId: id }))
    expect(inserts).toContain('>Beat Machine<')
    const made = store.addTracks({ kind: 'midi', count: 1, instrument: 'pads', input: 'mic', channels: 1, armed: false })
    expect(store.track(made[0])?.name).toBe('Beat Machine 1')
  })
})

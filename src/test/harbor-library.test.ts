import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { selectLayers } from '../audio/multisample/map'
import { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import {
  INSTRUMENT_LIBRARY,
  fillKeyboard,
  instrumentCatalogUrl,
  instrumentFileUrl,
  legacyAlias,
  licenseLabel,
  parseHarborCatalog,
  parseSamplePath,
  programFromPaths,
  programFromRoots,
  zonesFromPaths,
} from '../harbor'
import { NOTE_SURFACES, subscribeInstrumentVoice } from '../harbor/surfaces'
import { ProjectStore } from '../state/store'
import { HarborBrowser } from '../ui/HarborBrowser'

const catalog = parseHarborCatalog(JSON.parse(readFileSync(new URL('./fixtures/instrument-library.json', import.meta.url), 'utf8')))
const roots = JSON.parse(readFileSync(new URL('./fixtures/instrument-roots.json', import.meta.url), 'utf8')) as Record<string, number[]>

describe('live instrument catalog', () => {
  it('pins the dataset commit and reads the published document', () => {
    expect(INSTRUMENT_LIBRARY.revision).toBe('e6b451a1517ac2e450dd4a1b538e8aceaad25b08')
    expect(INSTRUMENT_LIBRARY.catalog).toBe('catalog.json')
    expect(instrumentCatalogUrl()).toBe('https://huggingface.co/datasets/cueharbor/instrument-library/resolve/e6b451a1517ac2e450dd4a1b538e8aceaad25b08/catalog.json')
    expect(instrumentFileUrl('loops/collection-of-loops-vol01/090Fxgroove-01.wav')).toBe('https://huggingface.co/datasets/cueharbor/instrument-library/resolve/e6b451a1517ac2e450dd4a1b538e8aceaad25b08/loops/collection-of-loops-vol01/090Fxgroove-01.wav')
    expect(catalog.version).toBe('1')
    expect(catalog.instruments).toHaveLength(40)
    expect(catalog.loops).toHaveLength(1025)
    expect(catalog.instruments.some((item) => item.id === 'black-and-blue-basses')).toBe(true)
    expect(catalog.instruments.some((item) => item.id === 'digrinonf-acoustic-guitar-notes')).toBe(true)
    expect(catalog.instruments.some((item) => item.id === 'modularsamples-cs30l-straight-guitar')).toBe(true)
    expect(catalog.instruments.some((item) => item.id === 'modularsamples-cs30l-toy-piano')).toBe(true)
    expect(catalog.instruments.some((item) => item.id === 'owstu-acoustic-guitar')).toBe(true)
    expect(catalog.instruments.some((item) => legacyAlias(item.path, item.id))).toBe(false)
    expect(legacyAlias('instruments/darkblack-bass/Programs/01-darkblack_keysw.sfz', 'darkblack-bass')).toBe(true)
    const melodic = catalog.loops.filter((loop) => loop.loopKind === 'melodic')
    const drums = catalog.loops.filter((loop) => loop.loopKind === 'drum')
    expect(melodic).toHaveLength(484)
    expect(drums).toHaveLength(541)
    expect(catalog.loops.filter((loop) => (loop.bpm ?? 0) > 0)).toHaveLength(995)
    expect(melodic.filter((loop) => loop.key)).toHaveLength(342)
    expect(catalog.loops.some((loop) => loop.path.endsWith('computer..wav'))).toBe(true)
    expect(licenseLabel('CC0-1.0')).toBe('CC0')
    expect(licenseLabel('public-domain')).toBe('Public domain')
    expect(licenseLabel('public-domain')).not.toBe('CC0')
  })

  it('reads note, velocity, and round robin out of sample names', () => {
    expect(parseSamplePath('instruments/yamaha-upright/Sustains/Upright1_Sus_C0_vl1_rr2.wav').root).toBe(12)
    expect(parseSamplePath('instruments/yamaha-upright/Sustains/Upright1_Sus_C0_vl1_rr2.wav').roundRobin).toBe(2)
    expect(parseSamplePath('instruments/yamaha-upright/Sustains/Upright1_Sus_C0_vl1_rr2.wav').layer).toBe(1)
    expect(parseSamplePath('instruments/black-and-blue-basses/samples/Samples/babyblue/fake_det/babyblue_fake_det_a1_f_rr3.wav', 2).root).toBe(33)
    expect(parseSamplePath('instruments/black-and-blue-basses/samples/Samples/babyblue/fake_det/babyblue_fake_det_a1_f_rr3.wav').dynamic).toBe('f')
    expect(parseSamplePath('instruments/jlearman-steel-drum/SteelDrum_060__C4_4-1.wav').root).toBe(60)
    expect(parseSamplePath('instruments/freepats-nylon-classical/samples/samples/A#3.wav').root).toBe(58)
    expect(parseSamplePath('instruments/yamaha-upright/Releases/Upright1_Rel_C1.wav').release).toBe(true)
    const rows = zonesFromPaths(catalog.instruments.find((item) => item.id === 'yamaha-upright')!, [
      'instruments/yamaha-upright/Sustains/Upright1_Sus_C3_vl1_rr1.wav',
      'instruments/yamaha-upright/Sustains/Upright1_Sus_C3_vl2_rr1.wav',
      'instruments/yamaha-upright/Sustains/Upright1_Sus_G3_vl1_rr1.wav',
    ])
    expect(rows).toHaveLength(3)
    expect(rows.find((row) => row.path.includes('vl2'))?.velLo).toBeGreaterThan(1)
  })

  it('groups bare note files into one instrument', () => {
    const straight = catalog.instruments.find((item) => item.id === 'modularsamples-cs30l-straight-guitar')
    const guitar = catalog.instruments.find((item) => item.id === 'digrinonf-acoustic-guitar-notes')
    expect(straight && guitar).toBeTruthy()
    const straightNotes = [
      'instruments/modularsamples-cs30l-straight-guitar/C2_036.wav',
      'instruments/modularsamples-cs30l-straight-guitar/F#3_054.wav',
      'instruments/modularsamples-cs30l-straight-guitar/C4_060.wav',
      'instruments/modularsamples-cs30l-straight-guitar/C6_084.wav',
    ]
    const straightProgram = programFromPaths(straight!, straightNotes)
    expect(straightProgram?.program.name).toBe('Yamaha CS-30L Straight Guitar')
    expect(straightProgram?.program.zones).toHaveLength(4)
    expect(new Set(zonesFromPaths(straight!, straightNotes).map((row) => row.instrument))).toEqual(new Set(['Yamaha CS-30L Straight Guitar']))
    const bare = [
      'instruments/digrinonf-acoustic-guitar-notes/mediator/F#2.wav',
      'instruments/digrinonf-acoustic-guitar-notes/mediator/F#3.wav',
      'instruments/digrinonf-acoustic-guitar-notes/hammer-on-mediator/F#4.wav',
      'instruments/digrinonf-acoustic-guitar-notes/slide-mediator/F#2.wav',
    ]
    const rows = zonesFromPaths(guitar!, bare)
    expect(new Set(rows.map((row) => row.instrument))).toEqual(new Set(['digrinonf Acoustic Guitar']))
    expect(new Set(rows.map((row) => row.root))).toEqual(new Set([42, 54, 66]))
    expect(rows.some((row) => row.instrument === 'F#2' || row.instrument === 'F#2.wav')).toBe(false)
    const built = programFromPaths(guitar!, bare)
    expect(built?.program.zones.length).toBe(bare.length)
    expect(built?.program.name).toBe('digrinonf Acoustic Guitar')
  })

  it('gives every catalog instrument a zone for MIDI 21 through 108', () => {
    expect(Object.keys(roots)).toHaveLength(catalog.instruments.length)
    for (const instrument of catalog.instruments) {
      const sampled = roots[instrument.id]
      expect(sampled?.length, instrument.id).toBeGreaterThan(0)
      const program = programFromRoots(instrument.id, instrument.name, sampled)
      const filled = fillKeyboard(program)
      for (let note = 21; note <= 108; note++) {
        const played = selectLayers(filled, { note, velocity: 100, keyswitch: filled.defaultSwitch, roundRobin: {}, trigger: 'attack' })
        expect(played.layers.length, `${instrument.id} ${note}`).toBeGreaterThan(0)
      }
      const lowest = selectLayers(filled, { note: 21, velocity: 100, keyswitch: filled.defaultSwitch, roundRobin: {}, trigger: 'attack' })
      const highest = selectLayers(filled, { note: 108, velocity: 100, keyswitch: filled.defaultSwitch, roundRobin: {}, trigger: 'attack' })
      expect(lowest.layers[0].zone.lokey).toBeLessThanOrEqual(21)
      expect(highest.layers[0].zone.hikey).toBeGreaterThanOrEqual(108)
    }
  })
})

describe('instrument library browser', () => {
  it('groups the live instruments and keeps license words honest', () => {
    const store = new ProjectStore(createEmptyProject())
    const engine = { unlock() {}, stopPreview() {}, previewPcm() {}, currentTimelineSample: () => 0 }
    const html = renderToStaticMarkup(createElement(HarborBrowser, { store, engine, section: 'instruments', initial: catalog }))
    for (const family of ['Strings', 'Brass', 'Woodwinds', 'Keys', 'Bass', 'Guitar', 'Mallets', 'World', 'Synth']) {
      expect(html).toContain(family)
    }
    expect(html).toContain('>Load<')
    expect(html).toContain('Osiris Piano')
    expect(html).toContain('digrinonf Acoustic Guitar')
    expect(html).toContain('Yamaha CS-30L Toy Piano')
    expect(html).toContain('Black And Blue')
    expect(html).toContain('CC0')
    expect(html).toContain('Public domain')
    expect(html).not.toContain('darkblack-bass')
    const loops = renderToStaticMarkup(createElement(HarborBrowser, { store, engine, section: 'loops', initial: catalog }))
    expect(loops).toContain('Filter')
    expect(loops).toContain('>Drum<')
    expect(loops).toContain('>Melodic<')
    expect(loops).toContain('>Add<')
  })
})

describe('shared instrument voice', () => {
  it('sends every note surface through one voice', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.setLibrary(track.id, programFromRoots('piano', 'Piano', [60]))
    const engine = new AudioEngine()
    engine.sync(store.project, () => undefined)
    const heard: string[] = []
    const stop = subscribeInstrumentVoice((note) => {
      if (note.down) heard.push(note.surface)
    })
    try {
      engine.voiceNote('keyboard', track.id, 60, 0.8)
      engine.voiceNote('mini', track.id, 64, 0.8)
      engine.voiceNote('pads', track.id, 48, 0.8, 0)
      engine.playThrough(track.id, 67, 0.8, 0, false, 'roll')
      engine.playThrough(track.id, 69, 0.8, 0, false, 'clip')
      engine.voiceNote('arrange', track.id, 72, 0.8, 0)
      engine.playThrough(track.id, 74, 0.8, 0, false, 'record')
      engine.playThrough(track.id, 76, 0.8, 0, true, 'scaler')
      engine.playThrough(track.id, 77, 0.8, 0, false, 'midi')
      expect(heard).toEqual([...NOTE_SURFACES])
    } finally {
      stop()
    }
  })
})

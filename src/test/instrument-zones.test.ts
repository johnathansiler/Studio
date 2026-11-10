import { describe, expect, it } from 'vitest'
import { selectLayers } from '../audio/multisample/map'
import { libraryFileUrl } from '../audio/multisample/source'
import { makeProgram, makeSample, makeZone } from '../audio/multisample/types'
import { instrumentLibraryBase } from '../harbor/contract'
import { instrumentSampleRoot, prepareCatalogInstrument } from '../harbor/load'
import { datasetFilePath, reconcileProgram } from '../harbor/reconcile'
import { fillKeyboard } from '../harbor/zones'
import type { CatalogInstrument } from '../harbor/types'

const base = instrumentLibraryBase()

/**
 * The 16 Osiris files the live console 404'd.
 * They are real dataset misses (noisy mic layers), not spaces left unencoded.
 */
const OSI_MISSING = [
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_B2_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_B2_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_C3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_C3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_D3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_D3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_E3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_E3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_F3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/C/Piano_UC_MicC_F3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_D3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_D3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_E3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_E3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_F3_vl1.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_F3_vl2.flac',
]

const OSI_PRESENT = [
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_B2_vl1.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_B2_vl2.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_C3_vl1.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_C3_vl2.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_D3_vl1.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_D3_vl2.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_E3_vl1.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_E3_vl2.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_F3_vl1.flac',
  'instruments/osiris-piano/UC/C/Piano_UC_MicC_F3_vl2.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_D3_vl1.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_D3_vl2.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_E3_vl1.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_E3_vl2.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_F3_vl1.flac',
  'instruments/osiris-piano/UC/B/Piano_UC_MicB_F3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_B3_vl2.flac',
  'instruments/osiris-piano/UC-noisy/A/Piano_UC_MicA_C4_vl1.flac',
]

function programFor(paths: string[], roots?: number[]) {
  const samples = paths.map((path, index) => makeSample({
    id: `s${index}`,
    url: libraryFileUrl(base, path),
    format: 'wav',
    channels: 2,
  }))
  const zones = samples.map((sample, index) => makeZone({
    id: `z${index}`,
    sampleId: sample.id,
    root: roots?.[index] ?? 60,
    lokey: roots?.[index] ?? 60,
    hikey: roots?.[index] ?? 60,
  }))
  return makeProgram({ name: 'Piano', license: 'CC0-1.0', samples, zones })
}

describe('instrument zone files', () => {
  it('encodes spaces and sharps without dropping them out of the path', () => {
    const sharp = libraryFileUrl(base, 'instruments/toy/F#3.wav')
    const spaced = libraryFileUrl(base, 'instruments/toy/Mic C B2.wav')
    expect(sharp).toContain('F%233.wav')
    expect(spaced).toContain('Mic%20C%20B2.wav')
    expect(new URL(sharp).hash).toBe('')
    expect(datasetFilePath(sharp)).toBe('instruments/toy/F#3.wav')
    expect(datasetFilePath(spaced)).toBe('instruments/toy/Mic C B2.wav')
  })

  it('remaps the missing Osiris layers onto a listed file and keeps every key', () => {
    const program = programFor(OSI_MISSING, OSI_MISSING.map(() => 60))
    const reconciled = reconcileProgram(program, OSI_PRESENT)
    const have = new Set(OSI_PRESENT)
    expect(reconciled.samples.length).toBe(OSI_MISSING.length)
    for (const sample of reconciled.samples) {
      const path = datasetFilePath(sample.url)
      expect(have.has(path), path).toBe(true)
      expect(path.includes('UC-noisy/C'), path).toBe(false)
      expect(sample.channels).toBe(2)
    }
    expect(datasetFilePath(reconciled.samples[0].url)).toBe('instruments/osiris-piano/UC/C/Piano_UC_MicC_B2_vl1.flac')
    const filled = fillKeyboard(reconciled)
    for (let note = 21; note <= 108; note++) {
      const mapped = selectLayers(filled, { note, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'attack' })
      expect(mapped.layers.length, String(note)).toBeGreaterThan(0)
      for (const layer of mapped.layers) expect(have.has(datasetFilePath(layer.sample.url))).toBe(true)
    }
  })

  it('prefers the other velocity in the same folder before a different mic', () => {
    const missing = 'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_B3_vl1.flac'
    const sameFolder = 'instruments/osiris-piano/UC-noisy/B/Piano_UC_MicB_B3_vl2.flac'
    const otherMic = 'instruments/osiris-piano/UC-Sus-noisy/B/Piano_UC-Sus_MicB_B3_vl1.flac'
    const program = programFor([missing], [59])
    const reconciled = reconcileProgram(program, [sameFolder, otherMic])
    expect(datasetFilePath(reconciled.samples[0].url)).toBe(sameFolder)
    expect(reconciled.zones[0].root).toBe(59)
  })

  it('shifts the key center when the only listed sample is a neighboring pitch', () => {
    const missing = 'instruments/toy/Piano_C4_vl1.wav'
    const neighbor = 'instruments/toy/Piano_D4_vl1.wav'
    const program = programFor([missing], [60])
    const reconciled = reconcileProgram(program, [neighbor])
    expect(datasetFilePath(reconciled.samples[0].url)).toBe(neighbor)
    expect(reconciled.zones[0].root).toBe(62)
    const filled = fillKeyboard(reconciled)
    const low = selectLayers(filled, { note: 21, velocity: 40, keyswitch: null, roundRobin: {}, trigger: 'attack' })
    const high = selectLayers(filled, { note: 108, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(low.layers.length).toBeGreaterThan(0)
    expect(high.layers.length).toBeGreaterThan(0)
  })

  it('loads a nested include from the root preset and does not request the missing path', async () => {
    const root = 'instruments/toy'
    const listed = [
      `${root}/Programs/main.sfz`,
      `${root}/Programs/mappings/poly.sfz`,
      `${root}/Programs/mappings/unitra.sfz`,
      `${root}/Samples/c4.wav`,
    ]
    const requests: string[] = []
    const instrument: CatalogInstrument = {
      id: 'toy',
      name: 'Toy',
      license: 'CC0-1.0',
      path: `${root}/Programs/main.sfz`,
      tags: [],
      family: 'Synth',
    }
    expect(instrumentSampleRoot(instrument.path)).toBe(root)
    const program = await prepareCatalogInstrument(instrument, async (url) => {
      requests.push(url)
      if (url.includes('/tree/')) {
        return new Response(JSON.stringify(listed.map((path) => ({ type: 'file', path }))), { headers: { Link: '' } })
      }
      if (url.endsWith('/Programs/main.sfz')) return new Response('#include "mappings/poly.sfz"\n')
      if (url.endsWith('/mappings/poly.sfz') && !url.includes('/mappings/mappings/')) {
        return new Response('#include "mappings/unitra.sfz"\n')
      }
      if (url.endsWith('/mappings/unitra.sfz') && !url.includes('/mappings/mappings/')) {
        return new Response('<region> sample=../Samples/c4.wav key=60\n')
      }
      return new Response('missing', { status: 404 })
    })
    if (!program) throw new Error('nested include produced no program')
    expect(requests.some((url) => url.includes('/mappings/mappings/'))).toBe(false)
    expect(program.samples.map((sample) => datasetFilePath(sample.url))).toEqual([`${root}/Samples/c4.wav`])
    for (let note = 21; note <= 108; note++) {
      const mapped = selectLayers(program, { note, velocity: 100, keyswitch: program.defaultSwitch, roundRobin: {}, trigger: 'attack' })
      expect(mapped.layers.length, String(note)).toBeGreaterThan(0)
    }
  })
})

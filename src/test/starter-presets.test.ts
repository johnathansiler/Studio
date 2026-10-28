import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryBank } from '../audio/multisample/cache'
import { SamplerInstrument, renderSampler } from '../audio/multisample/engine'
import { importDecentSampler } from '../audio/multisample/dspreset'
import { STARTER_CATALOG } from '../audio/multisample/library'
import { selectLayers } from '../audio/multisample/map'
import type { SamplerProgram } from '../audio/multisample/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { LibraryPanel } from '../ui/LibraryPanel'

const nylonXml = readFileSync(new URL('./fixtures/starter/nylon-guitar.dspreset', import.meta.url), 'utf8')
const uprightXml = readFileSync(new URL('./fixtures/starter/upright-piano.dspreset', import.meta.url), 'utf8')

describe('starter instrument labels', () => {
  it('matches catalog.json licenses and descriptions', () => {
    const byId = Object.fromEntries(STARTER_CATALOG.map((entry) => [entry.id, entry]))
    expect(byId['nylon-guitar']).toMatchObject({
      license: 'CC0-1.0',
      path: 'nylon-guitar/instrument.dspreset',
      description: 'CC0 Spanish classical (nylon) guitar from FreePats, chromatic',
    })
    expect(byId['string-section'].description).toBe('CC0 VSCO-2 string ensemble: contrabass, celli, violas and violins (sustain vibrato) split across the keyboard')
    expect(byId['string-section'].description.toLowerCase()).not.toContain('mic')
    expect(byId['upright-piano']).toMatchObject({
      license: 'CC0-1.0',
      description: 'CC0 Knight upright piano (VCSL): 45 sampled notes, 2 velocity layers, release samples',
    })
    expect(byId['felt-piano']).toMatchObject({
      license: 'public-domain',
      description: 'Public-domain Fuchs & Möhr upright with felt (Tom Guder): every key, 3 velocity layers',
    })
    expect(STARTER_CATALOG.some((entry) => entry.license === 'Unlicense' || /unlicensed/i.test(entry.description))).toBe(false)
  })

  it('shows mic mix controls only when the preset has several mic layers', () => {
    const store = new ProjectStore(createEmptyProject())
    const [trackId] = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    const engine = { holdLibraryPack() {}, holdLibraryAudio() {} }
    const panel = () => renderToStaticMarkup(createElement(LibraryPanel, {
      store,
      engine: engine as never,
      trackId,
    }))

    store.setLibrary(trackId, importDecentSampler(`<?xml version="1.0"?>
<DecentSampler>
  <groups>
    <group mic="close"><sample path="close.wav" rootNote="60" loNote="60" hiNote="60"/></group>
    <group mic="room"><sample path="room.wav" rootNote="60" loNote="60" hiNote="60"/></group>
  </groups>
</DecentSampler>`, 'Mics'))
    const mixed = panel()
    expect(mixed).toContain('close mic level')
    expect(mixed).toContain('room mic level')
    expect(mixed).toContain('How loud the close microphone is.')
    expect(mixed).toContain('Mute the room microphone.')

    store.setLibrary(trackId, importDecentSampler(nylonXml, 'nylon-guitar'))
    const single = panel()
    expect(single).not.toContain('mic level')
    expect(single).toContain('CC0 Spanish classical (nylon) guitar from FreePats, chromatic')
    expect(single).not.toContain('mixable mic')
  })
})

describe('DecentSampler amplitude envelope', () => {
  it('reads release, attack, decay, and sustain from the real starter presets', () => {
    const nylon = importDecentSampler(nylonXml, 'nylon-guitar')
    const guitar = selectLayers(nylon, { note: 60, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(guitar.layers).toHaveLength(1)
    expect(guitar.layers[0].zone.ampeg).toMatchObject({ attack: 0, decay: 0, sustain: 1, release: 1 })

    const upright = importDecentSampler(uprightXml, 'upright-piano')
    const piano = selectLayers(upright, { note: 60, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(piano.layers).toHaveLength(1)
    expect(piano.layers[0].zone.ampeg.release).toBe(0.25)
    const release = selectLayers(upright, { note: 60, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'release' })
    expect(release.layers.length).toBeGreaterThan(0)
    expect(release.layers.every((layer) => layer.zone.ampeg.release === 0.3)).toBe(true)
    expect(upright.mics).toHaveLength(1)
  })

  it('inherits ADSR from the instrument, groups, group, and sample', () => {
    const preset = importDecentSampler(`<?xml version="1.0"?>
<DecentSampler attack="0.01" sustain="80">
  <groups decay="0.4" release="0.2" ampEnvRelease="0.55">
    <group attack="0.2" ampEnvHold="0.05">
      <sample path="a.wav" rootNote="60" loNote="60" hiNote="60" release="1.1"/>
    </group>
    <group>
      <sample path="b.wav" rootNote="62" loNote="62" hiNote="62" ampEnvDecay="0.15" sustain="0.25"/>
    </group>
    <group>
      <sample path="c.wav" rootNote="64" loNote="64" hiNote="64"/>
    </group>
  </groups>
</DecentSampler>`)
    const zone = (note: number) => preset.zones.find((item) => item.root === note)!.ampeg
    expect(zone(60)).toMatchObject({ attack: 0.2, hold: 0.05, decay: 0.4, sustain: 0.8, release: 1.1 })
    expect(zone(62)).toMatchObject({ attack: 0.01, hold: 0, decay: 0.15, sustain: 0.25, release: 0.55 })
    expect(zone(64)).toMatchObject({ attack: 0.01, hold: 0, decay: 0.4, sustain: 0.8, release: 0.55 })
  })

  it('keeps the note through the preset release in live playback and the offline render', () => {
    const rate = 48000
    const nylon = attacksOnly(importDecentSampler(nylonXml, 'nylon-guitar'))
    const upright = attacksOnly(importDecentSampler(uprightXml, 'upright-piano'))
    const guitar = tail(nylon, 60, rate)
    const choppedGuitar = tail(forcedRelease(nylon, 0.03), 60, rate)
    expect(guitar.live).toBeGreaterThan(0.08)
    expect(guitar.offline).toBeGreaterThan(0.08)
    expect(choppedGuitar.live).toBeLessThan(0.01)
    expect(choppedGuitar.offline).toBeLessThan(0.01)

    const piano = tail(upright, 60, rate)
    const choppedPiano = tail(forcedRelease(upright, 0.03), 60, rate)
    expect(piano.live).toBeGreaterThan(choppedPiano.live * 8)
    expect(piano.offline).toBeGreaterThan(0.04)
    expect(choppedPiano.offline).toBeLessThan(0.01)

    const shaped = importDecentSampler(`<?xml version="1.0"?>
<DecentSampler>
  <groups attack="0.2" decay="0.05" sustain="0.2" release="1.5">
    <group>
      <sample path="tone.wav" rootNote="60" loNote="0" hiNote="127" loVel="0" hiVel="1"/>
    </group>
  </groups>
</DecentSampler>`)
    const held = renderSampler(shaped, [{ sample: 0, pitch: 60, vel: 1 }], rate, Math.round(rate * 0.45), toneBank(shaped, 60, rate, 1))
    const early = rms(held[0].slice(0, Math.round(rate * 0.02)))
    const late = rms(held[0].slice(Math.round(rate * 0.35), Math.round(rate * 0.45)))
    expect(early).toBeLessThan(0.05)
    expect(late).toBeGreaterThan(0.05)
    expect(late).toBeLessThan(0.18)
  })
})

function attacksOnly(program: SamplerProgram): SamplerProgram {
  return { ...program, zones: program.zones.filter((zone) => zone.trigger === 'attack') }
}

function forcedRelease(program: SamplerProgram, release: number): SamplerProgram {
  return {
    ...program,
    zones: program.zones.map((zone) => ({ ...zone, ampeg: { ...zone.ampeg, release } })),
  }
}

function toneBank(program: SamplerProgram, note: number, rate: number, seconds: number) {
  const bank = new MemoryBank()
  const audio = { sampleRate: rate, channels: [new Float32Array(Math.round(rate * seconds)).fill(0.5)] }
  for (const zone of program.zones) {
    if (note < zone.lokey || note > zone.hikey) continue
    const sample = program.samples.find((item) => item.id === zone.sampleId)
    if (sample) bank.put(sample.id, audio)
  }
  return bank
}

function tail(program: SamplerProgram, note: number, rate: number) {
  const bank = toneBank(program, note, rate, 3)
  const off = Math.round(rate * 0.12)
  const length = Math.round(rate * 0.7)
  const offline = renderSampler(program, [
    { sample: 0, pitch: note, vel: 0.9 },
    { sample: off, pitch: note, vel: 0 },
  ], rate, length, bank)
  const live = new SamplerInstrument(rate, bank)
  live.setProgram(program)
  live.noteOn(note, 0.9)
  live.render(off)
  live.noteOff(note)
  const after = live.render(length - off)
  const start = Math.round(rate * 0.25)
  const end = Math.round(rate * 0.45)
  return {
    offline: rms(offline[0].slice(off + start, off + end)),
    live: rms(after[0].slice(start, end)),
  }
}

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / Math.max(1, channel.length))
}

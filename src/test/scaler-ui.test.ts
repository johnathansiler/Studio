import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ScalerPanel } from '../ui/ScalerPanel'

const engine = {
  unlock() {},
  stopPreview() {},
  auditionScaler() {},
  currentTimelineSample() { return 0 },
  status: 'stopped',
  sampleRate: 48000,
} as unknown as AudioEngine

function panel(page: 'play' | 'key' | 'voice' | 'sound' | 'write') {
  const store = new ProjectStore(createEmptyProject())
  const id = store.project.tracks.find((track) => track.type === 'midi')!.id
  store.insertScaler(id, page)
  return renderToStaticMarkup(createElement(ScalerPanel, { store, engine, trackId: id }))
}

describe('scaler plugin panel', () => {
  it('docks on the track instead of opening a popup', () => {
    const html = panel('play')
    expect(html).toContain('data-scaler="plugin"')
    expect(html).toContain('aria-label="Scaler"')
    expect(html).not.toContain('role="dialog"')
    expect(html).toContain('Chord pads')
    expect(html).toContain('scaler-keys')
    expect(html).toContain('>Modulation<')
    expect(html).toContain('Progression lane')
    expect(html).toContain('Detected scales')
    expect(html).toContain('>Rec<')
    expect(html).toContain('To track')
    expect(html).toContain('Axis')
    expect(html).toContain('Bright')
  })

  it('has key, voicing, sound, and generate inside the plugin', () => {
    expect(panel('key')).toContain('Search scales')
    expect(panel('key')).toContain('Detect')
    const voice = panel('voice')
    expect(voice).toContain('Voicing')
    expect(voice).toContain('Arpeggio')
    expect(voice).toContain('Gate')
    const sound = panel('sound')
    expect(sound).toContain('Library')
    expect(sound).toContain('Track')
    const write = panel('write')
    expect(write).toContain('aria-label="Generate"')
    expect(write).toContain('>Hear<')
    expect(write).toContain('This track')
    expect(write).not.toContain('role="dialog"')
  })

  it('removes the Scales popup and the MIDI library button', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const dock = readFileSync(new URL('../ui/MidiDock.tsx', import.meta.url), 'utf8')
    const roll = readFileSync(new URL('../ui/PianoRoll.tsx', import.meta.url), 'utf8')
    expect(app).toContain('ScalerPanel')
    expect(app).not.toContain('LibraryPop')
    expect(app).not.toContain('label="Scales"')
    expect(app).not.toContain('GeneratePop')
    expect(dock).not.toContain('onLibrary')
    expect(roll).not.toContain('onLibrary')
  })
})

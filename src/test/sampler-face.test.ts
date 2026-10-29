import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { makeProgram, makeSample, makeZone } from '../audio/multisample/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { zoneSummary } from '../ui/SamplerFace'
import { RackView } from '../ui/RackView'

const engine = {
  unlock() {},
  previewRack() {},
  releaseRack() {},
  status: 'stopped',
  currentTimelineSample: () => 0,
} as unknown as AudioEngine

function feltPiano() {
  const zones = Array.from({ length: 4 }, (_, index) => makeZone({
    id: `z${index}`,
    sampleId: `s${index}`,
    lokey: 24 + index * 12,
    hikey: 35 + index * 12,
    root: 28 + index * 12,
  }))
  return makeProgram({
    id: 'felt-piano',
    name: 'Felt Piano',
    samples: zones.map((zone) => makeSample({ id: zone.sampleId })),
    zones,
  })
}

describe('sampler faceplate', () => {
  it('opens the sampler after a library sound loads, including from Patch', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.setLibrary(keys.id, feltPiano())
    expect(store.track(keys.id)!.instrument).toBe('library')
    expect(store.track(keys.id)!.name).toBe('Felt Piano')
    expect(store.rackTrackId).toBe(keys.id)
    expect(store.patchTrackId).toBeNull()
    expect(zoneSummary(store.track(keys.id)!.library!)).toContain('4 zones')

    store.openRack(keys.id)
    expect(store.rackTrackId).toBeNull()
    store.openPatch(keys.id)
    expect(store.patchTrackId).toBeNull()
    expect(store.rackTrackId).toBe(keys.id)

    const html = renderToStaticMarkup(createElement(RackView, { store, engine, trackId: keys.id }))
    expect(html).toContain('data-sampler="face"')
    expect(html).toContain('Felt Piano')
    expect(html).toContain('4 zones')
    expect(html).toContain('Attack')
    expect(html).toContain('Decay')
    expect(html).toContain('Sustain')
    expect(html).toContain('Release')
    expect(html).toContain('Tone')
    expect(html).toContain('Loop')
    expect(html).toContain('aria-label="Keyboard"')
    expect(html).not.toContain('Analog')
    expect(html).not.toContain('Cutoff')
  })

  it('shows the same faceplate for a one-shot loaded onto the keys', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const channel = new Float32Array(480)
    for (let i = 0; i < channel.length; i++) channel[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4
    store.loadSamplerSound(keys.id, { id: 'felt', name: 'Felt Piano', sampleRate: 48000, channels: [channel] })
    expect(store.track(keys.id)!.instrument).toBe('sampler')
    expect(store.rackTrackId).toBe(keys.id)
    const html = renderToStaticMarkup(createElement(RackView, { store, engine, trackId: keys.id }))
    expect(html).toContain('data-sampler="face"')
    expect(html).toContain('aria-label="Sample waveform"')
    expect(html).toContain('Root')
    expect(html).toContain('Attack')
    expect(html).toContain('Tone')
    expect(html).toContain('aria-label="Keyboard"')
    expect(html).not.toContain('Analog')
  })
})

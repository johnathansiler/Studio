import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { emptyPatternLoopSamples, graphRatio, kitChoices, rackPlayIndex, shortSoundName, stepLooks, valueFromRatio } from '../model/channelRack'
import { renderPattern } from '../model/steps'
import { ProjectStore } from '../state/store'
import { BeatView } from '../ui/BeatView'
import type { AudioEngine } from '../audio/engine'

function render(store = new ProjectStore(), positionSamples = 0) {
  return renderToStaticMarkup(createElement(BeatView, {
    store,
    engine: { positionSamples } as AudioEngine,
  }))
}

function row(html: string, name: string) {
  const marker = `data-channel="${name}"`
  const start = html.indexOf(marker)
  expect(start, name).toBeGreaterThan(-1)
  const next = html.indexOf('data-channel="', start + marker.length)
  return html.slice(start, next === -1 ? html.length : next)
}

describe('channel rack', () => {
  it('renders one horizontal step row per channel', () => {
    const html = render()
    for (const name of ['Kick', 'Snare', 'Clap', 'Hat', 'Perc']) {
      const line = row(html, name)
      expect(line.match(/data-index="/g), name).toHaveLength(16)
      expect(line.match(/class="rack-group/g), name).toHaveLength(4)
      expect(line.match(/class="rack-group alt"/g), name).toHaveLength(2)
      expect(line).toContain('rack-mute')
      expect(line).toContain('Pan')
      expect(line).toContain('Vol')
      expect(line).toContain(`>${name}<`)
    }
    expect(html).toContain('Add channel')
    expect(html).toContain('>16<')
    expect(html).toContain('>32<')
    expect(html).toContain('>64<')
    expect(html).toContain('>Graph<')
    expect(html).toContain('>Paint<')
    expect(html).toContain('Kick loop length')
    expect(html).toContain('disabled=""')
    expect(html).toContain('Steps')
    expect(html).toContain('Swing')
    expect(html).toContain('rack-ruler')
    expect(html.match(/data-beat="1"/g)).toHaveLength(1)
    expect(html.match(/data-beat="4"/g)).toHaveLength(1)
    expect(html).toContain('data-tool="paint"')
    expect(html).toContain('Kick Swing. Swing for this row. Empty uses the pattern swing.')
    expect(html).toContain('>Row swing<')
  })

  it('toggles a step and lights it on the kick row', () => {
    const store = new ProjectStore()
    const kick = store.activePattern()!.channels[0]
    expect(kick.cells[1].on).toBe(false)
    expect(row(render(store), 'Kick')).toContain('data-index="1" class="rack-step"')
    store.setStep(kick.id, 1, true)
    expect(store.activePattern()!.channels[0].cells[1].on).toBe(true)
    expect(row(render(store), 'Kick')).toContain('data-index="1" class="rack-step on"')
    store.setStep(kick.id, 0, false)
    expect(store.activePattern()!.channels[0].cells[0].on).toBe(false)
    expect(row(render(store), 'Kick')).toContain('data-index="0" class="rack-step now"')
  })

  it('changes the pattern length to 32 and 64 and keeps a shorter row loop', () => {
    const store = new ProjectStore()
    store.setChannel(store.activePattern()!.channels[1].id, { steps: 8 })
    store.setPatternLength(32)
    const at32 = store.activePattern()!
    expect(at32.steps).toBe(32)
    expect(at32.channels[0].steps).toBe(32)
    expect(at32.channels[1].steps).toBe(8)
    const wide = render(store)
    expect(wide).toContain('data-length="32"')
    expect(row(wide, 'Kick').match(/data-index="/g)).toHaveLength(32)
    expect(row(wide, 'Kick').match(/class="rack-group/g)).toHaveLength(8)
    store.setPatternLength(64)
    const at64 = store.activePattern()!
    expect(at64.steps).toBe(64)
    expect(at64.channels[0].steps).toBe(64)
    expect(at64.channels[2].steps).toBe(64)
    expect(at64.channels[1].steps).toBe(8)
    expect(row(render(store), 'Hat').match(/data-index="/g)).toHaveLength(64)
  })

  it('dims steps past a shorter loop and wraps that row\'s playhead', () => {
    const store = new ProjectStore()
    const snare = store.activePattern()!.channels[1]
    store.setChannel(snare.id, { steps: 4 })
    const line = row(render(store, 30000), 'Snare')
    expect(line).toContain('data-index="1" class="rack-step now"')
    expect(line).toContain('data-index="3" class="rack-step loop"')
    expect(line).toContain('data-index="4" class="rack-step on past"')
    expect(line).not.toContain('data-index="4" class="rack-step on now"')
    expect(stepLooks(3, 4, 16)).toEqual({ past: false, loop: true })
    expect(stepLooks(4, 4, 16).past).toBe(true)
    expect(stepLooks(15, 16, 16)).toEqual({ past: false, loop: false })
    expect(rackPlayIndex(1.25, 4, 0, true)).toBe(1)
    expect(rackPlayIndex(1.25, 4, 0, false)).toBe(-1)
  })

  it('fills only the selected channel', () => {
    const store = new ProjectStore()
    const [kick, snare] = store.activePattern()!.channels
    const snareHits = snare.cells.filter((cell) => cell.on).length
    store.fillChannel(2, kick.id)
    const next = store.activePattern()!.channels
    expect(next[0].cells.filter((cell, index) => index < 16 && cell.on)).toHaveLength(8)
    expect(next[1].cells.filter((cell) => cell.on)).toHaveLength(snareHits)
  })

  it('highlights the step under the playhead', () => {
    const html = row(render(new ProjectStore(), 24000), 'Kick')
    expect(html).toContain('data-index="4" class="rack-step on now"')
  })

  it('maps graph bars and adds a kit channel through the store', () => {
    expect(graphRatio('velocity', { velocity: 0.05, pan: 0, pitch: 0, gate: 0.8 })).toBe(0)
    expect(graphRatio('velocity', { velocity: 1, pan: 0, pitch: 0, gate: 0.8 })).toBeCloseTo(1)
    expect(graphRatio('pitch', { velocity: 0.8, pan: 0, pitch: 0, gate: 0.8 })).toBeCloseTo(0.5)
    expect(graphRatio('pan', { velocity: 0.8, pan: 0, pitch: 0, gate: 0.8 })).toBeCloseTo(0.5)
    expect(graphRatio('pan', { velocity: 0.8, pan: -1, pitch: 0, gate: 0.8 })).toBe(0)
    expect(graphRatio('gate', { velocity: 0.8, pan: 0, pitch: 0, gate: 0.05 })).toBe(0)
    expect(valueFromRatio('pitch', 0).pitch).toBe(-12)
    expect(valueFromRatio('pitch', 1).pitch).toBe(12)
    expect(valueFromRatio('pan', 0.5).pan).toBe(0)
    expect(valueFromRatio('pan', 1).pan).toBe(1)
    expect(valueFromRatio('gate', 1).gate).toBeCloseTo(1)
    expect(valueFromRatio('velocity', 0).velocity).toBeCloseTo(0.05)
    const store = new ProjectStore()
    const before = store.activePattern()!.channels.length
    const id = store.addPatternChannel({ name: 'Rim', kind: 'perc', note: 37, color: '#73c48f' })
    expect(store.activePattern()!.channels).toHaveLength(before + 1)
    expect(id).toBe(store.activePattern()!.channels.at(-1)!.id)
    expect(store.activePattern()!.channels.at(-1)!.steps).toBe(16)
    expect(row(render(store), 'Rim').match(/data-index="/g)).toHaveLength(16)
  })

  it('keeps open hats, toms, and cymbals as their own voices', () => {
    const kit = kitChoices()
    expect(kit.find((choice) => choice.name === 'Open')?.kind).toBe('openhat')
    expect(kit.find((choice) => choice.name === 'Tom')?.kind).toBe('tom')
    expect(kit.find((choice) => choice.name === 'Crash')?.kind).toBe('cymbal')
    expect(kit.find((choice) => choice.name === 'Kick')?.kind).toBe('kick')
    const store = new ProjectStore()
    const added = store.addPatternChannel(kit.find((choice) => choice.name === 'Open')!)
    const channel = store.activePattern()!.channels.find((row) => row.id === added)!
    store.setStep(channel.id, 0, true)
    const hit = renderPattern(store.activePattern()!, 0, 1).find((item) => item.channelId === channel.id)
    expect(hit?.kind).toBe('openhat')
    expect(hit?.pitch).toBe(46)
  })

  it('loops an empty arrangement on the shared transport and confirms a place', () => {
    const store = new ProjectStore()
    const loop = emptyPatternLoopSamples(store.project)
    expect(loop).toBeGreaterThan(48000)
    store.placePattern(4)
    expect(emptyPatternLoopSamples(store.project)).toBe(0)
    expect(store.toasts.some((toast) => toast.text.startsWith('Pattern 1 is on '))).toBe(true)
    expect(shortSoundName('long_library_name_here.wav').endsWith('…')).toBe(true)
    const kick = store.activePattern()!.channels[0].id
    store.openChannelRoll(kick)
    expect(store.selectedMidiClipId).toBeTruthy()
    store.setView('arrange')
    expect(store.view).toBe('arrange')
    expect(store.selectedMidiClipId).toBeNull()
  })

  it('moves the playhead with the tempo map', () => {
    const store = new ProjectStore()
    store.project.tempoMap = [{ beat: 0, bpm: 60 }]
    const line = row(render(store, 24000), 'Kick')
    expect(line).toContain('data-index="2" class="rack-step now"')
    expect(line).not.toContain('data-index="4" class="rack-step on now"')
  })
})

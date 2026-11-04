import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { createPlugin, normalizeProject } from '../audio/plugins/catalog'
import { chainSections, needsScalerSound } from '../instruments/scaler/chain'
import { playScalerLive } from '../instruments/scaler/live'
import { loadPerformanceLibrary, packCatalog, styleCatalog } from '../instruments/scaler/perform'
import { notesAfterScaler, planLive, recordedPitches, stepNotes } from '../instruments/scaler/route'
import { renderStyled, freshSeed, rememberTake } from '../instruments/scaler/vary'
import { prepareClipNotes } from '../model/midiTools'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { getScale, loadScaleCatalog, toneInScale } from '../theory'
import { InsertList } from '../ui/PluginSheet'
import { ScalerPanel } from '../ui/ScalerPanel'

const engine = {
  unlock() {},
  stopPreview() {},
  auditionScaler() {},
  currentTimelineSample() { return 0 },
  status: 'stopped',
  sampleRate: 48000,
} as unknown as AudioEngine

const chord = [
  { midi: 60, cents: 0 },
  { midi: 64, cents: 0 },
  { midi: 67, cents: 0 },
]

describe('scaler performances and scales', () => {
  it('loads cultural scales with their intervals', async () => {
    await loadScaleCatalog()
    expect(getScale('chinese-gong').cents).toEqual([0, 200, 400, 700, 900])
    expect(getScale('chinese-shang').cents).toEqual([0, 200, 500, 700, 1000])
    expect(getScale('chinese-jue').cents).toEqual([0, 300, 500, 800, 1000])
    expect(getScale('japanese-in').cents).toEqual([0, 100, 500, 700, 800])
    expect(getScale('kumoi').cents).toEqual([0, 200, 300, 700, 900])
    expect(getScale('klezmer-freygish').cents).toEqual([0, 100, 400, 500, 700, 800, 1000])
    expect(getScale('klezmer-misheberakh').cents).toEqual([0, 200, 300, 600, 700, 800, 1000])
    expect(getScale('ethiopian-tizita').cents).toEqual([0, 200, 400, 700, 900])
    expect(getScale('ethiopian-bati').cents).toEqual([0, 200, 400, 700, 1100])
    expect(getScale('west-african').cents).toEqual([0, 200, 400, 700, 900])
    expect(getScale('spanish-gypsy').cents).toEqual([0, 100, 400, 500, 700, 800, 1000])
    expect(getScale('flamenco').cents).toEqual([0, 100, 400, 500, 700, 800, 1000])
    expect(getScale('byzantine').cents).toEqual([0, 100, 400, 500, 700, 800, 1100])
    expect(getScale('pelog-selisir').cents).toEqual([0, 120, 270, 540, 690])
    expect(getScale('maqam-hijaz').description).toMatch(/12-tone/)
    expect(getScale('maqam-rast').description).toMatch(/quarter tone/)
    expect(getScale('maqam-bayati').description).toMatch(/quarter tone/)
    expect(getScale('maqam-saba').description).toMatch(/quarter tone/)
  })

  it('loads every pack and keeps each performance inside its density and key', async () => {
    await loadPerformanceLibrary()
    const styles = styleCatalog()
    const packs = packCatalog()
    expect(styles.length).toBeGreaterThanOrEqual(40)
    expect(packs.length).toBeGreaterThanOrEqual(20)
    const ids = new Set(styles.map((style) => style.id))
    for (const pack of packs) {
      expect(ids.has(pack.performanceId)).toBe(true)
      expect(pack.changes.length).toBeGreaterThan(0)
    }
    for (const style of styles) {
      const context = { seed: 11, amount: 'subtle' as const, root: 0, scaleId: 'ionian', pass: 0, evolve: 'off' as const }
      const once = renderStyled(style, chord, 4, style.rate, 0, context)
      const twice = renderStyled(style, chord, 4, style.rate, 0, context)
      expect(once).toEqual(twice)
      expect(once.length).toBeGreaterThanOrEqual(Math.max(1, Math.round(style.density[0])))
      expect(once.length).toBeLessThanOrEqual(Math.max(1, Math.round(style.density[1])))
      for (const note of once) expect(toneInScale(note.pitch, note.fine ?? 0, 0, 'ionian', 20)).toBe(true)
      const major = renderStyled(style, chord, 4, style.rate, 0, { ...context, amount: 'major', seed: 11 })
      expect(major.length).toBeGreaterThan(0)
      expect(major.length).toBeLessThanOrEqual(Math.max(1, Math.round(style.density[1])))
      for (const note of major) expect(toneInScale(note.pitch, note.fine ?? 0, 0, 'ionian', 20)).toBe(true)
    }
    const sample = styles.find((style) => style.id === 'style-arp-up')!
    const low = renderStyled(sample, chord, 4, sample.rate, 0, { seed: 3, amount: 'medium', root: 0, scaleId: 'ionian', pass: 0, evolve: 'off' })
    const high = renderStyled(sample, chord, 4, sample.rate, 0, { seed: 90, amount: 'medium', root: 0, scaleId: 'ionian', pass: 0, evolve: 'off' })
    expect(low).not.toEqual(high)
    const remembered = rememberTake([2, 4, 6], 1, 8)
    expect(remembered.takes).toEqual([2, 4, 8])
    expect(remembered.index).toBe(2)
    expect(freshSeed(1)).toBeGreaterThan(0)
  })
})

describe('scaler midi router', () => {
  it('drives a synth under Scaler from a piano key', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'synth')
    store.setTrackInstrument(id, 'scaler')
    store.addScalerSound(id, 'synth')
    const track = store.track(id)!
    expect(track.instrument).toBe('synth')
    expect(track.plugins.map((plugin) => plugin.pluginId).slice(0, 2)).toEqual(['scaler', 'synth'])
    store.setScaler(id, { keysLock: 'one-finger', output: 'audio', recordSource: 'output' })
    expect(store.track(id)?.instrument).toBe('synth')
    const plan = planLive(store.project, id, 60, 0.8)
    expect(plan?.play.length).toBeGreaterThan(1)
    expect(plan?.play.every((note) => note.trackId === id)).toBe(true)
    expect(plan?.record).toEqual(plan?.play.map((note) => note.pitch))
    const sounded: string[] = []
    const live = playScalerLive(store.project, {
      playThrough(trackId, pitch, _velocity, _fine, shaped) {
        expect(shaped).toBe(true)
        sounded.push(`${trackId}:${pitch}`)
      },
    }, id, 60, 0.8)
    expect(live?.map((note) => note.midi)).toEqual(plan?.record)
    expect(sounded).toEqual(plan?.play.map((note) => `${note.trackId}:${note.pitch}`))
  })

  it('sends Scaler to another track and records input or output', async () => {
    await loadPerformanceLibrary()
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const other = store.addTracks({ kind: 'midi', count: 1, instrument: 'synth', input: 'mic', channels: 1, armed: false })[0]!
    store.setScaler(id, { keysLock: 'one-finger', output: 'audio', midiTo: [other], recordSource: 'input' })
    const input = planLive(store.project, id, 62, 0.9)
    expect(input?.record).toEqual([62])
    expect(input?.play.some((note) => note.trackId === id)).toBe(true)
    expect(input?.play.some((note) => note.trackId === other)).toBe(true)
    expect(recordedPitches('input', 62, [60, 64, 67])).toEqual([62])
    store.setScaler(id, { recordSource: 'output' })
    const output = planLive(store.project, id, 62, 0.9)
    const local = output?.play.filter((note) => note.trackId === id).map((note) => note.pitch) ?? []
    expect(output?.record).toEqual(local)
    expect(local.length).toBeGreaterThan(1)
    store.writeScalerClip(id, [{ pitch: 60, startBeat: 0, durationBeats: 4, velocity: 0.8 }], 0, 'C')
    const owner = store.track(id)!
    const clip = owner.midiClips[0]
    store.setScaler(id, { recordSource: 'input', performanceId: 'style-arp-up', keysLock: 'off' })
    const shaped = prepareClipNotes(store.project, store.track(id)!, clip)
    expect(shaped.length).toBeGreaterThan(1)
    store.setScaler(id, { recordSource: 'output' })
    const printed = prepareClipNotes(store.project, store.track(id)!, clip)
    expect(printed.map((note) => note.pitch)).toEqual([60])
    const steps = stepNotes(store.project, store.track(id)!, 60, 0.8, 1, 0)
    expect(steps?.length).toBeGreaterThan(0)
    expect(steps?.every((note) => note.trackId === id || note.trackId === other)).toBe(true)
    expect(notesAfterScaler(store.project, store.track(id)!, clip.notes).map((note) => note.pitch)).toEqual([60])
  })

  it('migrates an old Scaler-only project and shows the sound under the effect', () => {
    const project = createEmptyProject()
    const track = project.tracks.find((item) => item.type === 'midi')!
    track.instrument = 'scaler'
    track.scaler = { root: 5, scale: 'dorian' } as typeof track.scaler
    track.plugins = []
    normalizeProject(project)
    expect(track.instrument).toBe('scaler')
    expect(track.plugins[0]?.pluginId).toBe('scaler')
    expect(track.scaler?.root).toBe(5)
    expect(track.scaler?.scale).toBe('dorian')
    expect(needsScalerSound(track)).toBe(true)
    expect(chainSections(track).addInstrument).toBe(true)
    expect(chainSections(track).caption).toBe('Scaler sound')

    const withSynth = createEmptyProject()
    const keys = withSynth.tracks.find((item) => item.type === 'midi')!
    keys.instrument = 'scaler'
    keys.plugins = [createPlugin('eq'), createPlugin('synth')]
    normalizeProject(withSynth)
    expect(keys.plugins.map((plugin) => plugin.pluginId)).toEqual(['eq', 'scaler', 'synth'])
    expect(keys.instrument).toBe('synth')
    expect(needsScalerSound(keys)).toBe(false)

    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((item) => item.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    const html = renderToStaticMarkup(createElement(InsertList, { store, trackId: id }))
    expect(html).toContain('>MIDI<')
    expect(html).toContain('>Sound<')
    expect(html).toContain('Scaler sound')
    expect(html).toContain('Add instrument')
    expect(html).toContain('>Synth<')
    const panel = renderToStaticMarkup(createElement(ScalerPanel, { store, engine, trackId: id }))
    expect(panel).toContain('>Performances<')
    expect(panel).toContain('>Subtle<')
    expect(panel).toContain('>Medium<')
    expect(panel).toContain('>Major<')
    expect(panel).toContain('>Regenerate<')
    expect(panel).toContain('>Lock seed<')
    expect(panel).toContain('>Previous take<')
    expect(panel).toContain('>Next take<')
    expect(panel).toContain('>Record input<')
    expect(panel).toContain('>Record output<')
    expect(panel).toContain('>MIDI to<')
    expect(panel).toContain('Search performances')
  })
})

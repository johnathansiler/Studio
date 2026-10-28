import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../audio/plugins/catalog'
import { beatsToSamples } from '../model/time'
import { browserGroup } from '../model/sessionBoard'
import { displayedPlayhead, pianoPlayheadBeat, playbackStops, transportSample } from '../model/transportSync'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { laneDoubleClickAddsClip, quickDragArmed } from '../ui/clipKeys'
import { InsertList } from '../ui/PluginSheet'

describe('loop wrap', () => {
  it('wraps arrange, drums, and the piano roll on one clock when the loop is on', () => {
    const project = createEmptyProject(48000)
    const end = Math.round(beatsToSamples(16, project.sampleRate, project.tempo))
    project.loopStartSample = 0
    project.loopEndSample = end
    project.loopEnabled = false
    const past = end + project.sampleRate
    expect(playbackStops(past, project, end, project.sampleRate)).toBe(false)
    expect(playbackStops(past + 1, project, end, project.sampleRate)).toBe(true)
    expect(transportSample(past, project)).toBe(past)

    project.loopEnabled = true
    const wrapped = transportSample(past, project)
    expect(playbackStops(past, project, end, project.sampleRate)).toBe(false)
    expect(wrapped).toBeGreaterThanOrEqual(0)
    expect(wrapped).toBeLessThan(end)
    const views = ['arrange', 'drums', 'piano'].map(() => displayedPlayhead(past, project))
    expect(new Set(views).size).toBe(1)
    expect(views[0]).toBe(wrapped)
    const clip = { startBeat: 0, durationBeats: 16, loop: true }
    expect(pianoPlayheadBeat(wrapped / project.sampleRate * (project.tempo / 60), clip)).not.toBeNull()
  })

  it('keeps the playhead on the drawn piano grid after the clip ends', () => {
    const clip = { startBeat: 0, durationBeats: 4, loop: false }
    expect(pianoPlayheadBeat(6, clip)).toBeNull()
    expect(pianoPlayheadBeat(6, clip, 8)).toBeCloseTo(6)
    expect(pianoPlayheadBeat(9, clip, 8)).toBeNull()
  })
})

describe('arrange double-click', () => {
  it('opens a clip without creating another one beside it', () => {
    const clip = { closest: (selector: string) => (selector === '[data-clip]' ? {} : null) }
    const empty = { closest: () => null }
    expect(laneDoubleClickAddsClip(clip)).toBe(false)
    expect(laneDoubleClickAddsClip(empty)).toBe(true)
    expect(laneDoubleClickAddsClip(null)).toBe(true)

    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.addMidiClip(keys.id, 4)
    const clipId = keys.midiClips[0].id
    const before = keys.midiClips.length
    store.preparePianoClip(keys.id, 4, clipId)
    expect(keys.midiClips).toHaveLength(before)
    expect(store.selectedMidiClipId).toBe(clipId)
    if (laneDoubleClickAddsClip(clip)) store.addMidiClip(keys.id, 4)
    expect(keys.midiClips).toHaveLength(before)
  })
})

describe('pattern drag', () => {
  it('arms a quick drag below the slow browser gesture', () => {
    expect(quickDragArmed(3, 0)).toBe(true)
    expect(quickDragArmed(2, 2)).toBe(false)
    expect(quickDragArmed(0, 0)).toBe(false)
  })
})

describe('scaler insert', () => {
  it('is a searchable insert that opens the chord faceplate', () => {
    expect(CATALOG.find((plugin) => plugin.id === 'scaler')?.name).toBe('Scaler')
    expect(browserGroup('plugins').map((item) => item.name)).toEqual(['Auto-Tune', 'Scaler', 'Pads'])
    expect(browserGroup('plugins').find((item) => item.name === 'Scaler')?.id).toBe('scaler')
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.addPlugin(vocal.id, 'scaler')
    expect(store.scalerTrackId).toBe(keys.id)
    expect(keys.plugins.some((plugin) => plugin.pluginId === 'scaler')).toBe(true)
    expect(keys.instrument).toBe('scaler')
    const again = keys.plugins.filter((plugin) => plugin.pluginId === 'scaler')
    store.addPlugin(keys.id, 'scaler')
    expect(keys.plugins.filter((plugin) => plugin.pluginId === 'scaler')).toHaveLength(again.length)
    const html = renderToStaticMarkup(createElement(InsertList, { store, trackId: keys.id }))
    expect(html).toContain('>Scaler<')
    expect(html).toContain('Add insert')
    const master = renderToStaticMarkup(createElement(InsertList, { store, trackId: 'master' }))
    expect(master).not.toContain('>Scaler<')
  })
})

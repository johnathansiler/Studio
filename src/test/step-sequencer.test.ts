import { describe, expect, it } from 'vitest'
import { createPlugin } from '../audio/plugins/catalog'
import { migrateProject } from '../model/schema'
import { adoptStepSequencers, beatsWereUsed, createStepsPlugin } from '../model/stepPlugin'
import { isFactoryPattern, normalizeBeats, starterPattern } from '../model/steps'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { studioViewTabs } from '../ui/chrome'

describe('step sequencer plugin', () => {
  it('is the only way the old Beats rack is heard, and a fresh project grows no extra track', () => {
    expect(studioViewTabs().map((item) => item.label)).toEqual(['Arrange', 'Mix'])
    const fresh = new ProjectStore(createEmptyProject(48000))
    expect(fresh.project.tracks.map((track) => track.name)).toEqual(['Vocal', 'Music', 'Keys'])
    expect(beatsWereUsed(fresh.project.beats, fresh.project.patternClips)).toBe(false)
    expect(isFactoryPattern(fresh.activePattern()!)).toBe(true)

    const edited = starterPattern()
    edited.channels[0].cells[1].on = true
    const saved = createEmptyProject(48000)
    saved.beats = { activeId: edited.id, patterns: [edited] }
    saved.patternClips = [{ id: 'clip', patternId: edited.id, startBeat: 8, lengthBeats: 4, scene: null, placed: true }]
    const opened = migrateProject(saved)
    const track = opened.tracks.find((item) => item.plugins.some((plugin) => plugin.pluginId === 'steps'))
    expect(track?.name).toBe('Step Sequencer 1')
    expect(track?.plugins[0].steps?.patterns[0].channels[0].cells[1].on).toBe(true)
    expect(opened.patternClips?.find((clip) => clip.id === 'clip')?.trackId).toBe(track?.id)
    expect(opened.patternClips?.find((clip) => clip.id === 'clip')?.startBeat).toBe(8)

    const again = migrateProject(JSON.parse(JSON.stringify(opened)))
    expect(again.tracks.filter((item) => item.name.startsWith('Step Sequencer'))).toHaveLength(1)
    expect(again.beats?.patterns[0].id).toBe(again.tracks.find((item) => item.name.startsWith('Step Sequencer'))?.plugins[0].steps?.patterns[0].id)
  })

  it('adds a sequencer to a track, keeps the steps, and leaves Beat Machine alone', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.addPlugin(keys.id, 'steps')
    expect(store.stepTrackId).toBe(keys.id)
    expect(store.keyboardMidi).toBe(false)
    const plugin = createPlugin('steps')
    expect(plugin.pluginId).toBe('steps')
    expect(plugin.steps?.patterns[0].channels.map((channel) => channel.name)).toEqual(['Kick', 'Snare', 'Clap', 'Hat', 'Perc'])
    store.setStep(store.activePattern()!.channels[0].id, 1, true)
    store.closeSteps()
    const kept = store.track(keys.id)!.plugins.find((item) => item.pluginId === 'steps')!
    expect(kept.steps?.patterns[0].channels[0].cells[1].on).toBe(true)

    const made = store.addQuickTrack('pads')
    expect(store.track(made!)?.instrument).toBe('pads')
    expect(store.padsTrackId).toBe(made)
    expect(store.stepTrackId).toBeNull()
    expect(createStepsPlugin().pluginId).toBe('steps')
    const project = createEmptyProject()
    adoptStepSequencers(project)
    expect(project.tracks).toHaveLength(3)
    const normalized = normalizeBeats(undefined, undefined)
    expect(isFactoryPattern(normalized.beats.patterns[0])).toBe(true)
  })

  it('keeps a deleted sequencer deleted, including the last one, after save and reload', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const first = store.addQuickTrack('steps')
    const second = store.addQuickTrack('steps')
    expect(first).toBeTruthy()
    expect(second).toBeTruthy()
    store.removeTrack(first!)
    expect(store.project.tracks.some((track) => track.id === first)).toBe(false)
    expect(store.project.tracks.some((track) => track.id === second)).toBe(true)
    store.removeTrack(second!)
    expect(store.project.stepsAdopted).toBe(true)
    expect(store.project.tracks.some((track) => track.plugins.some((plugin) => plugin.pluginId === 'steps'))).toBe(false)
    const reloaded = migrateProject(JSON.parse(JSON.stringify(store.project)))
    expect(reloaded.tracks.some((track) => track.plugins.some((plugin) => plugin.pluginId === 'steps'))).toBe(false)
    expect(reloaded.tracks.filter((track) => track.name.startsWith('Step Sequencer'))).toHaveLength(0)
  })

  it('adopts an old used beats rack once, then a delete stays gone', () => {
    const saved = createEmptyProject(48000)
    const edited = starterPattern()
    edited.channels[0].cells[1].on = true
    saved.beats = { activeId: edited.id, patterns: [edited] }
    saved.patternClips = [{ id: 'clip', patternId: edited.id, startBeat: 8, lengthBeats: 4, scene: null, placed: true }]
    const opened = migrateProject(saved)
    const track = opened.tracks.find((item) => item.plugins.some((plugin) => plugin.pluginId === 'steps'))
    expect(track?.name).toBe('Step Sequencer 1')
    expect(opened.stepsAdopted).toBe(true)
    const store = new ProjectStore(opened)
    store.removeTrack(track!.id)
    const again = migrateProject(JSON.parse(JSON.stringify(store.project)))
    expect(again.tracks.filter((item) => item.name.startsWith('Step Sequencer'))).toHaveLength(0)
    const third = migrateProject(JSON.parse(JSON.stringify(again)))
    expect(third.tracks.filter((item) => item.name.startsWith('Step Sequencer'))).toHaveLength(0)
  })
})

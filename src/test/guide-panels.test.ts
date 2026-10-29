import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { audioInput, tracksFor } from '../model/addTrack'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { AddTrackPanel } from '../ui/AddTrack'
import { deriveSongContext } from '../unstuck/context'
import { actionDetail, unstuckActions } from '../unstuck/menu'
import { suggest } from '../unstuck/suggest'
import { setActiveTool } from '../state/tools'
import { ToolBar } from '../ui/ToolBar'

describe('add track panel', () => {
  const base = { kind: 'audio' as const, count: 1, instrument: 'synth' as const, input: 'mic' as const, inputIndex: 1, channels: 1 as const, armed: false }

  it('shows only the options for the chosen type, with disarmed audio defaults', () => {
    const audio = renderToStaticMarkup(createElement(AddTrackPanel, { spec: base, place: 'sheet', onChange: () => undefined, onCancel: () => undefined, onCommit: () => undefined }))
    expect(audio).toContain('Add track')
    expect(audio).toContain('Record a voice or an instrument.')
    expect(audio).toContain('>Mic<')
    expect(audio).toContain('>Line<')
    expect(audio).toContain('>Mono<')
    expect(audio).toContain('>Stereo<')
    expect(audio).toContain('Input 1')
    expect(audio).toContain('Step 1')
    expect(audio).toContain('Arm after adding')
    expect(audio).toContain('Off. The new track stays quiet until you arm it.')
    expect(audio).not.toContain('Leave disarmed')
    expect(audio).toContain('Add Audio track')
    expect(audio).not.toContain('>Keys<')

    const midi = renderToStaticMarkup(createElement(AddTrackPanel, { spec: { ...base, kind: 'midi' }, place: 'pop', onChange: () => undefined, onCancel: () => undefined, onCommit: () => undefined }))
    expect(midi).toContain('>Keys<')
    expect(midi).toContain('Play from the on-screen keyboard')
    expect(midi).not.toContain('>Mic<')
    expect(midi).toContain('Add Instrument track')

    const drums = renderToStaticMarkup(createElement(AddTrackPanel, { spec: { ...base, kind: 'drum', instrument: 'drum-machine' }, place: 'sheet', onChange: () => undefined, onCancel: () => undefined, onCommit: () => undefined }))
    expect(drums).toContain('>Kit<')
    expect(drums).toContain('>808<')
    expect(drums).not.toContain('Input number')
    expect(drums).toContain('Add Drums track')

    const bus = renderToStaticMarkup(createElement(AddTrackPanel, { spec: { ...base, kind: 'bus' }, place: 'sheet', onChange: () => undefined, onCancel: () => undefined, onCommit: () => undefined }))
    expect(bus).toContain('Group tracks, or return an effect.')
    expect(bus).not.toContain('>Mic<')
    expect(bus).not.toContain('>Kit<')
    expect(bus).toContain('Add Bus track')
  })

  it('numbers the audio input and leaves other tracks disarmed', () => {
    const project = createEmptyProject()
    const made = tracksFor({ ...base, input: 'line', inputIndex: 2, channels: 2, armed: false }, project.tracks)
    expect(audioInput({ ...base, input: 'line', inputIndex: 2 })).toBe('line:1')
    expect(made[0].input).toBe('line:1')
    expect(made[0].armed).toBe(false)
    expect(made[0].channels).toBe(2)
    const kit = tracksFor({ ...base, kind: 'drum', instrument: '808' }, project.tracks)
    expect(kit[0].instrument).toBe('808')
    expect(kit[0].name).toBe('808 1')
  })
})

describe('unstuck menu', () => {
  it('groups plain actions and writes a new variation on the next tap', () => {
    const store = new ProjectStore(createEmptyProject())
    const context = deriveSongContext(store.project)
    const actions = unstuckActions(suggest(context), context)
    expect(actions.map((item) => item.group)).toContain('Start a song')
    const chords = actions.find((item) => item.key === 'chords')!
    expect(chords.title).toBe('Next chords')
    expect(chords.detail.length).toBeGreaterThan(20)
    expect(actionDetail(chords.items[0], context)).toBe(chords.detail)
    store.applyUnstuck(chords.items[0])
    const again = unstuckActions(suggest(deriveSongContext(store.project)), deriveSongContext(store.project), { chords: 1 })
    const second = again.find((item) => item.key === 'chords')!
    expect(second.items[1 % second.items.length].id).not.toBe(chords.items[0].id)
    store.applyUnstuck(second.items[1 % second.items.length])
    store.undo()
    expect(store.project.tracks.some((track) => track.midiClips.some((clip) => clip.notes.length > 0))).toBe(true)
    store.undo()
  })

  it('turns a one-idea card into a different variation on the next tap', () => {
    const store = new ProjectStore(createEmptyProject())
    const context = deriveSongContext(store.project)
    const fill = unstuckActions(suggest(context), context).find((item) => item.key === 'move-fill')!
    expect(fill.items.length).toBe(3)
    expect(fill.items[1].id).not.toBe(fill.items[0].id)
    const notes = (index: number) => JSON.stringify(fill.items[index].parts.map((part) => part.notes))
    expect(notes(1)).not.toBe(notes(0))
    store.applyUnstuck(fill.items[0])
    store.applyUnstuck(fill.items[1])
    store.undo()
    expect(store.project.tracks.some((track) => track.midiClips.some((clip) => clip.notes.length > 0))).toBe(true)
    store.undo()
    expect(store.project.tracks.every((track) => track.midiClips.every((clip) => clip.notes.length === 0))).toBe(true)
  })
})

describe('tool panel', () => {
  it('names each tool and groups pick, edit, and view', () => {
    setActiveTool('pencil')
    const html = renderToStaticMarkup(createElement(ToolBar, {
      panel: true,
      context: 'arrange',
      onChange: () => undefined,
      onDuplicate: () => undefined,
      onDelete: () => undefined,
    }))
    expect(html).toContain('Pick and move')
    expect(html).toContain('>Edit<')
    expect(html).toContain('>View<')
    expect(html).toContain('Draw: tap a lane to add a clip')
    expect(html).toContain('>Duplicate<')
    expect(html).toContain('>Delete<')
    expect(html).toContain('aria-pressed="true"')
  })
})

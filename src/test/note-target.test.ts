import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createPlugin } from '../audio/plugins/catalog'
import type { AudioEngine } from '../audio/engine'
import { editorForGesture } from '../model/editorOpen'
import { noteTarget, INSTRUMENT_HINT } from '../model/noteTarget'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'
import { KeyboardDock, playKeyboardNote } from '../ui/KeyboardDock'

const engine = {
  positionSamples: 0,
  status: 'stopped',
  subscribe: () => () => undefined,
  unlock() {},
  playThrough() {},
  releaseThrough() {},
  liveNoteOn() {},
  liveNoteOff() {},
  currentTimelineSample: () => 0,
  stopPreview() {},
  previewPcm() {},
} as unknown as AudioEngine

describe('selected track notes', () => {
  it('plays and can record the selected instrument, and nowhere else', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const heard: string[] = []
    const live = { ...engine, playThrough(id: string, pitch: number) { heard.push(`${id}:${pitch}`) } } as unknown as AudioEngine
    expect(noteTarget(store.project.tracks, keys.id)).toEqual({ kind: 'instrument', trackId: keys.id, armed: false })
    expect(playKeyboardNote(store, live, 60, 0.8)).toEqual([60])
    expect(heard).toEqual([`${keys.id}:60`])
    store.selectTrack(vocal.id)
    expect(playKeyboardNote(store, live, 60, 0.8)).toEqual([])
    expect(heard).toEqual([`${keys.id}:60`])
  })

  it('stays silent on a vocal track and shows an inline hint', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    store.selectTrack(vocal.id)
    store.setKeyboardMidi(true)
    expect(noteTarget(store.project.tracks, vocal.id).kind).toBe('silent')
    const html = renderToStaticMarkup(createElement(KeyboardDock, { store, engine }))
    expect(html).toContain(INSTRUMENT_HINT)
    expect(html).toContain('role="status"')
    expect(html).not.toContain('role="dialog"')
  })

  it('drives Auto-Tune hold notes on a vocal track', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    const plugin = createPlugin('tune')
    store.addPlugin(vocal.id, 'tune')
    const inserted = store.track(vocal.id)!.plugins.find((item) => item.pluginId === 'tune')!
    expect(inserted.pluginId).toBe('tune')
    store.selectTrack(vocal.id)
    expect(noteTarget(store.project.tracks, vocal.id)).toMatchObject({ kind: 'tune', trackId: vocal.id, pluginId: inserted.id })
    const heard: string[] = []
    const live = { ...engine, playThrough() { heard.push('played') } } as unknown as AudioEngine
    expect(playKeyboardNote(store, live, 69, 0.8)).toEqual([69])
    expect(store.track(vocal.id)!.plugins.find((item) => item.id === inserted.id)!.params.holdMidi).toBe(69)
    expect(heard).toEqual([])
    expect(plugin.pluginId).toBe('tune')
  })
})

describe('keyboard before the piano roll', () => {
  it('opens the dock from a track header, and the piano roll from a clip or Edit Notes', () => {
    expect(editorForGesture('select-track', 'midi')).toBe('keyboard')
    expect(editorForGesture('tap-clip', 'midi')).toBe('piano')
    expect(editorForGesture('select-track', 'midi', { instrument: 'synth' })).toBe('keyboard')
    expect(editorForGesture('select-track', 'midi', { instrument: 'pads' })).toBe('pads')
    expect(editorForGesture('tap-clip', 'midi', { instrument: 'drum-machine' })).toBe('piano')
    expect(editorForGesture('tap-clip', 'midi', { instrument: 'pads' })).toBe('piano')
    expect(editorForGesture('edit-notes', 'midi')).toBe('piano')
    expect(editorForGesture('select-track', 'audio')).toBe('none')
    expect(editorForGesture('tap-clip', 'audio')).toBe('none')
  })

  it('draws Edit Notes on the selected clip and does not draw the piano roll', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.addMidiClip(keys.id, 0)
    store.selectClip(keys.id, store.selectedMidiClipId!, true, false)
    const html = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine,
      session: { state: { participants: [], selfId: 'me' } },
      onSeek() {},
      onOpenPiano() {},
      onOpenKeyboard() {},
      onPerform() {},
      onQuickPunch() {},
      onAnalyze() {},
    } as never))
    expect(html).toContain('>Edit Notes<')
    expect(html).not.toContain('class="piano"')
    expect(html).not.toContain('data-editor="piano"')
  })
})

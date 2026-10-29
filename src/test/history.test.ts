import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { HISTORY_LIMIT, historyCommand, typingTarget } from '../state/history'
import { ProjectStore } from '../state/store'
import { HistoryButtons } from '../ui/HistoryButtons'

describe('edit history', () => {
  it('undoes and redoes a project edit, and leaves selection and view alone', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.setView('mix')
    store.selectTrack(track.id)
    store.setTool('pencil')
    expect(store.canUndo).toBe(false)
    expect(store.canRedo).toBe(false)
    store.setTempo(99)
    expect(store.canUndo).toBe(true)
    expect(store.view).toBe('mix')
    store.undo()
    expect(store.project.tempo).toBe(120)
    expect(store.view).toBe('mix')
    expect(store.selectedTrackId).toBe(track.id)
    expect(store.tool).toBe('pencil')
    expect(store.toasts.at(-1)?.text).toBe('Undid: Tempo')
    expect(store.canRedo).toBe(true)
    store.redo()
    expect(store.project.tempo).toBe(99)
    expect(store.toasts.at(-1)?.text).toBe('Redid: Tempo')
  })

  it('collapses a fader drag and a tempo gesture into one step', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    const original = track.volume
    store.draft(() => { track.volume = 0.2 })
    store.draft(() => { track.volume = 0.55 })
    store.draft(() => { track.volume = 0.4 })
    store.endDraft()
    expect(store.project.tracks[0].volume).toBe(0.4)
    store.undo()
    expect(store.project.tracks[0].volume).toBeCloseTo(original)
    store.redo()
    expect(store.project.tracks[0].volume).toBe(0.4)

    store.setTempo(100, true)
    store.setTempo(110, true)
    store.setTempo(119.6, true)
    store.undo()
    expect(store.project.tempo).toBe(120)
    expect(store.canUndo).toBe(true)
  })

  it('names a clip move and caps the journal', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.drawRegion(track.id, 100, 48000)
    const clip = store.project.tracks.find((item) => item.id === track.id)!.clips[0]
    store.moveClip(track.id, clip.id, 24000)
    expect(store.project.tracks.find((item) => item.id === track.id)!.clips[0].startSample).toBe(24000)
    store.undo()
    expect(store.toasts.at(-1)?.text).toBe('Undid: Move clip')
    expect(store.project.tracks.find((item) => item.id === track.id)!.clips[0].startSample).not.toBe(24000)

    const bulky = store.project.tracks.find((item) => item.type === 'midi')!
    store.preparePianoClip(bulky.id, 0)
    const midi = store.project.tracks.find((item) => item.id === bulky.id)!.midiClips[0]
    for (let i = 0; i < 180; i++) midi.notes.push({ id: `n${i}`, pitch: 60, startBeat: i * 0.25, durationBeats: 0.2, velocity: 0.8 })
    const full = JSON.stringify(store.project).length
    for (let i = 1; i <= HISTORY_LIMIT + 15; i++) store.setMasterVolume(Math.min(1.25, 0.05 + i * 0.001))
    expect(store.historyBytes()).toBeLessThan(full)
    let steps = 0
    while (store.canUndo) {
      store.undo()
      steps += 1
      expect(steps).toBeLessThanOrEqual(HISTORY_LIMIT)
    }
    expect(steps).toBe(HISTORY_LIMIT)
  }, 20000)

  it('keeps a remote field when the same control is undone', () => {
    const store = new ProjectStore(createEmptyProject())
    store.setTempo(90)
    store.applyRemoteOps([{ a: 'zzzz-remote', s: 1, l: 999999, p: 'tempo', v: 140 }])
    expect(store.project.tempo).toBe(140)
    store.undo()
    expect(store.project.tempo).toBe(140)
    expect(store.toasts.at(-1)?.text.startsWith('Undid:')).toBe(true)
  })

  it('resyncs the engine in place without replacing the project', () => {
    const store = new ProjectStore(createEmptyProject())
    const engine = new AudioEngine()
    const identity = store.project
    store.project.waveforms = { keep: [{ min: 0, max: 1 }] }
    engine.sync(store.project, () => undefined)
    const stop = store.subscribe(() => engine.sync(store.project, () => undefined))
    store.setTempo(88)
    expect(engine.tempo).toBe(88)
    store.undo()
    expect(engine.tempo).toBe(120)
    expect(store.project).toBe(identity)
    expect(store.project.waveforms?.keep).toEqual([{ min: 0, max: 1 }])
    stop()
  })
})

describe('history controls', () => {
  it('renders undo and redo, and ignores shortcuts while typing', () => {
    const idle = renderToStaticMarkup(createElement(HistoryButtons, {
      canUndo: false,
      canRedo: false,
      onUndo: () => undefined,
      onRedo: () => undefined,
    }))
    expect(idle).toContain('title="Undo"')
    expect(idle).toContain('title="Redo"')
    expect(idle).toContain('↶')
    expect(idle).toContain('↷')
    expect(idle).toContain('Undo')
    expect(idle).toContain('Redo')
    expect(idle.match(/disabled=""/g)?.length).toBe(2)

    const live = renderToStaticMarkup(createElement(HistoryButtons, {
      canUndo: true,
      canRedo: false,
      onUndo: () => undefined,
      onRedo: () => undefined,
    }))
    expect(live.match(/disabled=""/g)?.length ?? 0).toBe(1)

    expect(historyCommand({ key: 'z', metaKey: true }, false)).toBe('undo')
    expect(historyCommand({ key: 'z', ctrlKey: true }, false)).toBe('undo')
    expect(historyCommand({ key: 'z', metaKey: true, shiftKey: true }, false)).toBe('redo')
    expect(historyCommand({ key: 'z', ctrlKey: true, shiftKey: true }, false)).toBe('redo')
    expect(historyCommand({ key: 'y', ctrlKey: true }, false)).toBe('redo')
    expect(historyCommand({ key: 'y', metaKey: true }, false)).toBeNull()
    expect(historyCommand({ key: 'Z', ctrlKey: true }, false)).toBe('undo')
    expect(historyCommand({ key: 'z', metaKey: true }, true)).toBeNull()
    expect(historyCommand({ key: 'y', ctrlKey: true }, true)).toBeNull()
    expect(typingTarget({ tagName: 'INPUT' })).toBe(true)
    expect(typingTarget({ tagName: 'TEXTAREA' })).toBe(true)
    expect(typingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(typingTarget({ tagName: 'BUTTON' })).toBe(false)
    expect(typingTarget(null)).toBe(false)
  })
})

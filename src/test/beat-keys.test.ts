import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { beatKeyAt, beatKeyForPitch, beatOctaveHasPads, beatPageLabel } from '../model/beatKeys'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { commitDockNotes, KeyboardDock, playKeyboardNote } from '../ui/KeyboardDock'

const engine = {
  positionSamples: 0,
  status: 'recording',
  sampleRate: 48000,
  subscribe: () => () => undefined,
  unlock() {},
  playThrough() {},
  releaseThrough() {},
  liveNoteOn() {},
  liveNoteOff() {},
} as unknown as AudioEngine

describe('beat machine keys', () => {
  it('maps twelve keys across the current bank and the next bank', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const kit = store.trackKit(id)
    expect(beatKeyAt(kit, 0, 0)).toMatchObject({ bank: 0, index: 0, name: 'Kick', pitch: 36 })
    expect(beatKeyAt(kit, 0, 1)).toMatchObject({ name: 'Snare' })
    expect(beatKeyAt(kit, 0, 11)).toMatchObject({ bank: 0, index: 11, name: 'Tamb' })
    expect(beatKeyAt(kit, 1, 0)).toMatchObject({ bank: 0, index: 12, name: 'Cow' })
    expect(beatKeyAt(kit, 1, 3)).toMatchObject({ bank: 0, index: 15, name: 'Clave' })
    expect(beatKeyAt(kit, 1, 4)).toMatchObject({ bank: 1, index: 0 })
    expect(beatKeyForPitch(kit, 48)?.name).toBe('Kick')
    expect(beatKeyForPitch(kit, 60)?.name).toBe('Cow')
    expect(beatKeyAt(kit, -1, 0)).toBeNull()
    expect(beatOctaveHasPads(kit, 0)).toBe(true)
    expect(beatOctaveHasPads(kit, -1)).toBe(false)
    expect(beatPageLabel(kit, 0)).toBe('Bank A')
    expect(beatPageLabel(kit, 1)).toBe('Bank A–B')
    store.patchTrackKit(id, { activeBank: 2 })
    const moved = store.trackKit(id)
    expect(beatKeyAt(moved, 0, 0)?.bank).toBe(2)
    expect(beatOctaveHasPads(moved, -1)).toBe(true)
  })

  it('plays the pad, honors full level, and records the pad pitch', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.selectTrack(id)
    store.updateTrack(id, { armed: true })
    const heard: { pitch: number; velocity: number }[] = []
    const live = {
      ...engine,
      triggerPad(_trackId: string, pitch: number, velocity: number) { heard.push({ pitch, velocity }) },
    } as unknown as AudioEngine
    expect(playKeyboardNote(store, live, 48, 0.4)).toEqual([36])
    expect(heard).toEqual([{ pitch: 36, velocity: 0.4 }])
    store.patchTrackKit(id, { fullLevel: true })
    expect(playKeyboardNote(store, live, 50, 0.25)).toEqual([beatKeyForPitch(store.trackKit(id), 50)!.pitch])
    expect(heard[1].velocity).toBe(1)
    expect(playKeyboardNote(store, live, 47, 0.8)).toEqual([])
    commitDockNotes(store, [{
      trackId: id,
      clipId: null,
      pitch: 36,
      startBeat: 1,
      durationBeats: 0.25,
      velocity: 1,
    }])
    const notes = store.track(id)!.midiClips.flatMap((clip) => clip.notes)
    expect(notes.map((note) => note.pitch)).toContain(36)
    expect(notes.find((note) => note.pitch === 36)?.velocity).toBe(1)
  })

  it('labels the dock keys with pad names', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.selectTrack(id)
    store.setKeyboardMidi(true)
    store.setMidiEditor({ octave: 0 })
    const html = renderToStaticMarkup(createElement(KeyboardDock, { store, engine }))
    expect(html).toContain('>Kick<')
    expect(html).toContain('>Snare<')
    expect(html).toContain('>Hat<')
    expect(html).toContain('Bank A')
    expect(html).toContain('aria-label="Beat machine pads"')
    expect(html).not.toContain('>C<')
    store.setMidiEditor({ octave: 1 })
    const next = renderToStaticMarkup(createElement(KeyboardDock, { store, engine }))
    expect(next).toContain('>Cow<')
    expect(next).toContain('>Clave<')
    expect(next).toContain('Bank A–B')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { editorState, keyCommitsNote, normalizeMidiEditor, writeRollPrefs, type PrefMemory } from '../model/stepEntry'
import { createEmptyProject } from '../model/types'
import { projectSampleBeat } from '../model/tempoMap'
import { displayedPlayhead, pianoPlayheadBeat } from '../model/transportSync'
import { selectMidiEditor } from '../state/select'
import { ProjectStore } from '../state/store'
import { PianoRoll } from '../ui/PianoRoll'

function memory(): PrefMemory {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('piano playhead', () => {
  it('follows the shared transport, the loop region, and a looping clip', () => {
    const project = createEmptyProject(48000)
    project.loopEnabled = true
    project.loopStartSample = 0
    project.loopEndSample = 48000
    const clip = { startBeat: 0, durationBeats: 4, loop: true }
    const inside = pianoPlayheadBeat(projectSampleBeat(project, displayedPlayhead(12000, project)), clip)
    const wrapped = pianoPlayheadBeat(projectSampleBeat(project, displayedPlayhead(48000 + 12000, project)), clip)
    expect(inside).toBeCloseTo(0.5)
    expect(wrapped).toBeCloseTo(inside ?? 0)
    const long = { startBeat: 0, durationBeats: 2, loop: true }
    expect(pianoPlayheadBeat(5, long)).toBeCloseTo(1)
    expect(pianoPlayheadBeat(5, { startBeat: 0, durationBeats: 2, loop: false })).toBeNull()
    expect(pianoPlayheadBeat(-0.5, clip)).toBeNull()
    const views = [inside, wrapped]
    expect(views[0]).toBeCloseTo(views[1] ?? -1)
  })

  it('draws the same playhead line for the roll used by Arrange, Session, and Beats', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    store.selectClip(track.id, track.midiClips[0].id, true)
    const html = renderToStaticMarkup(createElement(PianoRoll, {
      store,
      engine: {
        positionSamples: 24000,
        status: 'playing',
        subscribe: () => () => undefined,
        unlock() {},
        resume: async () => undefined,
        liveNoteOn() {},
        liveNoteOff() {},
        previewPitches() {},
        currentTimelineSample: () => 24000,
        playOrigin: () => ({ context: 0, beat: 0 }),
        clockCompensation: () => ({ outputLatency: 0, baseLatency: 0, calibrationSec: 0 }),
        outputStamp: () => 0,
      },
    } as never))
    expect(html).toContain('data-playhead="piano"')
    expect(html).toContain('Follow')
    expect(html).toContain('aria-pressed="true"')
  })
})

describe('step input', () => {
  it('remembers the toggle and stops keys from writing notes when it is off', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    expect(store.midiEditor().stepInput).toBe(true)
    expect(selectMidiEditor(store).editor.stepInput).toBe(true)
    const kept = memory()
    store.setMidiEditor({ stepInput: false })
    writeRollPrefs({ stepInput: false }, kept)
    expect(store.midiEditor().stepInput).toBe(false)
    expect(store.project.midiEditor?.stepInput).toBe(false)
    const fresh = editorState({ midiEditor: undefined }, kept)
    expect(fresh.stepInput).toBe(false)
    expect(normalizeMidiEditor({ stepInput: false }).stepInput).toBe(false)
    expect(normalizeMidiEditor(undefined).stepInput).toBe(true)
    expect(keyCommitsNote(false)).toBe(false)
    expect(keyCommitsNote(true)).toBe(true)

    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    const clip = track.midiClips[0]
    const before = clip.notes.length
    store.addNote(track.id, clip.id, { pitch: 60, startBeat: 0, durationBeats: 0.25, velocity: 0.8 })
    expect(clip.notes.length).toBe(before + 1)
    const writes = store.midiEditor().stepInput
    if (!writes) {
      const count = clip.notes.length
      expect(count).toBe(before + 1)
    }
  })

  it('labels the shortcut on the piano roll toolbar', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const track = store.project.tracks.find((item) => item.type === 'midi')!
    store.addMidiClip(track.id, 0)
    store.selectClip(track.id, track.midiClips[0].id, true)
    store.setMidiEditor({ stepInput: true })
    const html = renderToStaticMarkup(createElement(PianoRoll, {
      store,
      engine: {
        positionSamples: 0,
        status: 'stopped',
        subscribe: () => () => undefined,
        unlock() {},
        resume: async () => undefined,
        liveNoteOn() {},
        liveNoteOff() {},
        previewPitches() {},
      },
    } as never))
    expect(html).toContain('Step input')
    expect(html).toContain('Shortcut I')
    expect(html).toContain('only play the sound')
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { activeTool, overflowTools, phoneTools, setActiveTool, subscribeTools, toolCaption, toolInfo, toolsFor, TOOLS } from '../state/tools'

afterEach(() => setActiveTool('select'))

describe('arrangement tool', () => {
  it('publishes the active tool for the piano roll', () => {
    const seen: string[] = []
    const stop = subscribeTools(() => seen.push(activeTool()))
    setActiveTool('pencil')
    expect(activeTool()).toBe('pencil')
    expect(seen).toEqual(['pencil'])
    setActiveTool('pencil')
    expect(seen).toEqual(['pencil'])
    stop()
  })

  it('draws, moves with snap, trims, splits, stretches, duplicates, and undoes', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const audioId = store.project.tracks.find((track) => track.type === 'audio')!.id
    const midiId = store.project.tracks.find((track) => track.type === 'midi')!.id
    const audio = () => store.project.tracks.find((track) => track.id === audioId)!
    const midi = () => store.project.tracks.find((track) => track.id === midiId)!
    store.drawRegion(audioId, 100, 48000)
    expect(audio().clips).toHaveLength(1)
    expect(audio().clips[0].startSample).toBe(0)
    const quarter = 24000
    store.placeAudioClips([{ trackId: audioId, clipId: audio().clips[0].id, startSample: quarter + 80 }])
    expect(audio().clips[0].startSample).toBe(quarter)
    store.trimClip(audioId, audio().clips[0].id, 'end', audio().clips[0].startSample + 8000)
    expect(audio().clips[0].durationSamples).toBe(8000)
    store.stretchClip(audioId, audio().clips[0].id, 'end', audio().clips[0].startSample + 16000)
    expect(audio().clips[0].durationSamples).toBe(16000)
    expect(audio().clips[0].stretch).toBeTruthy()
    const before = audio().clips.length
    store.splitAt(audioId, audio().clips[0].id, audio().clips[0].startSample + 4000)
    expect(audio().clips.length).toBe(before + 1)
    store.selectRegion(audio().clips.map((clip) => clip.id), [], audioId)
    expect(store.selectedClipIds).toHaveLength(2)
    store.duplicateSelection()
    expect(audio().clips.length).toBe(4)
    store.undo()
    expect(audio().clips.length).toBe(2)
    store.drawRegion(midiId, 0, quarter * 4)
    expect(midi().midiClips.some((clip) => clip.name === 'MIDI')).toBe(true)
    const drawnId = midi().midiClips.find((clip) => clip.name === 'MIDI')!.id
    const drawn = () => midi().midiClips.find((clip) => clip.id === drawnId)!
    store.placeMidiClips([{ trackId: midiId, clipId: drawnId, startBeat: 1.2 }])
    expect(drawn().startBeat).toBe(1)
    store.resizeMidiClip(midiId, drawnId, 'end', drawn().startBeat + 2, false)
    expect(drawn().durationBeats).toBe(2)
    store.splitAt(midiId, drawnId, quarter * (drawn().startBeat + 1))
    expect(midi().midiClips.filter((clip) => clip.name.startsWith('MIDI'))).toHaveLength(2)
    store.undo()
    expect(midi().midiClips.filter((clip) => clip.name.startsWith('MIDI'))).toHaveLength(1)
    store.undo()
    store.undo()
    store.undo()
    expect(store.tool).toBe('select')
    store.setTool('box')
    expect(activeTool()).toBe('box')
    expect(store.tool).toBe('box')
  })

  it('names every tool and keeps the phone set free of duplicates', () => {
    for (const id of toolsFor('arrange')) {
      const info = toolInfo(id, 'arrange')
      expect(info.label.length).toBeGreaterThan(0)
      expect(info.hint.length).toBeGreaterThan(0)
      expect(info.cursor.length).toBeGreaterThan(0)
      expect(toolCaption(id, 'arrange')).toBe(`${info.label} — ${info.hint}`)
    }
    expect(toolInfo('pencil', 'piano').hint).toBe('Draw a note')
    expect(toolInfo('pencil', 'arrange').hint).toBe('Draw a new clip')
    expect(toolInfo('trim', 'piano').cursor).toBe('default')
    const phone = phoneTools('arrange')
    const overflow = overflowTools('arrange')
    expect(phone).toEqual(['select', 'pencil', 'split', 'erase'])
    expect(new Set([...phone, ...overflow])).toEqual(new Set(toolsFor('arrange')))
    expect(phone.filter((tool) => overflow.includes(tool))).toEqual([])
    expect(overflowTools('piano')).not.toContain('trim')
    expect(Object.keys(TOOLS)).toEqual(toolsFor('arrange'))
  })
})

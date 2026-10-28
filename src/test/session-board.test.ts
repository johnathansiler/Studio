import { describe, expect, it } from 'vitest'
import { AUDIO_DEVICES, MIDI_DEVICES, browserGroup, clipPaint, curvePath, parseDeviceDrag, sceneTitle, sessionPanes, sessionTracks } from '../model/sessionBoard'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('session board', () => {
  it('names Auto-Tune and Scaler and parses a device drop', () => {
    expect(AUDIO_DEVICES[0]).toMatchObject({ id: 'tune', name: 'Auto-Tune' })
    expect(MIDI_DEVICES[0]).toMatchObject({ id: 'scale', name: 'Scaler' })
    expect(browserGroup('plugins').map((item) => item.name)).toEqual(['Auto-Tune', 'Scaler'])
    expect(parseDeviceDrag('cueharbor-device:audio:tune')).toEqual({ kind: 'audio', id: 'tune' })
    expect(parseDeviceDrag('cueharbor-clip:a:b')).toBeNull()
  })

  it('uses the track color until a clip has its own, and names scenes', () => {
    expect(clipPaint(null, '#73c48f')).toBe('#73c48f')
    expect(clipPaint({ color: '#e35d5d' }, '#73c48f')).toBe('#e35d5d')
    expect(sceneTitle(undefined, 0)).toBe('Scene 1')
    expect(sceneTitle(['Intro'], 0)).toBe('Intro')
    expect(sceneTitle([''], 0)).toBe('Scene 1')
  })

  it('opens the browser, mixer, and detail on a desk and hides them on a phone', () => {
    expect(sessionPanes(false)).toEqual({ browser: true, detail: true, mixer: true })
    expect(sessionPanes(true)).toEqual({ browser: false, detail: false, mixer: false })
    const tracks = sessionTracks(createEmptyProject().tracks)
    expect(tracks.map((track) => track.name)).toEqual(['Vocal', 'Music', 'Keys'])
  })

  it('draws a filter curve and an envelope', () => {
    expect(curvePath('eq', { lowG: 6, midG: 0, highG: -6 })).toMatch(/^M0 /)
    expect(curvePath('compressor', { ratio: 4, attack: 10 })).not.toBe(curvePath('tune', {}))
  })

  it('renames, recolors, duplicates, and moves session clips', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks[2]
    const music = store.project.tracks[1]
    store.prepareMidiSlot(keys.id, 0)
    const clip = keys.midiClips[0]
    store.renameClip(keys.id, clip.id, 'Chords')
    store.recolorClip(keys.id, clip.id, '#5aa7e0')
    expect(clip.name).toBe('Chords')
    expect(clip.color).toBe('#5aa7e0')
    store.duplicateSlot(keys.id, 0)
    expect(keys.midiSlots?.[1]).toBeTruthy()
    expect(keys.midiClips).toHaveLength(2)
    store.moveClipToSlot(keys.id, 0, keys.id, 3)
    expect(keys.midiSlots?.[0]).toBeFalsy()
    expect(keys.midiSlots?.[3]).toBe(clip.id)
    store.setSceneName(0, 'Intro')
    expect(store.project.sceneNames?.[0]).toBe('Intro')
    store.addPlugin(music.id, 'tune')
    const tune = music.plugins.at(-1)
    expect(tune?.pluginId).toBe('tune')
    store.addMidiFx(keys.id, 'scale')
    expect(keys.midiFx?.[0].kind).toBe('scale')
  })
})

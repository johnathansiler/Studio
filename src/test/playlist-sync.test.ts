import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../model/types'
import { displayedPlayhead, transportSample } from '../model/transportSync'
import { selectArrange, selectBeats, selectMixer, selectSession, selectTransport } from '../state/select'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'

describe('shared transport and mixer', () => {
  it('wraps every view to the same playhead inside the loop', () => {
    const project = createEmptyProject(48000)
    project.loopEnabled = true
    project.loopStartSample = 1000
    project.loopEndSample = 48000
    const views = ['arrange', 'session', 'beats', 'mix', 'piano'] as const
    const heads = views.map(() => displayedPlayhead(48000 + 250, project))
    expect(new Set(heads).size).toBe(1)
    expect(heads[0]).toBe(1250)
    expect(transportSample(400, project)).toBe(400)
    project.loopEnabled = false
    expect(displayedPlayhead(50000, project)).toBe(50000)
  })

  it('keeps loop on, off, and the range the same in every view', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    store.setLoop(true, 2400, 96000)
    for (const view of [selectArrange(store), selectMixer(store), selectBeats(store)]) {
      expect(view.project.loopEnabled).toBe(true)
      expect(view.project.loopStartSample).toBe(2400)
      expect(view.project.loopEndSample).toBe(96000)
    }
    expect(selectSession(store).project.loopEnabled).toBe(true)
    expect(selectTransport(store).loopEnabled).toBe(true)
    store.toggle('loopEnabled')
    expect(selectArrange(store).project.loopEnabled).toBe(false)
    expect(selectBeats(store).project.loopEnabled).toBe(false)
    expect(selectMixer(store).project.loopEnabled).toBe(false)
    expect(selectSession(store).project.loopEnabled).toBe(false)
    expect(selectTransport(store).loopEnabled).toBe(false)
  })

  it('updates the track header and the Beats strip from one mixer edit', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.updateTrack(keys.id, { volume: 0.41, pan: -0.25, mute: true })
    const header = selectArrange(store).tracks.find((track) => track.id === keys.id)!
    const mixer = selectMixer(store).tracks.find((track) => track.id === keys.id)!
    const kick = selectBeats(store).pattern!.channels[0]
    expect(header.volume).toBe(0.41)
    expect(mixer).toMatchObject({ volume: 0.41, pan: -0.25, mute: true })
    expect(selectSession(store).tracks.find((track) => track.id === keys.id)?.volume).toBe(0.41)
    expect(kick.volume).toBe(0.41)
    expect(kick.pan).toBe(-0.25)
    expect(kick.mute).toBe(true)
    store.addPlugin(keys.id, 'eq')
    expect(selectMixer(store).tracks.find((track) => track.id === keys.id)?.plugins.at(-1)?.pluginId).toBe('eq')
    expect(selectArrange(store).tracks.find((track) => track.id === keys.id)?.plugins.at(-1)?.pluginId).toBe('eq')
  })

  it('places a pattern on Drums, toasts, and undoes the clip and the track', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const before = store.project.patternClips?.length ?? 0
    expect(store.project.tracks.some((track) => track.name === 'Drums')).toBe(false)
    store.placePattern(4)
    const drums = store.project.tracks.find((track) => track.name === 'Drums')
    const clip = store.project.patternClips!.at(-1)!
    expect(drums?.type).toBe('midi')
    expect(clip.trackId).toBe(drums!.id)
    expect(clip.startBeat).toBe(4)
    expect(clip.scene).toBeNull()
    expect(store.project.patternClips).toHaveLength(before + 1)
    expect(store.toasts.at(-1)?.text).toContain('Drums')
    expect(selectBeats(store).pattern!.channels[0].output).toBe(drums!.id)
    store.undo()
    expect(store.project.patternClips).toHaveLength(before)
    expect(store.project.tracks.some((track) => track.name === 'Drums')).toBe(false)
  })
})

describe('phone arrange', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows compact mute and solo, a setup button, and the loop bar', () => {
    vi.stubGlobal('window', {
      innerWidth: 390,
      innerHeight: 844,
      addEventListener() {},
      removeEventListener() {},
    })
    const store = new ProjectStore(createEmptyProject(48000))
    const html = renderToStaticMarkup(createElement(ArrangeView, {
        store,
        engine: {
          positionSamples: 0,
          subscribe: () => () => undefined,
          currentTimelineSample: () => 0,
        },
        session: { state: { participants: [], selfId: 'me' } },
        onSeek: () => undefined,
        onOpenPiano: () => undefined,
        onPerform: () => undefined,
        onQuickPunch: () => undefined,
        onAnalyze: () => undefined,
      } as never))
      expect(html).toContain('data-phone-arrange="compact"')
      expect(html).toContain('>Setup<')
      expect(html).toContain('data-loop="off"')
      expect(html).toContain('Loop start')
      expect(html).toContain('Loop end')
      expect(html).not.toContain('Solo safe')
      expect(html).not.toContain('>Sec<')
      expect(html).not.toContain('Record options')
  })
})

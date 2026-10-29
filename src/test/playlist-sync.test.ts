import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../model/types'
import { bindPatternClips, patternHostId } from '../model/steps'
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
    expect(store.selectedPatternClipId).toBe(clip.id)
    expect(clip.placed).toBe(true)
    store.undo()
    expect(store.project.patternClips).toHaveLength(before)
    expect(store.project.tracks.some((track) => track.name === 'Drums')).toBe(false)
  })

  it('draws a placed pattern on that track lane and leaves a new song empty', () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} })
    const engine = {
      positionSamples: 0,
      subscribe: () => () => undefined,
      currentTimelineSample: () => 0,
      stopPreview() {},
      previewPcm() {},
      unlock() {},
    }
    const props = {
      engine,
      session: { state: { participants: [], selfId: 'me' } },
      onSeek: () => undefined,
      onOpenPiano: () => undefined,
      onPerform: () => undefined,
      onQuickPunch: () => undefined,
      onAnalyze: () => undefined,
    }
    const fresh = new ProjectStore(createEmptyProject(48000))
    const empty = renderToStaticMarkup(createElement(ArrangeView, { store: fresh, ...props } as never))
    expect(empty).not.toContain('data-pattern="1"')

    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.placePattern(2, keys.id)
    const clip = store.project.patternClips![0]
    expect(clip.trackId).toBe(keys.id)
    expect(store.project.tracks.some((track) => track.name === 'Drums')).toBe(false)
    const html = renderToStaticMarkup(createElement(ArrangeView, { store, ...props } as never))
    const clipAt = html.indexOf('data-pattern="1"')
    const laneAt = html.lastIndexOf('class="lane"', clipAt)
    expect(clipAt).toBeGreaterThan(laneAt)
    const around = html.slice(Math.max(0, clipAt - 240), clipAt + 240)
    expect(html.slice(laneAt, clipAt)).toContain(`data-track="${keys.id}"`)
    expect(around).toContain('selected')
    expect(around).toContain(`data-track="${keys.id}"`)
    vi.unstubAllGlobals()

    store.placePatternClips([{ clipId: clip.id, startBeat: 6.4, trackId: keys.id }])
    expect(store.project.patternClips![0].startBeat).toBe(6)
    expect(store.project.patternClips![0].trackId).toBe(keys.id)
    store.deleteSelectedClip()
    expect(store.project.patternClips).toEqual([])
    store.undo()
    expect(store.project.patternClips?.map((item) => item.id)).toEqual([clip.id])
  })

  it('parks a saved pattern clip on a real instrument track', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.project.patternClips = [{ id: 'kept', patternId: store.activePattern()!.id, startBeat: 4, lengthBeats: 4, scene: null, placed: true }]
    expect(patternHostId(store.project.tracks, null)).toBeNull()
    expect(patternHostId(store.project.tracks, keys.id)).toBe(keys.id)
    expect(patternHostId(store.project.tracks, store.project.tracks[0].id)).toBeNull()
    bindPatternClips(store.project.patternClips, store.project.tracks)
    expect(store.project.patternClips[0].trackId).toBe(keys.id)
  })
})

describe('arrange browser', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('docks sounds, instruments, loops, patterns, plugins, and clips on the left', () => {
    vi.stubGlobal('window', { innerWidth: 1280, innerHeight: 800, addEventListener() {}, removeEventListener() {} })
    const store = new ProjectStore(createEmptyProject(48000))
    const html = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine: {
        positionSamples: 0,
        subscribe: () => () => undefined,
        currentTimelineSample: () => 0,
        stopPreview() {},
        previewPcm() {},
        unlock() {},
      },
      session: { state: { participants: [], selfId: 'me' } },
      onSeek: () => undefined,
      onOpenPiano: () => undefined,
      onPerform: () => undefined,
      onQuickPunch: () => undefined,
      onAnalyze: () => undefined,
    } as never))
    expect(html).toContain('data-playlist-browser="open"')
    for (const label of ['Sounds', 'Instruments', 'Loops', 'Patterns', 'Plugins', 'Clips']) expect(html).toContain(label)
    expect(html).not.toContain('>Read<')
    expect(html).not.toContain('Auto-Tune')
    expect(html).toContain('>Song<')
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
      expect(html).toContain('>Song<')
      expect(html).toContain('data-loop="off"')
      expect(html).toContain('Loop start')
      expect(html).toContain('Loop end')
      expect(html).not.toContain('Solo safe')
      expect(html).not.toContain('>Sec<')
      expect(html).not.toContain('Record options')
  })
})

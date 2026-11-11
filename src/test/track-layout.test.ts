import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { TransportBar } from '../ui/TransportBar'
import { ArrangeView } from '../ui/ArrangeView'
import { trackGlance } from '../ui/trackGlance'

const engine = {
  positionSamples: 48000,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 48000,
  unlock() {},
  stopPreview() {},
}

function transport(phone: boolean) {
  const store = new ProjectStore()
  return renderToStaticMarkup(createElement(TransportBar, {
    store,
    engine: engine as never,
    phone,
    onPlay() {},
    onStop() {},
    onRecord() {},
    onSeek() {},
    onReset() {},
    onIdeas() {},
  }))
}

function words(html: string) {
  return [...html.matchAll(/<span class="t-word">([^<]+)<\/span>/g)].map((match) => match[1])
}

describe('track view layout', () => {
  it('orders the transport as Start, Rewind, Fast Forward, Play, Record, Ideas', () => {
    for (const phone of [true, false]) {
      const html = transport(phone)
      const main = html.slice(html.indexOf('t-main'), html.indexOf('transport-extras'))
      expect(words(main)).toEqual(['Start', 'Rewind', 'Forward', 'Play', 'Record'])
      expect(main).toContain('aria-label="Go to Start.')
      expect(main).toContain('aria-label="Rewind.')
      expect(main).toContain('aria-label="Fast Forward.')
      expect(main).toContain('aria-label="Ideas"')
      expect(main).not.toContain('>Punch<')
      expect(main).not.toContain('>Tempo<')
      expect(main).not.toContain('>Reset<')
      const extras = html.slice(html.indexOf('transport-extras'))
      expect(extras).toContain('>Punch<')
      expect(extras).toContain('>Tempo<')
      expect(extras).toContain('>Reset<')
    }
  })

  it('puts Add Track under the last track and the viewfinder above the header column', () => {
    vi.stubGlobal('window', { innerWidth: 390, innerHeight: 844, addEventListener() {}, removeEventListener() {} })
    const store = new ProjectStore(createEmptyProject())
    const html = renderToStaticMarkup(createElement(ArrangeView, {
      store,
      engine,
      session: { state: { participants: [], selfId: 'me' } },
      onSeek() {},
      onOpenPiano() {},
      onPerform() {},
      onQuickPunch() {},
      onAnalyze() {},
    } as never))
    expect(html).not.toContain('arrange-add')
    expect(html).toContain('data-loop-region="arrange"')
    expect(html).toContain('data-playhead-strip')
    expect(html).toContain('class="ruler"')
    const view = html.indexOf('data-viewfinder')
    const vocal = html.indexOf('data-track-name="Vocal"')
    const keys = html.indexOf('data-track-name="Keys"')
    const add = html.indexOf('>Add Track<')
    const ruler = html.indexOf('data-loop-region="arrange"')
    expect(view).toBeGreaterThan(-1)
    expect(view).toBeLessThan(vocal)
    expect(keys).toBeLessThan(add)
    expect(ruler).toBeGreaterThan(view)
    expect(html).not.toContain('class="name"')
    expect(html).toContain('>Mute<')
    expect(html).toContain('>Solo<')
    expect(html).toContain('>Arm<')
    expect(html).toContain('class="mini track-more')
    expect(html).toContain('data-view-name')
    expect(html).toContain('>Vocal<')
    expect(html).toContain('C Major')
    expect(html).toContain('\u00a0·\u00a0C Major\u00a0·\u00a0120')
    expect(html).not.toContain('No sample')
    expect(html).not.toContain('Inserts')
    vi.unstubAllGlobals()
  })

  it('updates the viewfinder when another track is selected', () => {
    const project = createEmptyProject()
    const vocal = project.tracks[0]
    const keys = project.tracks.find((track) => track.name === 'Keys')!
    keys.plugins = [{ id: 'plug', pluginId: 'synth', version: '1', enabled: true, wet: 1, params: {}, sidechain: '' }]
    vocal.volume = 0.5
    vocal.pan = -0.5
    vocal.mute = true
    const store = new ProjectStore(project)
    store.selectTrack(vocal.id)
    const first = trackGlance({
      project: store.project,
      track: store.track(store.selectedTrackId!) ?? null,
      selectedClipId: null,
    })
    expect(first.name).toBe('Vocal')
    expect(first.type).toBe('Audio')
    expect(first.mute).toBe(true)
    expect(first.pan).toMatch(/Left/)
    store.selectTrack(keys.id)
    const second = trackGlance({
      project: store.project,
      track: store.track(keys.id) ?? null,
    })
    expect(second.name).toBe('Keys')
    expect(second.type).toBe('Instrument')
    expect(second.source).toBe('Synth')
    expect(second.empty).toBe(false)
    const none = trackGlance({ project: store.project, track: null })
    expect(none.empty).toBe(true)
    expect(none.bpm).toBe('120')
    expect(none.key).toContain('C')
  })
})

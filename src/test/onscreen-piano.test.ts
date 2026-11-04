import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { showsOnscreenPiano, shouldCloseOnscreenPiano } from '../model/onscreenPiano'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { ArrangeView } from '../ui/ArrangeView'
import { MidiDock } from '../ui/MidiDock'

const engine = {
  positionSamples: 0,
  status: 'stopped' as const,
  subscribe: () => () => undefined,
  unlock() {},
  currentTimelineSample: () => 0,
  levels: () => ({ tracks: {}, master: 0, input: 0, talk: 0 }),
  midiActivity: () => ({}),
} as unknown as AudioEngine

function arrange(store: ProjectStore) {
  return renderToStaticMarkup(createElement(ArrangeView, {
    store,
    engine,
    session: { state: { participants: [], selfId: 'me' } },
    onSeek() {},
    onOpenPiano() {},
    onPerform() {},
    onQuickPunch() {},
    onAnalyze() {},
  } as never))
}

describe('on-screen piano visibility', () => {
  it('shows the button only for a MIDI track with an instrument loaded', () => {
    expect(showsOnscreenPiano(null)).toBe(false)
    expect(showsOnscreenPiano({ type: 'audio', instrument: 'synth' })).toBe(false)
    expect(showsOnscreenPiano({ type: 'midi' })).toBe(true)
    expect(showsOnscreenPiano({ type: 'midi', instrument: 'none' })).toBe(false)
    expect(showsOnscreenPiano({ type: 'midi', instrument: 'none', plugins: [{ pluginId: 'eq' }] })).toBe(false)
    for (const instrument of ['synth', 'sampler', '808', 'drum-machine', 'library', 'scaler', 'pads']) {
      expect(showsOnscreenPiano({ type: 'midi', instrument }), instrument).toBe(true)
    }
    expect(showsOnscreenPiano({ type: 'midi', instrument: 'none', plugins: [{ pluginId: 'steps' }] })).toBe(true)
    expect(showsOnscreenPiano({ type: 'midi', plugins: [{ pluginId: 'synth' }] })).toBe(true)
    expect(showsOnscreenPiano({ type: 'midi', instrument: 'none', plugins: [{ pluginId: 'scaler', enabled: false }] })).toBe(false)
    expect(shouldCloseOnscreenPiano({ type: 'audio' }, true)).toBe(true)
    expect(shouldCloseOnscreenPiano({ type: 'midi', instrument: 'synth' }, true)).toBe(false)
    expect(shouldCloseOnscreenPiano({ type: 'audio' }, false)).toBe(false)
  })

  it('puts On-screen Piano on the selected instrument track and not on an audio track', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.type === 'audio')!
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(vocal.id)
    expect(arrange(store)).not.toContain('On-screen Piano')
    store.selectTrack(keys.id)
    expect(arrange(store)).toContain('On-screen Piano')
    store.setTrackInstrument(keys.id, 'none')
    expect(arrange(store)).not.toContain('On-screen Piano')
    store.setTrackInstrument(keys.id, 'synth')
    const synth = arrange(store)
    expect(synth).toContain('On-screen Piano')
    expect(synth).toContain('onscreen-piano')
    expect(synth).not.toContain('>Keyboard<')
    store.selectTrack(vocal.id)
    expect(arrange(store)).not.toContain('On-screen Piano')
  })

  it('offers On-screen Piano in the note editor so the playable piano can swap in', () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.setTrackInstrument(keys.id, 'synth')
    store.preparePianoClip(keys.id, 0)
    const html = renderToStaticMarkup(createElement(MidiDock, {
      store,
      engine,
      onClose() {},
    }))
    expect(html).toContain('>On-screen Piano<')
    expect(html).toContain('Edit Notes brings the note editor back')
    expect(html).toContain('>Close<')
  })
})

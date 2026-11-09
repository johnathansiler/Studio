import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyProject, makeTrack } from '../model/types'
import { ProjectStore } from '../state/store'
import { trackKindLabel, trackOpenTiles, TrackOptions } from '../ui/TrackOptions'

describe('arrange track options', () => {
  it('offers instrument editors only on a midi track, labeled Beat Machine', () => {
    expect(trackOpenTiles({ type: 'midi' }).map((tile) => tile.label)).toEqual([
      'Keys',
      'Beat Machine',
      'Scaler',
      'Patch',
      'Rack',
    ])
    expect(trackOpenTiles({ type: 'audio' }).map((tile) => tile.id)).toEqual(['repair'])
    expect(trackOpenTiles({ type: 'bus' })).toEqual([])
    expect(trackKindLabel({ type: 'midi' })).toBe('Instrument')
    expect(trackKindLabel({ type: 'audio' })).toBe('Audio')
  })

  it('hides the gray descriptions and keeps the hints on the controls', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = makeTrack({ name: 'Keys', type: 'midi', instrument: 'synth' })
    store.project.tracks.push(track)
    const html = renderToStaticMarkup(createElement(TrackOptions, {
      store,
      track,
      level: 0.5,
      automationOpen: false,
      participants: [],
      onClose() {},
      onPerform() {},
      onAnalyze() {},
    }))
    expect(html).toContain('>Beat Machine<')
    expect(html).not.toContain('>Open Beat Machine<')
    expect(html).not.toContain('<small>')
    expect(html).toContain('Stay audible when other tracks are soloed.')
    expect(html).toContain('data-track-action="volume"')
    expect(html).toContain('data-track-meter')
    expect(html).toContain('width:50%')
    expect(html).toContain('data-track-action="keys"')
    expect(html).not.toContain('data-track-action="repair"')
  })
})

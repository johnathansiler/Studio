import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PadScreen } from '../ui/PadScreen'
import {
  closeUp,
  dragFraction,
  resolveTrimIndex,
  showsSamples,
  viewPeaks,
  zoomAround,
} from '../model/padTrim'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

describe('pad screen trim and zoom', () => {
  it('snaps to a rising or falling zero and can place freely', () => {
    const data = new Float32Array(24)
    data[8] = -0.4
    data[9] = 0.4
    data[16] = 0.3
    data[17] = -0.3
    const rising = resolveTrimIndex(data, 7, true, 6)
    expect(rising.index).toBe(9)
    expect(rising.crossing?.rising).toBe(true)
    const falling = resolveTrimIndex(data, 15, true, 6)
    expect(falling.index).toBe(17)
    expect(falling.crossing?.rising).toBe(false)
    expect(resolveTrimIndex(data, 7, false, 6).index).toBe(7)
    expect(resolveTrimIndex(data, 7, false, 6).crossing).toBeNull()
  })

  it('zooms toward a point, down to a handful of samples, and fine-drags', () => {
    const once = zoomAround({ start: 0, end: 1 }, 0.5, 2, 48000)
    expect(once.end - once.start).toBeCloseTo(0.5)
    expect(once.start).toBeCloseTo(0.25)
    const tight = closeUp(0.25, 48000, 64)
    expect((tight.end - tight.start) * 48000).toBeGreaterThan(60)
    expect((tight.end - tight.start) * 48000).toBeLessThan(70)
    expect(tight.start).toBeLessThan(0.25)
    expect(tight.end).toBeGreaterThan(0.25)
    expect(showsSamples(tight, 48000, 400)).toBe(true)
    expect(showsSamples({ start: 0, end: 1 }, 48000, 400)).toBe(false)
    expect(dragFraction(0.4, 100, 200, false)).toBeCloseTo(0.9)
    expect(dragFraction(0.4, 100, 200, true)).toBeCloseTo(0.5)
    const ramp = new Float32Array(8)
    for (let i = 0; i < ramp.length; i++) ramp[i] = i / 8
    const forward = viewPeaks(ramp, { start: 0, end: 1 }, 4, false)
    const flipped = viewPeaks(ramp, { start: 0, end: 1 }, 4, true)
    expect(forward[1]).toBeLessThan(flipped[1])
  })

  it('saves a dragged window as one undo step and keeps a chop slice', () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    const samples = new Float32Array(1600)
    store.setChopSample(id, samples, 1000, 'Loop')
    store.patchChop(id, { mode: 'even', even: 8 })
    store.assignChopToPads(id)
    const before = store.trackKit(id).banks[0][1].region?.start ?? 0
    store.setPadWindow(id, 0, 1, 0.2, 0.4, true)
    store.setPadWindow(id, 0, 1, 0.22, 0.45, true)
    store.endDraft()
    expect(store.trackKit(id).banks[0][1].region?.start).toBeCloseTo(0.22)
    expect(store.trackKit(id).banks[0][1].region?.end).toBeCloseTo(0.45)
    store.undo()
    expect(store.trackKit(id).banks[0][1].region?.start).toBeCloseTo(before)
    const html = renderToStaticMarkup(createElement(PadScreen, {
      name: 'Kick',
      samples,
      sampleRate: 1000,
      start: 0.2,
      end: 0.45,
      reverse: false,
      tune: 2,
      tuneCents: 0,
      pitchMode: 'vinyl',
      filter: 0.5,
      highpass: 0.2,
      vintage: 0.4,
      level: 0.8,
      gate: 'hold',
      swing: 62,
      tempo: 120,
      hitToken: 0,
      snap: true,
      onTrim: () => {},
      onTrimEnd: () => {},
    }))
    expect(html).not.toContain('Zoom in')
    expect(html).not.toContain('Zoom out')
    expect(html).not.toContain('Zoom to Start')
    expect(html).not.toContain('Zoom to End')
    expect(html).not.toContain('Snap to zero')
    expect(html).not.toContain('>Reset<')
    expect(html).toContain('pad-screen-zero')
    expect(html).toContain('Start marker')
    expect(html).toContain('End marker')
    expect(html).not.toContain('pad-screen-readout')
    expect(html).not.toContain('>Hold<')
    expect(html).not.toContain('One shot')
    expect(html).not.toContain('Vinyl')
    expect(html).not.toContain('Swing')
    expect(html).not.toContain('Vintage')
    expect(html).not.toContain('mpc-pill')
    expect(html).toContain('data-snap-zero="1"')
  })
})

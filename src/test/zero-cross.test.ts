import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { snapClipTimeline } from '../audio/clipSnap'
import { buildPeakPyramid, peaksForSpan } from '../audio/peakPyramid'
import { nearestZeroIndex, lockToZero, snapFraction, crossingsInRange } from '../audio/zeroCross'
import { snapZero } from '../audio/sample/engine'
import { createEmptyProject, makeTrack } from '../model/types'
import { ProjectStore } from '../state/store'
import { MIN_WAVE_SPAN, showsSampleDots, usesRawSamples, zoomSpan } from '../ui/waveZoom'
import { WaveformView } from '../ui/WaveformView'

function legacySnap(channel: ArrayLike<number>, index: number, radius = 256) {
  const at = Math.min(Math.max(0, Math.round(index)), Math.max(0, channel.length - 1))
  let best = at
  let bestDist = radius + 1
  const from = Math.max(1, at - radius)
  const to = Math.min(channel.length - 1, at + radius)
  for (let i = from; i <= to; i++) {
    const prev = channel[i - 1] || 0
    const value = channel[i] || 0
    if (prev === 0 || prev * value < 0 || Math.abs(value) < 1e-5) {
      const dist = Math.abs(i - at)
      if (dist < bestDist) {
        best = i
        bestDist = dist
      }
    }
  }
  return best
}

function sine(length: number, hz: number, rate: number) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / rate)
  return out
}

describe('zero crossings', () => {
  it('finds sign changes and exact zeros', () => {
    const channel = Float32Array.from([0.4, 0.2, -0.2, -0.4, 0, 0.3])
    const hits = crossingsInRange(channel, 0, channel.length).map((hit) => hit.index)
    expect(hits).toContain(2)
    expect(hits).toContain(4)
    expect(hits).toContain(5)
  })

  it('snaps to the nearer crossing and can stay free', () => {
    const channel = new Float32Array(12).fill(0.5)
    for (let i = 2; i < 10; i++) channel[i] = -0.5
    expect(nearestZeroIndex(channel, 0, 20)).toBe(2)
    expect(nearestZeroIndex(channel, 8, 20)).toBe(10)
    expect(nearestZeroIndex(channel, 6, 20)).toBe(2)
    const locked = lockToZero(channel, 8, true, 20)
    expect(locked.locked).toBe(true)
    expect(locked.index).toBe(10)
    const free = lockToZero(channel, 8, false, 20)
    expect(free).toEqual({ index: 8, at: 8, locked: false })
    expect(snapFraction(channel, 8 / channel.length, false).locked).toBe(false)
    expect(snapFraction(channel, 8 / channel.length, false).fraction).toBeCloseTo(8 / channel.length)
    const snapped = snapFraction(channel, 8 / channel.length, true)
    expect(snapped.locked).toBe(true)
    expect(snapped.index).toBe(10)
  })

  it('matches the previous snap on a sine and on mixed buffers', () => {
    const tone = sine(200, 100, 8000)
    expect(snapZero(tone, 3, 40)).toBe(nearestZeroIndex(tone, 3, 40))
    expect(Math.abs(tone[snapZero(tone, 3, 40)] || 0)).toBeLessThan(0.2)
    for (let n = 0; n < 30; n++) {
      const channel = new Float32Array(280)
      for (let i = 0; i < channel.length; i++) channel[i] = Math.sin(i * 0.17 + n) * (n % 5 === 0 ? 0 : 1)
      for (const index of [0, 3, 20, 100, 279]) {
        expect(nearestZeroIndex(channel, index, 40)).toBe(legacySnap(channel, index, 40))
        expect(nearestZeroIndex(channel, index, 256)).toBe(legacySnap(channel, index, 256))
      }
    }
  })

  it('keeps an exact clip trim on the crossing and undoes it', () => {
    const length = 48000
    const channel = new Float32Array(length).fill(0.4)
    for (let i = 50; i < channel.length; i++) channel[i] = -0.4
    const project = createEmptyProject(length)
    project.snap = true
    project.tracks = [makeTrack({
      id: 'vocal',
      name: 'Vocal',
      type: 'audio',
      volume: 1,
      pan: 0,
      input: 'none',
      clips: [{
        id: 'take',
        name: 'take',
        bufferId: 'buf',
        startSample: 0,
        offsetSamples: 0,
        durationSamples: length,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 1,
        source: 'local',
      }],
    })]
    const store = new ProjectStore(project, new Map([['buf', { id: 'buf', name: 'take', sampleRate: 48000, channels: [channel] }]]))
    store.project.snap = true
    store.trimClip('vocal', 'take', 'start', 50)
    expect(store.project.tracks[0].clips[0].offsetSamples).toBe(0)
    store.undo()
    const hit = lockToZero(channel, 47, true)
    expect(hit.index).toBe(50)
    const timeline = snapClipTimeline(store.project.tracks[0].clips[0], channel, 47, true)
    expect(timeline.locked).toBe(true)
    expect(timeline.sample).toBe(50)
    store.trimClip('vocal', 'take', 'start', timeline.sample, true)
    expect(store.project.tracks[0].clips[0].offsetSamples).toBe(50)
    expect(store.project.tracks[0].clips[0].startSample).toBe(50)
    store.undo()
    expect(store.project.tracks[0].clips[0].offsetSamples).toBe(0)
    expect(store.project.tracks[0].clips[0].durationSamples).toBe(length)
  })

  it('undoes a snapped slot handle', () => {
    const store = new ProjectStore(createEmptyProject())
    const track = store.project.tracks[0]
    store.addPlugin(track.id, 'sampler')
    const plugin = store.track(track.id)!.plugins.find((item) => item.pluginId === 'sampler')!
    const channel = sine(480, 220, 48000)
    store.loadSlotAudio(track.id, plugin.id, { id: 'tone', name: 'Tone', sampleRate: 48000, channels: [channel] })
    const hit = snapFraction(channel, 0.4, true)
    expect(hit.locked).toBe(true)
    store.setSlotPoints(track.id, plugin.id, { start: hit.fraction, end: 1, loopStart: hit.fraction, loopEnd: 1 })
    store.endDraft()
    expect(store.track(track.id)!.plugins.find((item) => item.id === plugin.id)!.sampler!.start).toBeCloseTo(hit.fraction)
    store.undo()
    expect(store.track(track.id)!.plugins.find((item) => item.id === plugin.id)!.sampler!.start).toBe(0)
  })

  it('builds a peak pyramid and zooms toward one sample', () => {
    const channel = new Float32Array(800)
    channel[100] = 1
    channel[101] = -1
    const pyramid = buildPeakPyramid(channel, 32)
    expect(pyramid.levels.length).toBeGreaterThan(1)
    const cols = peaksForSpan(pyramid, 0, 800, 8)
    expect(cols.some((bin) => bin.max > 0.5)).toBe(true)
    expect(usesRawSamples(40, 80)).toBe(true)
    expect(showsSampleDots(20, 80)).toBe(true)
    const zoomed = zoomSpan({ start: 0, end: 800 }, { start: 0, end: 800 }, 8, 100)
    expect(zoomed.end - zoomed.start).toBeLessThan(200)
    expect(zoomed.start).toBeGreaterThanOrEqual(0)
    expect(zoomed.end).toBeLessThanOrEqual(800)
    const tight = zoomSpan(zoomed, { start: 0, end: 800 }, 100, 100)
    expect(tight.end - tight.start).toBe(MIN_WAVE_SPAN)
  })

  it('offers zoom and snap controls on the shared waveform', () => {
    const html = renderToStaticMarkup(createElement(WaveformView, {
      channel: sine(64, 110, 4800),
      ariaLabel: 'Sample waveform',
      markers: [{ id: 'start', at: 0, className: 'mark', marker: 'start', name: 'Start', label: 'Clip start. Drag to trim the beginning.', title: 'Start' }],
    }))
    expect(html).toContain('Zoom in')
    expect(html).toContain('Zoom out')
    expect(html).toContain('Snap to zero')
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Sample waveform"')
    expect(html).toContain('data-marker="start"')
    expect(html).toContain('wave-zoom-btn')
    const css = readFileSync(new URL('../ui/waveform.css', import.meta.url), 'utf8')
    expect(css).toContain('min-height: 40px')
  })
})

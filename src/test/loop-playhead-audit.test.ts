import { describe, expect, it } from 'vitest'
import { arrangeGripParks } from '../ui/LoopRegion'
import { PINCH_MAX_RATIO, PINCH_STEP, pinchTimelineZoom } from '../ui/ArrangeView'
import { placePlayhead, playheadContentX, playheadPx, playheadStripWidth, playheadTransform } from '../ui/playhead'

describe('arrange loop parks', () => {
  it('keeps caps on the beat while they are in view and parks them after they leave', () => {
    expect(arrangeGripParks(80, 140, 0, 390)).toEqual({ start: 'track', end: 'track' })
    expect(arrangeGripParks(-240, 250, 180, 350)).toEqual({ start: 'left', end: 'track' })
    expect(arrangeGripParks(0, 800, 0, 164)).toEqual({ start: 'track', end: 'right' })
    expect(arrangeGripParks(-200, 900, 180, 350)).toEqual({ start: 'left', end: 'right' })
  })
})

describe('timeline pinch', () => {
  const anchor = {
    anchorX: 500,
    anchorY: 40,
    midX: 200,
    midY: 80,
    viewLeft: 50,
    viewTop: 20,
    minPx: 30,
    maxPx: 280,
  }

  it('does not triple 90 px/s in one spread, and approaches the cap in small steps', () => {
    const jumped = pinchTimelineZoom({
      ...anchor,
      originPx: 90,
      currentPx: 90,
      originDist: 80,
      dist: 240,
    })
    expect(jumped.px).toBeCloseTo(90 * PINCH_STEP)
    expect(jumped.px).toBeLessThan(180)
    expect(jumped.px).not.toBeCloseTo(270)
    let current = 90
    let last = jumped
    for (let i = 0; i < 40; i++) {
      last = pinchTimelineZoom({
        ...anchor,
        originPx: 90,
        currentPx: current,
        originDist: 80,
        dist: 240,
      })
      expect(last.px).toBeLessThanOrEqual(current * PINCH_STEP + 1e-6)
      expect(last.px).toBeLessThanOrEqual(90 * PINCH_MAX_RATIO + 1e-6)
      current = last.px
    }
    expect(last.px).toBeCloseTo(180)
    expect(last.ratio).toBeCloseTo(2)
    expect(last.px).toBeLessThan(270)
  })

  it('keeps the content under the pinch center while the scale changes', () => {
    const next = pinchTimelineZoom({
      ...anchor,
      originPx: 90,
      currentPx: 90,
      originDist: 100,
      dist: 105,
    })
    const ratio = next.px / 90
    expect(next.scrollLeft + (anchor.midX - anchor.viewLeft)).toBeCloseTo(anchor.anchorX * ratio)
    expect(next.scrollTop + (anchor.midY - anchor.viewTop)).toBeCloseTo(anchor.anchorY * ratio)
  })
})

describe('playhead motion', () => {
  it('sizes the hit target to the visible strip', () => {
    expect(playheadStripWidth(164, 1440)).toBe(164)
    expect(playheadStripWidth(390, 8000)).toBe(390)
    expect(playheadContentX(200, 186, 420)).toBe(434)
  })

  it('moves a compositor animation instead of writing transform every frame', () => {
    const times: number[] = []
    let animations = 0
    let playState = 'paused'
    const node = {
      style: { transform: '', willChange: '' },
      animate() {
        animations += 1
        let currentTime: number | null = 0
        let playbackRate = 1
        return {
          get currentTime() {
            return currentTime
          },
          set currentTime(value: number | null) {
            currentTime = value
            if (value != null) times.push(value)
          },
          get playbackRate() {
            return playbackRate
          },
          set playbackRate(value: number) {
            playbackRate = value
          },
          get playState() {
            return playState
          },
          play() {
            playState = 'running'
          },
          pause() {
            playState = 'paused'
          },
        }
      },
    }
    const sample = 48000
    const px = playheadPx(sample, 48000, 90)
    placePlayhead(node, sample, 48000, 90, true)
    placePlayhead(node, sample + 480, 48000, 90, true)
    expect(animations).toBe(1)
    expect(node.style.transform).toBe('')
    expect(node.style.willChange).toBe('transform')
    expect(times).toEqual([(px / 90) * 1000])
    expect(playState).toBe('running')
    placePlayhead(node, sample + 48000, 48000, 90, true)
    expect(times).toEqual([(px / 90) * 1000, ((px + 90) / 90) * 1000])
    expect(playheadTransform(px)).toBe(`translateX(${px}px)`)
  })
})

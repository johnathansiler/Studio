import { describe, expect, it } from 'vitest'
import { clickVoice, gainDb } from '../audio/metroClick'
import { clipTapAction } from '../ui/clipKeys'
import { menuFillsViewport } from '../ui/anchorPlace'
import { swipeShouldDismiss } from '../ui/swipeDismiss'

describe('menu size follows the content', () => {
  const phone = { width: 390, height: 844 }
  const fold = { width: 923, height: 780 }

  it('docks a short menu and fills a tall one', () => {
    expect(menuFillsViewport({ width: 280, height: 320 }, fold, 48)).toBe(false)
    expect(menuFillsViewport({ width: 280, height: 320 }, phone, 48)).toBe(false)
    expect(menuFillsViewport({ width: 300, height: 640 }, phone, 48)).toBe(true)
    expect(menuFillsViewport({ width: 0, height: 0 }, phone, 48)).toBe(false)
  })
})

describe('count-in clicks are quieter and darker', () => {
  it('keeps beat 1 louder, and drops the count-in by about 9 dB', () => {
    const live = clickVoice(true, false)
    const count = clickVoice(true, true)
    const weak = clickVoice(false, true)
    const db = gainDb(count.peak, live.peak)
    expect(db).toBeLessThanOrEqual(-8)
    expect(db).toBeGreaterThanOrEqual(-10)
    expect(count.frequency).toBeLessThan(live.frequency)
    expect(count.type).not.toBe(live.type)
    expect(count.lowpass).not.toBeNull()
    expect(live.lowpass).toBeNull()
    expect(count.peak).toBeGreaterThan(weak.peak)
    expect(clickVoice(false, false).peak).toBeGreaterThan(weak.peak)
  })
})

describe('a clip tap only selects', () => {
  it('opens the editor on the second tap, and a drag never does', () => {
    expect(clipTapAction({ moved: false, sinceLastMs: 10_000, kind: 'midi' })).toBe('select')
    expect(clipTapAction({ moved: false, sinceLastMs: 10_000, kind: 'audio' })).toBe('select')
    expect(clipTapAction({ moved: false, sinceLastMs: 200, kind: 'midi' })).toBe('edit')
    expect(clipTapAction({ moved: false, sinceLastMs: 200, kind: 'audio' })).toBe('edit')
    expect(clipTapAction({ moved: false, sinceLastMs: 200, kind: 'pattern' })).toBe('select')
    expect(clipTapAction({ moved: false, sinceLastMs: 10_000, kind: 'pattern', sequencer: true })).toBe('edit')
    expect(clipTapAction({ moved: false, sinceLastMs: 10_000, kind: 'midi', sequencer: true })).toBe('edit')
    expect(clipTapAction({ moved: false, sinceLastMs: 10_000, kind: 'midi' })).toBe('select')
    expect(clipTapAction({ moved: true, sinceLastMs: 10, kind: 'pattern', sequencer: true })).toBe('drag')
    expect(clipTapAction({ moved: true, sinceLastMs: 10, kind: 'midi', sequencer: true })).toBe('drag')
    expect(clipTapAction({ moved: true, sinceLastMs: 100, kind: 'midi' })).toBe('drag')
  })
})

describe('toasts dismiss sideways', () => {
  it('accepts a left or right flick and ignores a vertical drag', () => {
    expect(swipeShouldDismiss(64, 8)).toBe(true)
    expect(swipeShouldDismiss(-64, 10)).toBe(true)
    expect(swipeShouldDismiss(20, 4)).toBe(false)
    expect(swipeShouldDismiss(30, 40)).toBe(false)
  })
})

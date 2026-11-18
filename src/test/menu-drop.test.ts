import { describe, expect, it } from 'vitest'
import { menuSwipeCloses } from '../ui/menuDrop'

describe('top menu swipe', () => {
  it('closes on an upward swipe and leaves a sideways drag alone', () => {
    expect(menuSwipeCloses(0, 40)).toBe(true)
    expect(menuSwipeCloses(10, 36)).toBe(true)
    expect(menuSwipeCloses(0, 20)).toBe(false)
    expect(menuSwipeCloses(40, 30)).toBe(false)
    expect(menuSwipeCloses(0, -40)).toBe(false)
  })
})
import { describe, expect, it } from 'vitest'
import { anchoredShouldClose, placeAnchoredMenu } from '../ui/anchorPlace'

describe('anchored menu placement', () => {
  const viewport = { width: 390, height: 844 }
  const menu = { width: 220, height: 180 }

  it('drops down from a top button and shares its bottom edge', () => {
    const trigger = { left: 250, top: 48, width: 72, height: 40 }
    const place = placeAnchoredMenu({ trigger, menu, viewport, prefer: 'down' })
    expect(place.side).toBe('down')
    expect(place.top).toBe(trigger.top + trigger.height - 1)
    expect(place.left).toBeGreaterThanOrEqual(8)
    expect(place.left + Math.min(menu.width, place.maxWidth)).toBeLessThanOrEqual(viewport.width - 8)
    expect(place.left).toBeLessThan(trigger.left + trigger.width)
    expect(place.left + Math.min(menu.width, place.maxWidth)).toBeGreaterThan(trigger.left)
  })

  it('opens upward from the bottom edit bar and stays on screen', () => {
    const trigger = { left: 16, top: 780, width: 88, height: 40 }
    const place = placeAnchoredMenu({ trigger, menu, viewport, prefer: 'up' })
    expect(place.side).toBe('up')
    expect(place.top + Math.min(menu.height, place.maxHeight)).toBeGreaterThanOrEqual(trigger.top)
    expect(place.top).toBeGreaterThanOrEqual(8)
    expect(place.left).toBeGreaterThanOrEqual(8)
  })

  it('flips when the preferred side has no room and clamps a wide menu', () => {
    const trigger = { left: 300, top: 20, width: 70, height: 40 }
    const tall = placeAnchoredMenu({
      trigger,
      menu: { width: 500, height: 700 },
      viewport,
      prefer: 'up',
    })
    expect(tall.side).toBe('down')
    expect(tall.maxWidth).toBeLessThanOrEqual(viewport.width - 16)
    expect(tall.left).toBeGreaterThanOrEqual(8)
    expect(tall.left + Math.min(500, tall.maxWidth)).toBeLessThanOrEqual(viewport.width - 8)
  })

  it('stays below the view tabs when that band is reserved', () => {
    const trigger = { left: 16, top: 8, width: 72, height: 36 }
    const place = placeAnchoredMenu({
      trigger,
      menu: { width: 220, height: 280 },
      viewport,
      prefer: 'down',
      clearTop: 52,
    })
    expect(place.top).toBeGreaterThanOrEqual(52)
    expect(place.top + 40).toBeLessThanOrEqual(viewport.height)
  })

  it('closes on an outside press and leaves the trigger and the menu alone', () => {
    const triggerNode = {} as Node
    const menuNode = {} as Node
    const outside = {} as Node
    const trigger = { contains: (node: Node) => node === triggerNode } as unknown as Node
    const menu = { contains: (node: Node) => node === menuNode } as unknown as Node
    expect(anchoredShouldClose(outside, trigger, menu)).toBe(true)
    expect(anchoredShouldClose(triggerNode, trigger, menu)).toBe(false)
    expect(anchoredShouldClose(menuNode, trigger, menu)).toBe(false)
    expect(anchoredShouldClose(null, trigger, menu)).toBe(true)
  })
})

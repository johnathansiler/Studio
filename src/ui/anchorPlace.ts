/** Where an anchored menu sits so it shares an edge with its trigger and stays on screen. */

export interface AnchorBox {
  left: number
  top: number
  width: number
  height: number
}

export interface AnchorPlacement {
  side: 'down' | 'up'
  top: number
  left: number
  maxHeight: number
  maxWidth: number
}

const MIN_ROOM = 96

export function placeAnchoredMenu(input: {
  trigger: AnchorBox
  menu: { width: number; height: number }
  viewport: { width: number; height: number }
  prefer?: 'down' | 'up' | 'auto'
  margin?: number
  /** Menus stay below this line so they never cover the view tabs. */
  clearTop?: number
}): AnchorPlacement {
  const margin = input.margin ?? 8
  const floor = Math.max(margin, input.clearTop ?? 0)
  const trigger = input.trigger
  const menuWidth = Math.max(40, input.menu.width)
  const menuHeight = Math.max(40, input.menu.height)
  const viewW = Math.max(margin * 2 + 40, input.viewport.width)
  const viewH = Math.max(margin * 2 + 40, input.viewport.height)
  const below = viewH - (trigger.top + trigger.height) - margin
  const above = trigger.top - margin
  let side: 'down' | 'up' = input.prefer === 'up' || input.prefer === 'down'
    ? input.prefer
    : trigger.top + trigger.height / 2 > viewH * 0.62
      ? 'up'
      : 'down'
  if (side === 'down' && below < MIN_ROOM && above > below) side = 'up'
  if (side === 'up' && above < MIN_ROOM && below > above) side = 'down'

  const maxWidth = Math.max(40, viewW - margin * 2)
  const width = Math.min(menuWidth, maxWidth)
  let left = trigger.left
  if (left + width > viewW - margin) left = trigger.left + trigger.width - width
  if (left < margin) left = margin
  if (left + width > viewW - margin) left = Math.max(margin, viewW - margin - width)
  const overlap = Math.min(left + width, trigger.left + trigger.width) - Math.max(left, trigger.left)
  if (overlap < Math.min(12, trigger.width)) {
    left = Math.max(margin, Math.min(trigger.left, viewW - margin - width))
  }

  const room = Math.max(40, side === 'down' ? below : above)
  const height = Math.min(menuHeight, room)
  let top = side === 'down'
    ? trigger.top + trigger.height - 1
    : trigger.top - height + 1
  if (top < floor) top = floor
  const maxTop = Math.max(floor, viewH - margin - Math.min(height, 40))
  if (top > maxTop) top = maxTop
  return {
    side,
    top,
    left,
    maxHeight: Math.max(40, viewH - margin - top),
    maxWidth,
  }
}

/** A press outside the trigger and the menu should close it. The trigger itself toggles. */
export function anchoredShouldClose(target: Node | null, trigger: Node | null, menu: Node | null): boolean {
  if (!target) return true
  if (trigger && (target === trigger || trigger.contains(target))) return false
  if (menu && (target === menu || menu.contains(target))) return false
  return true
}

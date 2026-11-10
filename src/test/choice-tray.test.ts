import { describe, expect, it } from 'vitest'
import { trayColumns, trayRows } from '../ui/choiceTray'

describe('choice tray columns', () => {
  it('keeps seven tools and ten snap values on two rows when the width allows 40px chips', () => {
    expect(trayColumns(7, 360)).toBe(4)
    expect(trayRows(7, 4)).toBe(2)
    expect(trayColumns(10, 360)).toBe(5)
    expect(trayRows(10, 5)).toBe(2)
    expect(trayColumns(10, 390)).toBe(5)
  })

  it('adds rows only when two rows would put a chip under 40px', () => {
    expect(trayColumns(10, 120)).toBe(2)
    expect(trayRows(10, 2)).toBe(5)
    expect(trayColumns(7, 80)).toBe(1)
    expect(trayRows(7, 1)).toBe(7)
    expect(trayColumns(1, 40)).toBe(1)
    expect(trayColumns(0, 200)).toBe(1)
  })
})

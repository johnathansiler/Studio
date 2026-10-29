import { describe, expect, it } from 'vitest'
import {
  COLUMN_BOUNDS,
  COLUMN_DEFAULT,
  COLUMN_MAX,
  COLUMN_MIN,
  STRIP_BOUNDS,
  STRIP_DEFAULT,
  STRIP_MAX,
  STRIP_HALF,
  STRIP_MIN,
  displayedStrip,
  columnRightEdge,
  columnsOnScreen,
  defaultLayout,
  layoutStorageKey,
  normalizeLayout,
  readLayout,
  sessionTableWidth,
  stripRightEdge,
  stripsOnScreen,
  widthFromDrag,
  widthFromKey,
  widthFromPinch,
  isNarrowStrip,
  mixerFlow,
  withColumn,
  withMixer,
  withStrip,
  writeLayout,
  type LayoutMemory,
} from '../model/layoutWidth'

function memory(): LayoutMemory {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

describe('layout widths', () => {
  it('fits several compact strips and clip columns on phones and foldables', () => {
    expect(STRIP_DEFAULT).toBeLessThan(120)
    expect(COLUMN_DEFAULT).toBeLessThan(88)
    expect(stripsOnScreen(360, 168)).toBeLessThan(3)
    expect(stripRightEdge(3)).toBeLessThanOrEqual(360)
    expect(stripRightEdge(4)).toBeLessThanOrEqual(390)
    expect(stripsOnScreen(360)).toBeGreaterThanOrEqual(3)
    expect(stripsOnScreen(390)).toBeGreaterThanOrEqual(4)
    expect(stripsOnScreen(673)).toBeGreaterThanOrEqual(6)
    expect(stripsOnScreen(1280)).toBeGreaterThanOrEqual(8)
    expect(columnRightEdge(3)).toBeLessThanOrEqual(360)
    expect(columnRightEdge(4)).toBeLessThanOrEqual(390)
    expect(columnsOnScreen(360)).toBeGreaterThanOrEqual(3)
    expect(columnsOnScreen(390)).toBeGreaterThanOrEqual(4)
    expect(columnsOnScreen(673)).toBeGreaterThanOrEqual(6)
    expect(columnsOnScreen(1280)).toBeGreaterThanOrEqual(8)
  })

  it('clamps drag, pinch, and keys to the min and max', () => {
    expect(widthFromDrag(STRIP_DEFAULT, 500, STRIP_BOUNDS)).toBe(STRIP_MAX)
    expect(widthFromDrag(STRIP_DEFAULT, -500, STRIP_BOUNDS)).toBe(STRIP_MIN)
    expect(widthFromDrag(80, 10.4, STRIP_BOUNDS)).toBe(90)
    expect(widthFromDrag(Number.NaN, 10, STRIP_BOUNDS)).toBe(STRIP_DEFAULT)
    expect(widthFromPinch(100, 100, 250, STRIP_BOUNDS)).toBe(240)
    expect(widthFromPinch(100, 100, 20, STRIP_BOUNDS)).toBe(STRIP_MIN)
    expect(widthFromPinch(88, 0, 40, STRIP_BOUNDS)).toBe(88)
    expect(widthFromPinch(88, 40, 0, COLUMN_BOUNDS)).toBe(88)
    expect(widthFromKey(70, 'ArrowRight', COLUMN_BOUNDS)).toBe(74)
    expect(widthFromKey(70, 'ArrowLeft', COLUMN_BOUNDS, 16)).toBe(COLUMN_MIN)
    expect(widthFromKey(70, 'Home', COLUMN_BOUNDS)).toBe(COLUMN_MIN)
    expect(widthFromKey(70, 'End', COLUMN_BOUNDS)).toBe(COLUMN_MAX)
    expect(widthFromKey(70, 'Enter', COLUMN_BOUNDS)).toBeNull()
  })

  it('keeps each project width, survives a bad save, and resets one axis', () => {
    const store = memory()
    expect(readLayout('prj_a', store)).toEqual(defaultLayout())
    writeLayout('prj_a', { strip: 140, column: 110, mixer: null }, store)
    writeLayout('prj_b', { strip: 10, column: 999, mixer: 'rows' }, store)
    expect(readLayout('prj_a', store)).toEqual({ strip: 140, column: 110, mixer: null })
    expect(readLayout('prj_b', store)).toEqual({ strip: STRIP_MIN, column: COLUMN_MAX, mixer: 'rows' })
    expect(layoutStorageKey('prj_a')).not.toBe(layoutStorageKey('prj_b'))

    const kept = withStrip(readLayout('prj_a', store), STRIP_DEFAULT)
    expect(kept).toEqual({ strip: STRIP_DEFAULT, column: 110, mixer: null })
    expect(withColumn(kept, COLUMN_DEFAULT)).toEqual(defaultLayout())
    const rows = withMixer(kept, 'rows')
    expect(rows.mixer).toBe('rows')
    expect(withStrip(rows, 140).mixer).toBe('rows')

    store.setItem(layoutStorageKey('prj_c'), '{')
    expect(readLayout('prj_c', store)).toEqual(defaultLayout())
    store.setItem(layoutStorageKey('prj_d'), JSON.stringify({ strip: 'wide', column: 80 }))
    expect(readLayout('prj_d', store)).toEqual({ strip: STRIP_DEFAULT, column: 80, mixer: null })
    expect(normalizeLayout(null)).toEqual(defaultLayout())
    expect(normalizeLayout({ mixer: 'rows' }).mixer).toBe('rows')
    expect(normalizeLayout({ mixer: 'grid' }).mixer).toBeNull()
    expect(isNarrowStrip(STRIP_HALF)).toBe(true)
    expect(isNarrowStrip(STRIP_DEFAULT)).toBe(false)
    expect(mixerFlow(null, 412, 915)).toBe('rows')
    expect(mixerFlow(null, 1920, 1080)).toBe('columns')
    expect(mixerFlow(null, 844, 390)).toBe('columns')
    expect(mixerFlow('columns', 412, 915)).toBe('columns')
    expect(mixerFlow('rows', 1440, 900)).toBe('rows')
    expect(STRIP_MIN).toBe(STRIP_HALF)
    expect(STRIP_HALF).toBe(Math.round(STRIP_DEFAULT / 2))
    expect(displayedStrip(STRIP_DEFAULT, 80)).toBe(STRIP_HALF)
    expect(displayedStrip(140, 1280)).toBe(140)
    expect(sessionTableWidth(3, 70)).toBeGreaterThan(columnRightEdge(3))
  })
})

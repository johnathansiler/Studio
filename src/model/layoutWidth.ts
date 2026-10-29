/** Mixer strip and session column widths. Chrome numbers match the layout CSS. */

export const STRIP_MIN = 64
export const STRIP_MAX = 240
/** Narrow enough that a 360px phone shows three channel strips and a 390px phone shows four. */
export const STRIP_DEFAULT = 84

export const COLUMN_MIN = 60
export const COLUMN_MAX = 240
/** Narrow enough that a 360px phone shows three clip columns and a 390px phone shows four. */
export const COLUMN_DEFAULT = 70

export const MIXER_PAD = 0
export const STRIP_GAP = 6
export const SESSION_PAD = 8
export const SESSION_GAP = 6
export const SCENE_COL = 48
export const ADD_COL = 48

export interface WidthBounds {
  min: number
  max: number
  fallback: number
}

export const STRIP_BOUNDS: WidthBounds = { min: STRIP_MIN, max: STRIP_MAX, fallback: STRIP_DEFAULT }
export const COLUMN_BOUNDS: WidthBounds = { min: COLUMN_MIN, max: COLUMN_MAX, fallback: COLUMN_DEFAULT }

export interface LayoutWidths {
  strip: number
  column: number
}

export function defaultLayout(): LayoutWidths {
  return { strip: STRIP_DEFAULT, column: COLUMN_DEFAULT }
}

export function clampWidth(value: number, bounds: WidthBounds): number {
  if (!Number.isFinite(value)) return bounds.fallback
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)))
}

export function normalizeLayout(input: unknown): LayoutWidths {
  const raw = input && typeof input === 'object' ? input as { strip?: unknown; column?: unknown } : {}
  return {
    strip: clampWidth(typeof raw.strip === 'number' ? raw.strip : STRIP_DEFAULT, STRIP_BOUNDS),
    column: clampWidth(typeof raw.column === 'number' ? raw.column : COLUMN_DEFAULT, COLUMN_BOUNDS),
  }
}

export function withStrip(layout: LayoutWidths, strip: number): LayoutWidths {
  return normalizeLayout({ ...layout, strip })
}

export function withColumn(layout: LayoutWidths, column: number): LayoutWidths {
  return normalizeLayout({ ...layout, column })
}

export function widthFromDrag(start: number, delta: number, bounds: WidthBounds): number {
  if (!Number.isFinite(start) || !Number.isFinite(delta)) return clampWidth(start, bounds)
  return clampWidth(start + delta, bounds)
}

export function widthFromPinch(start: number, startDistance: number, nextDistance: number, bounds: WidthBounds): number {
  if (!(startDistance > 0) || !Number.isFinite(nextDistance) || nextDistance <= 0) return clampWidth(start, bounds)
  return clampWidth(start * (nextDistance / startDistance), bounds)
}

export function widthFromKey(value: number, key: string, bounds: WidthBounds, step = 4): number | null {
  if (key === 'ArrowRight' || key === 'ArrowUp') return clampWidth(value + step, bounds)
  if (key === 'ArrowLeft' || key === 'ArrowDown') return clampWidth(value - step, bounds)
  if (key === 'PageUp') return clampWidth(value + step * 4, bounds)
  if (key === 'PageDown') return clampWidth(value - step * 4, bounds)
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  return null
}

/** Right edge of the nth channel strip, including mixer padding. */
export function stripRightEdge(count: number, strip = STRIP_DEFAULT): number {
  if (count <= 0) return 0
  return MIXER_PAD + count * strip + (count - 1) * STRIP_GAP + MIXER_PAD
}

export function stripsOnScreen(viewport: number, strip = STRIP_DEFAULT): number {
  let count = 0
  for (let n = 1; n <= 64; n++) {
    if (stripRightEdge(n, strip) <= viewport) count = n
    else break
  }
  return count
}

/** Right edge of the nth track column, including the scene column, gaps, and session padding. */
export function columnRightEdge(count: number, column = COLUMN_DEFAULT): number {
  if (count <= 0) return 0
  const lead = SESSION_PAD + SESSION_GAP + SCENE_COL + SESSION_GAP
  return lead + count * column + (count - 1) * SESSION_GAP
}

export function columnsOnScreen(viewport: number, column = COLUMN_DEFAULT): number {
  let count = 0
  for (let n = 1; n <= 64; n++) {
    if (columnRightEdge(n, column) <= viewport) count = n
    else break
  }
  return count
}

/** Table width for fixed layout: scene + tracks + add column, plus border spacing. */
export function sessionTableWidth(trackCount: number, column = COLUMN_DEFAULT): number {
  const columns = Math.max(0, trackCount) + 2
  return SCENE_COL + Math.max(0, trackCount) * column + ADD_COL + SESSION_GAP * (columns + 1)
}

export interface LayoutMemory {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function layoutStorageKey(projectId: string) {
  return `cueharbor-layout:${projectId}`
}

const memoryFallback = new Map<string, string>()
let resolved: LayoutMemory | null = null

function mapMemory(map: Map<string, string>): LayoutMemory {
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

export function layoutMemory(): LayoutMemory {
  if (resolved) return resolved
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__cueharbor_layout__'
      localStorage.setItem(probe, '1')
      localStorage.removeItem(probe)
      resolved = localStorage
      return resolved
    }
  } catch {
    /* private mode keeps the widths for this tab */
  }
  resolved = mapMemory(memoryFallback)
  return resolved
}

export function readLayout(projectId: string, storage: LayoutMemory = layoutMemory()): LayoutWidths {
  try {
    const raw = storage.getItem(layoutStorageKey(projectId))
    if (!raw) return defaultLayout()
    return normalizeLayout(JSON.parse(raw) as unknown)
  } catch {
    return defaultLayout()
  }
}

export function writeLayout(projectId: string, layout: LayoutWidths, storage: LayoutMemory = layoutMemory()): LayoutWidths {
  const clean = normalizeLayout(layout)
  try {
    storage.setItem(layoutStorageKey(projectId), JSON.stringify(clean))
  } catch {
    /* the open view still uses the width the user just set */
  }
  return clean
}

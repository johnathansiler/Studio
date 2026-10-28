import type { FormFactor } from './form'

/** Persisted mixer strip width and session column width. */
export const LAYOUT_KEY = 'cueharbor-layout'

export type LayoutKind = 'strip' | 'slot'

export interface Bounds {
  min: number
  max: number
}

export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Channel strips used to be 168px, which showed about two channels on a phone. */
export function defaultStrip(form: FormFactor): number {
  if (form === 'phone') return 100
  if (form === 'fold') return 116
  return 128
}

/** Session slots used to stretch across the pane (88px minimum). */
export function defaultSlot(form: FormFactor): number {
  if (form === 'phone') return 72
  if (form === 'fold') return 88
  return 104
}

export function stripBounds(form: FormFactor, viewport = 1280): Bounds {
  if (form === 'phone') return ordered(76, Math.min(180, Math.max(112, Math.round(viewport * 0.46))))
  if (form === 'fold') return ordered(88, 220)
  return ordered(96, 260)
}

export function slotBounds(form: FormFactor, viewport = 1280): Bounds {
  if (form === 'phone') return ordered(56, Math.min(160, Math.max(88, Math.round(viewport * 0.5))))
  if (form === 'fold') return ordered(64, 220)
  return ordered(72, 320)
}

export function clampWidth(value: number, bounds: Bounds): number {
  if (!Number.isFinite(value)) return bounds.min
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)))
}

export function resizeWidth(start: number, delta: number, bounds: Bounds): number {
  return clampWidth(start + delta, bounds)
}

export function displayWidth(stored: number | null, fallback: number, bounds: Bounds): number {
  return clampWidth(stored ?? fallback, bounds)
}

/** Arrow keys nudge by 8px, Shift by 24. Home and End jump to the limits. */
export function nudgeWidth(value: number, key: string, bounds: Bounds, shift = false): number | null {
  const step = shift ? 24 : 8
  if (key === 'ArrowRight' || key === 'ArrowUp') return resizeWidth(value, step, bounds)
  if (key === 'ArrowLeft' || key === 'ArrowDown') return resizeWidth(value, -step, bounds)
  if (key === 'Home') return bounds.min
  if (key === 'End') return bounds.max
  return null
}

function ordered(min: number, max: number): Bounds {
  return { min, max: Math.max(min, max) }
}

function readAll(storage: LayoutStorage | null): Record<string, unknown> {
  if (!storage) return {}
  try {
    const raw = storage.getItem(LAYOUT_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

export function readLayoutValue(storage: LayoutStorage | null, kind: LayoutKind): number | null {
  const value = readAll(storage)[kind]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function writeLayoutValue(storage: LayoutStorage | null, kind: LayoutKind, value: number) {
  if (!storage || !Number.isFinite(value)) return
  try {
    const current = readAll(storage)
    current[kind] = Math.round(value)
    storage.setItem(LAYOUT_KEY, JSON.stringify(current))
  } catch {
    /* private mode keeps the in-memory width */
  }
}

export function clearLayoutValue(storage: LayoutStorage | null, kind: LayoutKind) {
  if (!storage) return
  try {
    const current = readAll(storage)
    delete current[kind]
    storage.setItem(LAYOUT_KEY, JSON.stringify(current))
  } catch {
    /* private mode keeps the in-memory width */
  }
}

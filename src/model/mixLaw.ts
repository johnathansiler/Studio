/**
 * Continuous pan and mixer-fader mapping.
 * Pan is stored as −1..+1 (the −100..+100 the knob shows).
 * Mixer level is stored as linear gain and edited in decibels.
 * Other knobs keep the integer detent in dragNumeric.
 */

import { isMixerFader, type DefaultQuery } from '../ui/paramDefaults'

export type MixLaw = 'pan' | 'db'

/** Pixels of finger travel for one pan unit on a normal drag. */
export const PAN_PX = 2
/** Fine drag (Shift, a second finger, or a slow/crossed phone drag) is this many times slower. */
export const PAN_FINE_SCALE = 4
/**
 * Magnetic center, in pan units (−100..+100).
 * Anything outside this, including −3 and +2, is left alone.
 */
export const PAN_CENTER_STICK = 0.05

/** Mixer faders move in tenths of a decibel. */
export const DB_STEP = 0.1
/** Pixels of finger travel for one 0.1 dB step on a normal drag. */
export const DB_PX = 2
export const DB_FINE_SCALE = 4
/** Bottom of a fader drag. Below this the stored gain is silence. */
export const DB_FLOOR = -60

export function controlLaw(q: Pick<DefaultQuery, 'label' | 'title' | 'className' | 'param' | 'target' | 'min' | 'max'>): MixLaw | null {
  const bag = words(`${q.label || ''} ${q.title || ''} ${q.className || ''} ${q.param || ''} ${q.target || ''}`)
  const bipolar = q.min < -1e-6 && q.max > 1e-6 && q.max - q.min <= 2.5
  if (bipolar && bag.includes('pan')) return 'pan'
  if (isMixerFader(q)) return 'db'
  return null
}

export function panPixels(units: number, fine = false): number {
  return units * PAN_PX * (fine ? PAN_FINE_SCALE : 1)
}

export function dbPixels(db: number, fine = false): number {
  return (db / DB_STEP) * DB_PX * (fine ? DB_FINE_SCALE : 1)
}

/** Stored −1..+1 as a −100..+100 readout. Fractions keep one decimal. */
export function formatPan(stored: number): string {
  const percent = roundTo(stored * 100, 1)
  if (!Number.isFinite(percent) || Math.abs(percent) < 0.05) return 'Center'
  const abs = Math.abs(percent)
  const text = Math.abs(abs - Math.round(abs)) < 0.05 ? String(Math.round(abs)) : abs.toFixed(1)
  return percent < 0 ? `Left ${text}` : `Right ${text}`
}

export function dbFromGain(gain: number): number {
  if (!(gain > 0)) return Number.NEGATIVE_INFINITY
  return 20 * Math.log10(gain)
}

export function gainFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0
  return 10 ** (db / 20)
}

export function quantizeDb(db: number, step = DB_STEP): number {
  if (!Number.isFinite(db)) return db
  return roundTo(quantize(db, step), 1)
}

/** Finger delta → stored pan. `fine` keeps tenths of a pan unit. */
export function dragPan(input: { origin: number; deltaPx: number; min?: number; max?: number; fine?: boolean }): number {
  const min = input.min ?? -1
  const max = input.max ?? 1
  if (!input.deltaPx) return clamp(input.origin, min, max)
  const scale = input.fine ? PAN_PX * PAN_FINE_SCALE : PAN_PX
  let percent = clamp(input.origin, min, max) * 100 + input.deltaPx / scale
  percent = clamp(percent, min * 100, max * 100)
  if (Math.abs(percent) <= PAN_CENTER_STICK) percent = 0
  else percent = quantize(percent, input.fine ? 0.1 : 1)
  return clamp(percent / 100, min, max)
}

/** Finger delta → linear gain at 0.1 dB. A zero delta keeps a saved gain unchanged. */
export function dragGain(input: { origin: number; deltaPx: number; min: number; max: number; fine?: boolean }): number {
  const min = input.min
  const max = input.max
  const origin = clamp(input.origin, min, max)
  if (!input.deltaPx) return origin
  const minDb = min <= 1e-6 ? DB_FLOOR : dbFromGain(min)
  const maxDb = dbFromGain(Math.max(max, 1e-6))
  const originDb = origin <= 1e-6 ? minDb : dbFromGain(origin)
  const px = input.fine ? DB_PX * DB_FINE_SCALE : DB_PX
  let db = quantizeDb(originDb + (input.deltaPx / px) * DB_STEP)
  if (db < minDb) db = minDb
  if (db > maxDb) db = maxDb
  if (min <= 0 && db <= DB_FLOOR) return min <= 0 ? Math.max(min, 0) : min
  return clamp(gainFromDb(db), min, max)
}

/** Typed decibels → linear gain inside the fader range. */
export function gainForDb(db: number, min: number, max: number): number {
  if (!Number.isFinite(db)) return clamp(min, min, max)
  const maxDb = dbFromGain(Math.max(max, 1e-6))
  const next = quantizeDb(Math.min(maxDb, Math.max(DB_FLOOR, db)))
  return clamp(gainFromDb(next), min, max)
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

function quantize(value: number, quantum: number): number {
  const scaled = value / quantum
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled))
  return roundTo(rounded * quantum, quantum < 1 ? 1 : 0)
}

function roundTo(value: number, places: number): number {
  const scale = 10 ** places
  return Math.round((value + Math.sign(value) * 1e-9) * scale) / scale
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

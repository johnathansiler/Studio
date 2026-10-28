/** Sounds panel width. The column shrinks the arrange view; phones use a sheet instead. */

export const SOUND_PANEL_MIN = 280
export const SOUND_PANEL_MAX = 560
export const SOUND_PANEL_DEFAULT = 360
export const SOUND_WIDTH_KEY = 'cueharbor-sounds-width'

/** Leave the timeline at least this much room beside the panel. */
const TIMELINE_ROOM = 320

export interface SoundWidthMemory {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const memoryFallback = new Map<string, string>()
let resolved: SoundWidthMemory | null = null

function mapMemory(map: Map<string, string>): SoundWidthMemory {
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

export function soundWidthMemory(): SoundWidthMemory {
  if (resolved) return resolved
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__cueharbor_sounds_width__'
      localStorage.setItem(probe, '1')
      localStorage.removeItem(probe)
      resolved = localStorage
      return resolved
    }
  } catch {
    /* private mode keeps the width for this tab */
  }
  resolved = mapMemory(memoryFallback)
  return resolved
}

export function soundPanelMax(viewport: number, reserved = 0) {
  const room = Number.isFinite(viewport) ? viewport : 1280
  const aside = Number.isFinite(reserved) && reserved > 0 ? reserved : 0
  return Math.min(SOUND_PANEL_MAX, Math.max(SOUND_PANEL_MIN, Math.round(room - TIMELINE_ROOM - aside)))
}

export function clampSoundWidth(value: number, viewport = 1280, reserved = 0) {
  const max = soundPanelMax(viewport, reserved)
  if (!Number.isFinite(value)) return Math.min(SOUND_PANEL_DEFAULT, max)
  return Math.min(max, Math.max(SOUND_PANEL_MIN, Math.round(value)))
}

export function soundWidthFromDrag(start: number, delta: number, viewport = 1280, reserved = 0) {
  if (!Number.isFinite(start) || !Number.isFinite(delta)) return clampSoundWidth(start, viewport, reserved)
  return clampSoundWidth(start + delta, viewport, reserved)
}

export function readSoundWidth(storage: SoundWidthMemory = soundWidthMemory(), viewport = 1280, reserved = 0) {
  try {
    const raw = storage.getItem(SOUND_WIDTH_KEY)
    if (!raw) return clampSoundWidth(SOUND_PANEL_DEFAULT, viewport, reserved)
    return clampSoundWidth(Number(raw), viewport, reserved)
  } catch {
    return clampSoundWidth(SOUND_PANEL_DEFAULT, viewport, reserved)
  }
}

export function writeSoundWidth(value: number, storage: SoundWidthMemory = soundWidthMemory(), viewport = 1280, reserved = 0) {
  const clean = clampSoundWidth(value, viewport, reserved)
  try {
    storage.setItem(SOUND_WIDTH_KEY, String(clean))
  } catch {
    /* the open panel still uses the width just set */
  }
  return clean
}

/** Total matches, and how many rows are on screen when the list is capped. */
export function matchCountLabel(total: number, shown: number) {
  const count = Math.max(0, Math.round(total))
  const visible = Math.max(0, Math.round(shown))
  if (count <= 0) return ''
  const noun = count === 1 ? 'match' : 'matches'
  if (visible < count) return `${count} ${noun}. Showing the first ${visible}.`
  return `${count} ${noun}.`
}

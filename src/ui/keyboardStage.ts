import type { FormFactor } from './form'

export const PIANO_HISTORY = 'piano'
export const PADS_HISTORY = 'pads'

export type EditorHistoryMark = typeof PIANO_HISTORY | typeof PADS_HISTORY

export function historyMark(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null
  const mark = (state as { cueharbor?: unknown }).cueharbor
  return typeof mark === 'string' ? mark : null
}

export function isHistoryMark(state: unknown, mark: string) {
  return historyMark(state) === mark
}

export function isPianoHistory(state: unknown) {
  return isHistoryMark(state, PIANO_HISTORY)
}

export function isPadsHistory(state: unknown) {
  return isHistoryMark(state, PADS_HISTORY)
}

export function isEditorHistory(state: unknown) {
  const mark = historyMark(state)
  return mark === PIANO_HISTORY || mark === PADS_HISTORY
}

/** Push one history entry so the Android back gesture closes the piano roll. */
export function markPianoHistory(history: { state: unknown; pushState: (data: unknown, unused: string) => void }) {
  if (isPianoHistory(history.state)) return false
  history.pushState({ cueharbor: PIANO_HISTORY }, '')
  return true
}

/**
 * Opening one editor replaces the other's history entry.
 * Closing the last editor goes back. Staying put does nothing.
 */
export function editorHistoryStep(current: EditorHistoryMark | null, next: EditorHistoryMark | null): 'keep' | 'push' | 'replace' | 'back' {
  if (current === next) return 'keep'
  if (next && current) return 'replace'
  if (next) return 'push'
  return 'back'
}

/** locked: the screen itself turned. shell: the browser could not lock, so the whole app shell turns. dock: already landscape, or not a phone. */
export type KeyboardPresentation = 'locked' | 'shell' | 'dock'

export interface LandscapeHost {
  form: FormFactor
  portrait: boolean
  fullscreenEnabled: boolean
  fullscreenElement: Element | null
  requestFullscreen: () => Promise<void>
  exitFullscreen: () => Promise<void>
  lock?: (kind: 'landscape') => Promise<void>
  unlock?: () => void
}

export interface CloseFollow {
  /**
   * True after a real orientation unlock. The landscape layout stays until the
   * device reports portrait. Browsers cannot read the OS auto-rotate switch:
   * if auto-rotate is off, that portrait event never arrives and the phone stays landscape.
   */
  holdLandscape: boolean
}

/**
 * Phones open the keyboard across the whole app, not only the dock.
 * Fullscreen plus screen.orientation.lock('landscape') when the browser allows it.
 * When that lock is impossible, the caller rotates the whole app shell.
 */
export async function presentKeyboard(host: LandscapeHost): Promise<KeyboardPresentation> {
  if (host.form !== 'phone') return 'dock'
  if (!host.portrait) return 'dock'
  if (host.fullscreenEnabled && host.lock) {
    let entered = false
    try {
      if (!host.fullscreenElement) {
        await host.requestFullscreen()
        entered = true
      }
      await host.lock('landscape')
      return 'locked'
    } catch {
      if (entered) {
        try { await host.exitFullscreen() } catch { /* already left fullscreen */ }
      }
    }
  }
  return 'shell'
}

export async function dismissKeyboard(host: LandscapeHost, presentation: KeyboardPresentation): Promise<CloseFollow> {
  if (presentation !== 'locked') return { holdLandscape: false }
  try { host.unlock?.() } catch { /* already unlocked */ }
  if (host.fullscreenElement) {
    try { await host.exitFullscreen() } catch { /* already left fullscreen */ }
  }
  return { holdLandscape: true }
}

/** A portrait reading is the only signal that auto-rotate brought the phone back. */
export function portraitReported(type?: string | null, angle?: number | null): boolean {
  if (type && /portrait/i.test(type)) return true
  if (angle === 0 || angle === 180) return true
  return false
}

/**
 * After unlock, keep landscape until a portrait orientation change is reported.
 * A missing report means the phone has not rotated back (auto-rotate off, or still held sideways).
 */
export function keepLandscapeAfterClose(holdLandscape: boolean, report: { type?: string | null; angle?: number | null } | null): boolean {
  if (!holdLandscape) return false
  if (!report) return true
  return !portraitReported(report.type, report.angle)
}

let presenter: ((on: boolean) => void) | null = null

/** The shell registers this so a Keyboard click can lock orientation inside the gesture. */
export function setKeyboardPresenter(fn: ((on: boolean) => void) | null) {
  presenter = fn
}

export function notifyKeyboard(on: boolean) {
  presenter?.(on)
}

let pianoHider: (() => void) | null = null

/** The shell registers this so opening the small keyboard can close the piano roll in the same click. */
export function setPianoHider(fn: (() => void) | null) {
  pianoHider = fn
}

export function hidePianoRoll() {
  pianoHider?.()
}

export function browserLandscapeHost(root: HTMLElement | null, form: FormFactor, portrait: boolean): LandscapeHost {
  const orientation = typeof screen === 'undefined' ? undefined : screen.orientation as {
    lock?: (kind: 'landscape') => Promise<void>
    unlock?: () => void
  } | undefined
  const lock = orientation && typeof orientation.lock === 'function' ? orientation.lock.bind(orientation) : undefined
  const unlock = orientation && typeof orientation.unlock === 'function' ? orientation.unlock.bind(orientation) : undefined
  return {
    form,
    portrait,
    fullscreenEnabled: typeof document !== 'undefined' && document.fullscreenEnabled === true && !!root,
    fullscreenElement: typeof document !== 'undefined' ? document.fullscreenElement : null,
    requestFullscreen: () => (root ? root.requestFullscreen() : Promise.reject(new Error('no root'))),
    exitFullscreen: () => document.exitFullscreen(),
    lock: lock ? (kind) => lock(kind) : undefined,
    unlock,
  }
}

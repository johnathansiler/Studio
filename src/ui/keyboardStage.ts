import type { FormFactor } from './form'

export const PIANO_HISTORY = 'piano'

export function isPianoHistory(state: unknown) {
  return !!state && typeof state === 'object' && (state as { cueharbor?: string }).cueharbor === PIANO_HISTORY
}

/** Push one history entry so the Android back gesture closes the piano roll. */
export function markPianoHistory(history: { state: unknown; pushState: (data: unknown, unused: string) => void }) {
  if (isPianoHistory(history.state)) return false
  history.pushState({ cueharbor: PIANO_HISTORY }, '')
  return true
}

export type KeyboardPresentation = 'locked' | 'turned' | 'dock'

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

/**
 * Phones open the keyboard the long way. Fullscreen plus an orientation lock
 * when the browser allows it. Otherwise a portrait phone turns the dock.
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
  return 'turned'
}

export async function dismissKeyboard(host: LandscapeHost, presentation: KeyboardPresentation) {
  if (presentation !== 'locked') return
  try { host.unlock?.() } catch { /* already unlocked */ }
  if (host.fullscreenElement) {
    try { await host.exitFullscreen() } catch { /* already left fullscreen */ }
  }
}

let presenter: ((on: boolean) => void) | null = null

/** The shell registers this so a Keyboard click can lock orientation inside the gesture. */
export function setKeyboardPresenter(fn: ((on: boolean) => void) | null) {
  presenter = fn
}

export function notifyKeyboard(on: boolean) {
  presenter?.(on)
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

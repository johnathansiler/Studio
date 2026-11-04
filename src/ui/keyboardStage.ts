import type { FormFactor } from './form'

export const PIANO_HISTORY = 'piano'
export const PADS_HISTORY = 'pads'
export const STEPS_HISTORY = 'steps'

export type EditorHistoryMark = typeof PIANO_HISTORY | typeof PADS_HISTORY | typeof STEPS_HISTORY

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
  return mark === PIANO_HISTORY || mark === PADS_HISTORY || mark === STEPS_HISTORY
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

/** Sideways lock. Generic landscape is allowed; the secondary (upside-down) lock is not. */
export const LANDSCAPE_LOCK = 'landscape-primary' as const

/** Upright restore. Camera at the top. Never the generic portrait lock, which can come back upside down. */
export const RESTORE_LOCK = 'portrait-primary' as const

export type OrientationLockKind = typeof LANDSCAPE_LOCK | 'landscape' | typeof RESTORE_LOCK

export interface OrientationHandle {
  lock?: (kind: OrientationLockKind) => Promise<void>
  unlock?: () => void | Promise<void>
  type?: string
  angle?: number
}

export interface LandscapeHost {
  form: FormFactor
  portrait: boolean
  fullscreenEnabled: boolean
  fullscreenElement: Element | null
  requestFullscreen: () => Promise<void>
  exitFullscreen: () => Promise<void>
  lock?: (kind: OrientationLockKind) => Promise<void>
  unlock?: () => void | Promise<void>
  /** Live screen.orientation, so a release can see whether unlock restored upright portrait. */
  orientation?: OrientationHandle | null
}

export interface CloseFollow {
  /**
   * True after a real orientation unlock. The sideways layout stays until the
   * device reports upright portrait (portrait-primary, angle 0). 180° is upside
   * down and does not count. Browsers cannot read the OS auto-rotate switch.
   */
  holdLandscape: boolean
}

export interface ReleaseResult {
  /** True when unlock left the phone sideways or upside down and portrait-primary was applied. */
  nudged: boolean
  exitedFullscreen: boolean
}

/** Remembered when this app locks the screen, and when it entered fullscreen to do that. */
let lockedByUs = false
let fullscreenByUs = false
let releaseTail: Promise<void> = Promise.resolve()

/** Test helper. Drops a lock left behind by an earlier case. */
export function forgetLandscapeLock() {
  lockedByUs = false
  fullscreenByUs = false
}

function normalizedAngle(angle: number | null | undefined): number | null {
  if (angle == null || !Number.isFinite(angle)) return null
  return ((Math.round(angle) % 360) + 360) % 360
}

/**
 * Upright portrait only: portrait-primary, or angle 0 when the type is not a landscape.
 * portrait-secondary and 180° are upside down (camera at the bottom) and are not upright.
 */
export function portraitReported(type?: string | null, angle?: number | null): boolean {
  const normalized = normalizedAngle(angle)
  if (type === 'portrait-secondary' || normalized === 180) return false
  if (type === 'portrait-primary') return normalized == null || normalized === 0
  if (type == null && normalized === 0) return true
  return false
}

/**
 * The keyboard shell turns sideways when the orientation lock is unavailable.
 * 180° is upside down, so it must not use that sideways turn or the upright layout.
 */
export function keyboardShellTurn(angle: number | null | undefined): 'landscape' | 'upside-down' {
  if (normalizedAngle(angle) === 180) return 'upside-down'
  return 'landscape'
}

function readOrientation(): OrientationHandle | null {
  if (typeof screen === 'undefined' || screen == null) return null
  const orientation = (screen as { orientation?: OrientationHandle | null }).orientation
  if (!orientation || typeof orientation !== 'object') return null
  return orientation
}

function readFullscreenElement(): Element | null {
  if (typeof document === 'undefined' || document == null) return null
  return document.fullscreenElement ?? null
}

async function attempt(run: (() => void | Promise<void>) | null | undefined): Promise<boolean> {
  if (!run) return false
  try {
    await run()
    return true
  } catch {
    return false
  }
}

/**
 * Undo a landscape lock taken for the keyboard or a phone editor.
 * Missing screen.orientation (iOS Safari) and rejected promises are ignored.
 * Fullscreen ends only when this app entered it in order to lock.
 * When unlock leaves the phone sideways or upside down, lock portrait-primary
 * briefly, then unlock, so the device's auto-rotate setting applies again.
 * The portrait-primary lock runs while fullscreen is still up, because many
 * phones reject orientation.lock after fullscreen has already ended.
 */
export function releaseOrientation(source?: {
  orientation?: OrientationHandle | null
  fullscreenElement?: Element | null
  exitFullscreen?: (() => Promise<void>) | null
}): Promise<ReleaseResult> {
  const run = releaseTail.then(() => releaseOrientationNow(source), () => releaseOrientationNow(source))
  releaseTail = run.then(() => undefined, () => undefined)
  return run
}

async function releaseOrientationNow(source?: {
  orientation?: OrientationHandle | null
  fullscreenElement?: Element | null
  exitFullscreen?: (() => Promise<void>) | null
}): Promise<ReleaseResult> {
  const orientation = source && 'orientation' in source ? source.orientation ?? null : readOrientation()
  const oweLock = lockedByUs
  const oweFullscreen = fullscreenByUs
  await attempt(orientation && typeof orientation.unlock === 'function' ? () => orientation.unlock!() : undefined)

  let nudged = false
  if (oweLock && !portraitReported(orientation?.type, orientation?.angle)) {
    nudged = await nudgeUpright(orientation)
  }

  let exitedFullscreen = false
  let fullscreenElement = source && 'fullscreenElement' in source ? source.fullscreenElement ?? null : readFullscreenElement()
  if (oweFullscreen && !fullscreenElement) fullscreenElement = readFullscreenElement()
  const exitFullscreen = (source && source.exitFullscreen) || (typeof document !== 'undefined' && document?.exitFullscreen ? () => document.exitFullscreen() : null)
  if (oweFullscreen && fullscreenElement && exitFullscreen) {
    exitedFullscreen = await attempt(() => exitFullscreen())
  }

  if (oweLock && !nudged && !portraitReported(orientation?.type, orientation?.angle)) {
    nudged = await nudgeUpright(orientation)
  }

  if (!oweLock || nudged || portraitReported(orientation?.type, orientation?.angle) || typeof orientation?.lock !== 'function') {
    lockedByUs = false
  }
  if (!oweFullscreen || exitedFullscreen || !fullscreenElement) fullscreenByUs = false
  return { nudged, exitedFullscreen }
}

async function nudgeUpright(orientation: OrientationHandle | null): Promise<boolean> {
  if (!orientation || typeof orientation.lock !== 'function') return false
  const locked = await attempt(() => orientation.lock!(RESTORE_LOCK))
  if (!locked) return false
  await attempt(typeof orientation.unlock === 'function' ? () => orientation.unlock!() : undefined)
  return true
}

/**
 * Phones open the keyboard across the whole app, not only the dock.
 * Fullscreen plus screen.orientation.lock('landscape-primary') when the browser allows it.
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
      await host.lock(LANDSCAPE_LOCK)
      lockedByUs = true
      fullscreenByUs = entered
      return 'locked'
    } catch {
      lockedByUs = false
      fullscreenByUs = false
      if (entered) {
        try { await host.exitFullscreen() } catch { /* already left fullscreen */ }
      }
    }
  }
  return 'shell'
}

export async function dismissKeyboard(host: LandscapeHost, presentation: KeyboardPresentation): Promise<CloseFollow> {
  await releaseOrientation({
    orientation: host.orientation ?? { lock: host.lock, unlock: host.unlock },
    fullscreenElement: host.fullscreenElement,
    exitFullscreen: () => host.exitFullscreen(),
  })
  return { holdLandscape: presentation === 'locked' }
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
  const orientation = readOrientation()
  const lock = orientation && typeof orientation.lock === 'function' ? orientation.lock.bind(orientation) : undefined
  const unlock = orientation && typeof orientation.unlock === 'function' ? orientation.unlock.bind(orientation) : undefined
  const fullscreenElement = readFullscreenElement()
  return {
    form,
    portrait,
    fullscreenEnabled: typeof document !== 'undefined' && document.fullscreenEnabled === true && !!root,
    fullscreenElement,
    requestFullscreen: () => (root ? root.requestFullscreen() : Promise.reject(new Error('no root'))),
    exitFullscreen: () => document.exitFullscreen(),
    lock: lock ? (kind) => lock(kind) : undefined,
    unlock,
    orientation,
  }
}

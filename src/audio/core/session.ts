/** Device audio state. `interrupted` is the iOS name for a phone call or Siri. */
export type DeviceAudioState = 'running' | 'suspended' | 'interrupted' | 'closed' | 'missing'

export type RecoveryAction = 'none' | 'resume' | 'rebuild'

export function audioStateOf(state: string | null | undefined): DeviceAudioState {
  if (state === 'running' || state === 'suspended' || state === 'interrupted' || state === 'closed') return state
  return 'missing'
}

/**
 * What to do when the audio device changes.
 * A hidden page waits. A suspended or interrupted device is resumed.
 * A closed device is rebuilt. The project document is never part of this decision.
 */
export function planRecovery(state: DeviceAudioState, visible: boolean): RecoveryAction {
  if (!visible) return 'none'
  if (state === 'closed' || state === 'missing') return 'rebuild'
  if (state === 'interrupted' || state === 'suspended') return 'resume'
  return 'none'
}

export interface SessionHold {
  playing: boolean
  positionSamples: number
  mode: 'arrangement' | 'session'
  projectHeld: boolean
}

/**
 * Recovery keeps the project and the playhead.
 * Playback starts again only after the device is actually running.
 */
export type InterruptionKind = 'call' | 'siri' | 'other-app' | 'screen-lock' | 'background' | 'none'
export type HiddenKind = 'tab' | 'lock'

export interface InterruptionInput {
  state: DeviceAudioState
  visible: boolean
  /** Mobile hide is treated as the screen locking. A desktop hide is a background tab. */
  hiddenKind?: HiddenKind
  ios?: boolean
  recording?: boolean
}

export interface InterruptionPlan {
  kind: InterruptionKind
  action: RecoveryAction
  pause: boolean
  keepPlayhead: boolean
  finalizeTake: boolean
  /** Empty when nothing happened. Shown as a status line, not a dialog. */
  notice: string
}

/**
 * Phone call, Siri, another app, screen lock, or a hidden tab.
 * The playhead is kept. A recording is finalized up to this moment.
 * A hidden page does not resume until it is visible again.
 */
export function planInterruption(input: InterruptionInput): InterruptionPlan {
  const kind = interruptionKind(input)
  const recording = input.recording === true
  const quiet = kind === 'none'
  const broken = input.state === 'interrupted' || input.state === 'suspended' || input.state === 'closed' || input.state === 'missing'
  return {
    kind,
    action: planRecovery(input.state, input.visible),
    pause: !quiet && (!input.visible || broken),
    keepPlayhead: true,
    finalizeTake: !quiet && recording,
    notice: quiet ? '' : interruptionNotice(kind, recording),
  }
}

export function interruptionKind(input: InterruptionInput): InterruptionKind {
  if (input.state === 'interrupted') return input.ios ? 'call' : 'other-app'
  if (!input.visible) return input.hiddenKind === 'lock' ? 'screen-lock' : 'background'
  return 'none'
}

export function interruptionNotice(kind: InterruptionKind, recording = false) {
  const kept = recording ? ' The take was kept up to the interruption.' : ''
  switch (kind) {
    case 'call':
    case 'siri':
      return `Audio paused for a call or Siri. The playhead stays.${kept}`
    case 'other-app':
      return `Another app took the audio. The playhead stays.${kept}`
    case 'screen-lock':
      return `Audio paused while the screen is locked. The playhead stays.${kept}`
    case 'background':
      return `Audio paused in the background. The playhead stays.${kept}`
    default:
      return ''
  }
}

export function sessionAfter(
  before: SessionHold,
  action: RecoveryAction,
  deviceRunning: boolean,
): SessionHold & { action: RecoveryAction; playing: boolean } {
  const playing = deviceRunning && before.playing && action !== 'none'
  return {
    action,
    projectHeld: true,
    positionSamples: before.positionSamples,
    mode: before.mode,
    playing,
  }
}

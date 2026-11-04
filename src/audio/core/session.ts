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

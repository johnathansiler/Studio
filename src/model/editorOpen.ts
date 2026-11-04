import { showsOpenBeatMachine } from '../instruments/pads/identity'

export type EditorGesture = 'select-track' | 'tap-clip' | 'edit-notes'
export type EditorSurface = 'keyboard' | 'piano' | 'pads' | 'steps' | 'none'

export function hasStepSequencer(track?: { plugins?: { pluginId: string }[] } | null): boolean {
  return !!track?.plugins?.some((plugin) => plugin.pluginId === 'steps')
}

export interface GestureTrack {
  instrument?: string
  plugins?: { pluginId: string; params?: Record<string, number> }[]
}

/**
 * A track header opens the one-octave keyboard. A Beat Machine header opens its pad panel.
 * Tapping a MIDI clip, including a clip on a Beat Machine track, opens the piano roll for that clip.
 * Edit Notes opens the piano roll. Audio clips have no notes, so a tap leaves the editors alone.
 */
export function editorForGesture(gesture: EditorGesture, trackType: string, track?: GestureTrack | null): EditorSurface {
  if (gesture === 'edit-notes' || gesture === 'tap-clip') return trackType === 'midi' ? 'piano' : 'none'
  if (trackType === 'midi' && gesture === 'select-track') {
    if (track && showsOpenBeatMachine({ type: 'midi', instrument: track.instrument, plugins: track.plugins })) return 'pads'
    if (track && hasStepSequencer(track)) return 'steps'
    return 'keyboard'
  }
  return 'none'
}

/** The one-octave keyboard and the piano roll never share the screen. */
export function noteEditorsAfterOpen(open: 'keyboard' | 'piano'): { keyboard: boolean; piano: boolean } {
  if (open === 'keyboard') return { keyboard: true, piano: false }
  return { keyboard: false, piano: true }
}

/** Close the small keyboard so the piano roll can take the screen, without bouncing back to Beat Machine. */
export function releaseKeyboardForPiano(store: {
  keyboardMidi: boolean
  clearKeyboardReturn(): void
  setKeyboardMidi(on: boolean): void
}): boolean {
  if (!store.keyboardMidi) return false
  store.clearKeyboardReturn()
  store.setKeyboardMidi(false)
  return true
}

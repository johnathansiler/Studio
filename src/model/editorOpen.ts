import { showsOpenBeatMachine } from '../instruments/pads/identity'

export type EditorGesture = 'select-track' | 'tap-clip' | 'edit-notes'
export type EditorSurface = 'keyboard' | 'piano' | 'pads' | 'none'

export interface GestureTrack {
  instrument?: string
  plugins?: { pluginId: string; params?: Record<string, number> }[]
}

/**
 * Selecting an instrument track, or tapping a MIDI clip, opens the one-octave keyboard.
 * A Beat Machine track opens its pad panel instead. Edit Notes opens the piano roll.
 */
export function editorForGesture(gesture: EditorGesture, trackType: string, track?: GestureTrack | null): EditorSurface {
  if (gesture === 'edit-notes') return trackType === 'midi' ? 'piano' : 'none'
  if (trackType === 'midi' && (gesture === 'select-track' || gesture === 'tap-clip')) {
    if (track && showsOpenBeatMachine({ type: 'midi', instrument: track.instrument, plugins: track.plugins })) return 'pads'
    return 'keyboard'
  }
  return 'none'
}

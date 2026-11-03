export type EditorGesture = 'select-track' | 'tap-clip' | 'edit-notes'
export type EditorSurface = 'keyboard' | 'piano' | 'none'

/**
 * Selecting an instrument track, or tapping a MIDI clip, opens the one-octave keyboard.
 * Edit Notes is the control that opens the piano roll.
 */
export function editorForGesture(gesture: EditorGesture, trackType: string): EditorSurface {
  if (gesture === 'edit-notes') return trackType === 'midi' ? 'piano' : 'none'
  if (trackType === 'midi' && (gesture === 'select-track' || gesture === 'tap-clip')) return 'keyboard'
  return 'none'
}

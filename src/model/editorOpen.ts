import { showsOpenBeatMachine } from '../instruments/pads/identity'

export type EditorGesture = 'select-track' | 'tap-clip' | 'edit-notes'
export type EditorSurface = 'keyboard' | 'piano' | 'pads' | 'steps' | 'bass' | 'patch' | 'rack' | 'scaler' | 'none'
export type InstrumentFace = 'pads' | 'steps' | 'bass' | 'patch' | 'rack' | 'scaler'

export function hasStepSequencer(track?: { plugins?: { pluginId: string }[] } | null): boolean {
  return !!track?.plugins?.some((plugin) => plugin.pluginId === 'steps')
}

export interface GestureTrack {
  instrument?: string
  plugins?: { pluginId: string; params?: Record<string, number> }[]
}

/**
 * The plugin that belongs on this MIDI track.
 * A bare Keys track (no instrument chosen yet) opens the patch. Audio has none.
 */
export function instrumentFace(track?: GestureTrack | null): InstrumentFace | null {
  if (!track) return null
  if (hasStepSequencer(track)) return 'steps'
  if (track.instrument === '808' || showsOpenBeatMachine({ type: 'midi', instrument: track.instrument, plugins: track.plugins })) return 'pads'
  const plugins = track.plugins ?? []
  if (track.instrument === 'bass808' || plugins.some((plugin) => plugin.pluginId === 'bass808')) return 'bass'
  if (track.instrument === 'scaler' || plugins.some((plugin) => plugin.pluginId === 'scaler')) return 'scaler'
  if (track.instrument === 'sampler' || track.instrument === 'library' || plugins.some((plugin) => plugin.pluginId === 'sampler')) return 'rack'
  if (track.instrument === 'none' || track.instrument == null) return null
  if (track.instrument === 'synth' || plugins.some((plugin) => plugin.pluginId === 'synth')) return 'patch'
  return null
}

/**
 * Tapping a track header or clip opens that track's instrument plugin.
 * Edit Notes is the only gesture that opens the piano roll.
 * A Step Sequencer track opens the sequencer. Audio has nothing to open.
 */
export function editorForGesture(gesture: EditorGesture, trackType: string, track?: GestureTrack | null): EditorSurface {
  if (trackType !== 'midi') return 'none'
  if (gesture === 'edit-notes') return hasStepSequencer(track) ? 'steps' : 'piano'
  return instrumentFace(track) ?? (gesture === 'tap-clip' ? 'piano' : 'keyboard')
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

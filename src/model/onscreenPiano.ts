/** Tracks that can be played from the on-screen piano. */

const TRACK_INSTRUMENTS = new Set([
  'synth',
  'sampler',
  '808',
  'drum-machine',
  'library',
  'scaler',
  'pads',
])

const PLUGIN_INSTRUMENTS = new Set([
  'synth',
  'sampler',
  'scaler',
  'steps',
  'pads',
  'drums',
  'drum-machine',
  '808',
])

export interface PianoTrack {
  type?: string
  instrument?: string
  plugins?: { pluginId: string; enabled?: boolean; params?: Record<string, number> }[]
}

/** Close a piano that is open on a track that cannot play it. */
export function shouldCloseOnscreenPiano(track: PianoTrack | null | undefined, open: boolean) {
  return open && !showsOnscreenPiano(track)
}

function playablePlugin(plugin: { pluginId: string; enabled?: boolean; params?: Record<string, number> }) {
  if (plugin.enabled === false) return false
  if (PLUGIN_INSTRUMENTS.has(plugin.pluginId)) return true
  return plugin.pluginId === 'sampler' && Math.round(plugin.params?.kind ?? 0) >= 1
}

/**
 * MIDI tracks play the built-in synth until an instrument is chosen.
 * `none` means nothing is loaded. Audio tracks never qualify.
 */
export function showsOnscreenPiano(track?: PianoTrack | null): boolean {
  if (!track || track.type !== 'midi') return false
  if (track.plugins?.some(playablePlugin)) return true
  if (track.instrument === 'none') return false
  if (track.instrument && TRACK_INSTRUMENTS.has(track.instrument)) return true
  return track.instrument == null
}

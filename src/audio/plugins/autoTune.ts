/** Auto-Tune insert helpers. The saved plugin id stays `tune`. */

export const TUNE_ID = 'tune'
export const TUNE_NAME = 'Auto-Tune'

/** Applied when a track insert is created without an explicit preset. */
export const TUNE_INSERT_PRESET = 'Hard tune/T-Pain'

export const TUNE_PRESET_NAMES = [
  'Hard tune/T-Pain',
  'Natural',
  'Soprano',
  'Alto/Tenor',
  'Low male',
  'Instrument',
] as const

/** Pairs of detected Hz, corrected Hz. Index 2k is detected, 2k+1 is the correction target. */
export const TUNE_TRACE_FRAMES = 64

export function tuneLiveHop(sampleRate: number) {
  return Math.max(128, Math.round(256 * (sampleRate / 48000)))
}

/** Output delay of the monitoring path: two hops, not the HQ analysis window. */
export function tuneLiveLatency(sampleRate: number) {
  return tuneLiveHop(sampleRate) * 2
}

/** Audio tracks see Auto-Tune first. Other tracks keep catalog order. */
export function orderedInserts<T extends { id: string }>(entries: readonly T[], audio: boolean): T[] {
  if (!audio) return [...entries]
  const index = entries.findIndex((item) => item.id === TUNE_ID)
  if (index <= 0) return [...entries]
  const next = [...entries]
  const [tune] = next.splice(index, 1)
  next.unshift(tune)
  return next
}

export function tuneOnTrack(plugins: readonly { id: string; pluginId: string; enabled: boolean }[]) {
  return plugins.find((plugin) => plugin.pluginId === TUNE_ID) ?? null
}

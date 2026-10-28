import type { AnalysisResult } from './types'

type Listener = () => void

let tracks = new Map<string, AnalysisResult>()
const listeners = new Set<Listener>()

function emit() {
  for (const listener of listeners) listener()
}

export function subscribeAnalysis(listener: Listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function rememberTrackAnalysis(trackId: string, result: AnalysisResult) {
  tracks = new Map(tracks)
  tracks.set(trackId, result)
  emit()
}

export function trackAnalysis(trackId: string) {
  return tracks.get(trackId) ?? null
}

export function summaryLine(result: AnalysisResult) {
  if (result.key.confidence <= 0 && !result.chordsByBar.length) return ''
  const chords = result.chordsByBar.slice(0, 6).map((chord) => chord.symbol).join(' ')
  return chords ? `${result.key.label} · ${chords}` : result.key.label
}

import type { AnalysisResult } from './types'

type Listener = () => void

let tracks = new Map<string, AnalysisResult>()
let snapshot: readonly AnalysisResult[] = []
const listeners = new Set<Listener>()

function emit() {
  snapshot = [...tracks.values()]
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

/** Stable until the next remember or forget, so a store subscription can compare it. */
export function cachedAnalyses(): readonly AnalysisResult[] {
  return snapshot
}

export function forgetAnalyses() {
  if (!tracks.size) return
  tracks = new Map()
  emit()
}

export function summaryLine(result: AnalysisResult) {
  if (result.key.confidence <= 0 && !result.chordsByBar.length) return ''
  const chords = result.chordsByBar.slice(0, 6).map((chord) => chord.symbol).join(' ')
  const name = result.key.alternative ? `${result.key.label} or ${result.key.alternative}` : result.key.label
  return chords ? `${name} · ${chords}` : name
}

/** The analysis-panel line. A relative key is named only when the center is not settled. */
export function analysisReadout(result: AnalysisResult) {
  if (result.key.confidence <= 0 && !result.chordsByBar.length) return 'Nothing to analyze on this track yet.'
  const line = `${result.key.label} · ${result.scale} · ${Math.round(result.tempo)} bpm`
  if (!result.key.alternative) return line
  return `${line} · ${Math.round(result.key.confidence * 100)}% · or ${result.key.alternative}`
}

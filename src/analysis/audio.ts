import { foldChroma, spectralFrames, tuningShift } from './chroma'
import { chordsForBars, estimateTempo, histogramFromFrames, keyFromHistogram, blankBars, accumulateBar } from './harmony'
import { monoMix } from './mix'
import { sectionsFromBars, type BarActivity } from './sections'
import type { AnalysisBuffer, AnalysisResult, TimeSig } from './types'

const DEFAULT_SIG: TimeSig = { numerator: 4, denominator: 4 }

export function beatsPerBar(sig: TimeSig) {
  const numerator = Math.max(1, sig.numerator || 4)
  const denominator = Math.max(1, sig.denominator || 4)
  return numerator * (4 / denominator)
}

function silentKey(tempo: number): AnalysisResult {
  return {
    key: { root: 0, name: 'C', mode: 'major', label: 'C major', confidence: 0 },
    scale: 'ionian',
    chordsByBar: [],
    sections: [],
    tempo,
  }
}

/** Key, chords, sections, and tempo for one piece of audio. */
export function analyzeAudio(buffer: AnalysisBuffer): AnalysisResult {
  const sig = buffer.timeSignature ?? DEFAULT_SIG
  const barBeats = beatsPerBar(sig)
  const samples = monoMix(buffer.channels)
  if (samples.length < 64 || !(buffer.sampleRate > 0)) return silentKey(buffer.tempo && buffer.tempo > 0 ? buffer.tempo : 120)
  const frames = spectralFrames(samples, buffer.sampleRate)
  if (!frames.length) return silentKey(buffer.tempo && buffer.tempo > 0 ? buffer.tempo : 120)
  const shift = tuningShift(frames)
  const tempo = buffer.tempo && buffer.tempo > 0 ? buffer.tempo : estimateTempo(frames)
  const seconds = samples.length / buffer.sampleRate
  const barCount = Math.max(1, Math.ceil(seconds / ((60 / tempo) * barBeats) - 1e-6))
  const bars = blankBars(barCount)
  const barSeconds = (60 / tempo) * barBeats
  for (const frame of frames) {
    const index = Math.min(barCount - 1, Math.max(0, Math.floor(frame.time / barSeconds)))
    const chroma = foldChroma(frame.fine, shift)
    accumulateBar(bars[index], chroma, frame.bass, frame.rms, frame.flux)
  }
  const hist = histogramFromFrames(frames, shift, foldChroma)
  const fitted = keyFromHistogram(hist)
  const { scale, ...key } = fitted
  const chordsByBar = chordsForBars(bars, barBeats, { root: fitted.root, scale: fitted.scale })
  const activity: BarActivity[] = bars.map((bar) => ({
    chroma: bar.chroma,
    energy: bar.energy,
    density: bar.flux,
    active: bar.energy > 1e-4 ? 1 : 0,
    mask: bar.energy > 1e-4 ? '1' : '0',
  }))
  return { key, scale, chordsByBar, sections: sectionsFromBars(activity, barBeats), tempo }
}

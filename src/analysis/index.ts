/**
 * Unstuck analysis.
 *
 * `analyzeProject` reads an arrangement. `analyzeAudio` reads a recording,
 * import, or stem. `transcribeHum` turns a hummed or sung melody into notes.
 * Audio FFT and pitch tracking are also available on a Web Worker via
 * `analyzeAudioInWorker`, `analyzeProjectInWorker`, and `transcribeHumInWorker`.
 * No model weights. Chroma, chord templates, and YIN / pYIN run locally.
 */

export { analyzeAudio } from './audio'
export { analyzeProject, beatAtSample } from './project'
export type { AnalysisAsset } from './project'
export { transcribeHum } from './pitch'
export { analyzeAudioInWorker, analyzeProjectInWorker, transcribeHumInWorker } from './job'
export { summaryLine } from './cache'
export type {
  AnalysisBuffer,
  AnalysisChord,
  AnalysisKey,
  AnalysisResult,
  AnalysisSection,
  HumNote,
  SectionKind,
  TimeSig,
  TranscribeOptions,
} from './types'

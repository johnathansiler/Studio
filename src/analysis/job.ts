import type { Project } from '../model/types'
import { analyzeAudio } from './audio'
import { analyzeProject, type AnalysisAsset } from './project'
import { transcribeHum } from './pitch'
import type { AnalysisBuffer, AnalysisResult, HumNote, TranscribeOptions } from './types'
import type { AnalysisRequest, AnalysisResponse } from './worker'

let worker: Worker | null = null
let nextId = 1

function client() {
  if (typeof Worker === 'undefined') return null
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return worker
}

function request(message: Omit<AnalysisRequest, 'id'>): Promise<AnalysisResponse> {
  const host = client()
  const id = nextId++
  if (!host) {
    return Promise.resolve({ id, type: 'error', message: 'No audio worker' })
  }
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<AnalysisResponse>) => {
      if (event.data?.id !== id) return
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
      if (event.data.type === 'error') reject(new Error(event.data.message || 'Analysis failed'))
      else resolve(event.data)
    }
    const onError = () => {
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
      reject(new Error('Analysis failed'))
    }
    host.addEventListener('message', onMessage)
    host.addEventListener('error', onError)
    host.postMessage({ ...message, id })
  })
}

function copyChannels(channels: ArrayLike<number> | ArrayLike<number>[]) {
  if (channels instanceof Float32Array) return [new Float32Array(channels)]
  if (Array.isArray(channels) && typeof channels[0] === 'number') return [Float32Array.from(channels as unknown as ArrayLike<number>)]
  return (channels as ArrayLike<number>[]).map((channel) => Float32Array.from(channel))
}

/** Audio key, chords, sections, and tempo. The FFT runs in a Web Worker. */
export function analyzeAudioInWorker(buffer: AnalysisBuffer): Promise<AnalysisResult> {
  if (typeof Worker === 'undefined') return Promise.resolve(analyzeAudio(buffer))
  return request({
    type: 'analyze',
    sampleRate: buffer.sampleRate,
    channels: copyChannels(buffer.channels),
    tempo: buffer.tempo,
    numerator: buffer.timeSignature?.numerator,
    denominator: buffer.timeSignature?.denominator,
  }).then((response) => {
    if (!response.analysis) throw new Error(response.message || 'No analysis')
    return response.analysis
  })
}

/** Hum transcription. Pitch tracking runs in a Web Worker. */
export function transcribeHumInWorker(buffer: AnalysisBuffer, options: TranscribeOptions = {}): Promise<HumNote[]> {
  if (typeof Worker === 'undefined') return Promise.resolve(transcribeHum(buffer, options))
  return request({
    type: 'transcribe',
    sampleRate: buffer.sampleRate,
    channels: copyChannels(buffer.channels),
    tempo: options.tempo ?? buffer.tempo,
    grid: options.grid,
    minHz: options.minHz,
    maxHz: options.maxHz,
    numerator: options.timeSignature?.numerator ?? buffer.timeSignature?.numerator,
    denominator: options.timeSignature?.denominator ?? buffer.timeSignature?.denominator,
  }).then((response) => response.notes ?? [])
}

/** Arrangement analysis. Audio clips are read on the worker; MIDI stays in the same call. */
export function analyzeProjectInWorker(project: Project, buffers?: Map<string, AnalysisAsset>): Promise<AnalysisResult> {
  const assets = [...(buffers ?? [])].map(([id, asset]) => ({
    id,
    sampleRate: asset.sampleRate,
    channels: asset.channels.map((channel) => Float32Array.from(channel)),
  }))
  if (typeof Worker === 'undefined' || !assets.length) return Promise.resolve(analyzeProject(project, buffers))
  return request({ type: 'project', project, assets }).then((response) => {
    if (!response.analysis) throw new Error(response.message || 'No analysis')
    return response.analysis
  })
}

import type { Project } from '../model/types'
import { analyzeAudio } from './audio'
import { analyzeProject, type AnalysisAsset } from './project'
import { transcribeHum } from './pitch'
import type { AnalysisBuffer, AnalysisResult, HumNote } from './types'

export interface AnalysisRequest {
  id: number
  type: 'analyze' | 'transcribe' | 'project'
  sampleRate?: number
  channels?: Float32Array[]
  tempo?: number
  numerator?: number
  denominator?: number
  grid?: number
  minHz?: number
  maxHz?: number
  project?: Project
  assets?: { id: string; sampleRate: number; channels: Float32Array[] }[]
}

export interface AnalysisResponse {
  id: number
  type: 'result' | 'error'
  analysis?: AnalysisResult
  notes?: HumNote[]
  message?: string
}

function bufferFrom(message: AnalysisRequest): AnalysisBuffer {
  return {
    sampleRate: message.sampleRate || 48000,
    channels: message.channels ?? [],
    tempo: message.tempo,
    timeSignature: { numerator: message.numerator || 4, denominator: message.denominator || 4 },
  }
}

/** Runs one worker request on whatever thread imported it. */
export function handleAnalysisMessage(message: AnalysisRequest): AnalysisResponse {
  try {
    if (message.type === 'transcribe') {
      const notes = transcribeHum(bufferFrom(message), {
        tempo: message.tempo,
        grid: message.grid,
        minHz: message.minHz,
        maxHz: message.maxHz,
      })
      return { id: message.id, type: 'result', notes }
    }
    if (message.type === 'project' && message.project) {
      const buffers = new Map<string, AnalysisAsset>()
      for (const asset of message.assets ?? []) buffers.set(asset.id, { sampleRate: asset.sampleRate, channels: asset.channels })
      return { id: message.id, type: 'result', analysis: analyzeProject(message.project, buffers) }
    }
    return { id: message.id, type: 'result', analysis: analyzeAudio(bufferFrom(message)) }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Analysis failed'
    return { id: message.id, type: 'error', message: messageText }
  }
}

const scope = globalThis as { postMessage?: (data: unknown) => void; onmessage?: ((event: MessageEvent<AnalysisRequest>) => void) | null }
const inWorker = typeof window === 'undefined' && typeof scope.postMessage === 'function'

if (inWorker) {
  scope.onmessage = (event: MessageEvent<AnalysisRequest>) => {
    scope.postMessage?.(handleAnalysisMessage(event.data))
  }
}

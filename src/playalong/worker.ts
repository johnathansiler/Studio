import { stretchChannels } from './stretch'
import { transcribeScore, type TranscribeInput } from './transcribe'
import type { PlayScore, PracticeRate } from './types'
import type { StretchMode } from '../audio/stretch/engine'

export interface PlayAlongRequest {
  id: number
  type: 'transcribe' | 'stretch'
  sampleRate?: number
  channels?: Float32Array[]
  tempo?: number
  beats?: number
  numerator?: number
  denominator?: number
  keyRoot?: number
  keyScale?: string
  name?: string
  soundCategory?: string
  soundRole?: string
  soundType?: string
  soundTags?: string[]
  part?: TranscribeInput['part']
  rate?: PracticeRate
  mode?: StretchMode
}

export interface PlayAlongResponse {
  id: number
  type: 'result' | 'error'
  score?: PlayScore
  channels?: Float32Array[]
  message?: string
}

export function handlePlayAlongMessage(message: PlayAlongRequest): PlayAlongResponse {
  try {
    if (message.type === 'stretch') {
      const channels = stretchChannels(message.channels ?? [], message.sampleRate || 48000, message.rate === 0.5 || message.rate === 0.75 ? message.rate : 1, message.mode ?? 'tonal')
      return { id: message.id, type: 'result', channels }
    }
    const score = transcribeScore({
      channels: message.channels ?? [],
      sampleRate: message.sampleRate || 48000,
      tempo: message.tempo || 120,
      beats: message.beats,
      numerator: message.numerator,
      denominator: message.denominator,
      key: message.keyScale ? { root: message.keyRoot ?? 0, scale: message.keyScale } : null,
      name: message.name,
      soundCategory: message.soundCategory,
      soundRole: message.soundRole,
      soundType: message.soundType,
      soundTags: message.soundTags,
      part: message.part,
    })
    return { id: message.id, type: 'result', score }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : 'Play along failed'
    return { id: message.id, type: 'error', message: messageText }
  }
}

const scope = globalThis as { postMessage?: (data: unknown) => void; onmessage?: ((event: MessageEvent<PlayAlongRequest>) => void) | null }
const inWorker = typeof window === 'undefined' && typeof scope.postMessage === 'function'

if (inWorker) {
  scope.onmessage = (event: MessageEvent<PlayAlongRequest>) => {
    scope.postMessage?.(handlePlayAlongMessage(event.data))
  }
}

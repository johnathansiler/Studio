import { cachedScore, rememberScore, transcriptionKey } from './cache'
import type { PlayAlongRequest, PlayAlongResponse } from './worker'
import type { PlayScore, PracticeRate } from './types'
import type { TranscribeInput } from './transcribe'
import type { StretchMode } from '../audio/stretch/engine'

let worker: Worker | null = null
let nextId = 1

function client() {
  if (typeof Worker === 'undefined') return null
  if (!worker) worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return worker
}

function request(message: Omit<PlayAlongRequest, 'id'>): Promise<PlayAlongResponse> {
  const host = client()
  const id = nextId++
  if (!host) return Promise.resolve({ id, type: 'error', message: 'No audio worker' })
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<PlayAlongResponse>) => {
      if (event.data?.id !== id) return
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
      if (event.data.type === 'error') reject(new Error(event.data.message || 'Play along failed'))
      else resolve(event.data)
    }
    const onError = () => {
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
      reject(new Error('Play along failed'))
    }
    host.addEventListener('message', onMessage)
    host.addEventListener('error', onError)
    host.postMessage({ ...message, id })
  })
}

function copyChannel(channel: ArrayLike<number>) {
  return channel instanceof Float32Array ? new Float32Array(channel) : Float32Array.from(channel)
}

export function scoreCacheKey(input: TranscribeInput) {
  const first = Array.isArray(input.channels) ? input.channels[0] : input.channels
  const length = first && 'length' in first ? first.length : 0
  return transcriptionKey([
    'score',
    input.sampleRate,
    length,
    input.tempo,
    input.beats,
    input.part ?? 'auto',
    input.key?.root,
    input.key?.scale,
    input.name,
    input.soundCategory,
    input.soundRole,
  ])
}

/** Transcribe off the UI thread. A repeated clip reuses the cached score. */
export async function transcribeInWorker(input: TranscribeInput): Promise<PlayScore> {
  const key = scoreCacheKey(input)
  const cached = cachedScore(key)
  if (cached) return cached
  const channels = (Array.isArray(input.channels) ? input.channels : [input.channels]).map((channel) => copyChannel(channel as ArrayLike<number>))
  if (!client()) {
    const { transcribeScore } = await import('./transcribe')
    return rememberScore(key, transcribeScore({ ...input, channels }))
  }
  const response = await request({
    type: 'transcribe',
    sampleRate: input.sampleRate,
    channels,
    tempo: input.tempo,
    beats: input.beats,
    numerator: input.numerator,
    denominator: input.denominator,
    keyRoot: input.key?.root,
    keyScale: input.key?.scale,
    name: input.name,
    soundCategory: input.soundCategory,
    soundRole: input.soundRole,
    soundType: input.soundType,
    soundTags: input.soundTags,
    part: input.part ?? 'auto',
  })
  if (!response.score) throw new Error(response.message || 'No transcription')
  return rememberScore(key, response.score)
}

/** Time-stretch for 50% or 75% practice. The returned audio is longer and not pitch-shifted. */
export async function stretchInWorker(channels: Float32Array[], sampleRate: number, rate: PracticeRate, mode: StretchMode): Promise<Float32Array[]> {
  const copies = channels.map((channel) => new Float32Array(channel))
  if (rate === 1) return copies
  if (!client()) {
    const { stretchChannels } = await import('./stretch')
    return stretchChannels(copies, sampleRate, rate, mode)
  }
  const response = await request({ type: 'stretch', sampleRate, channels: copies, rate, mode })
  return response.channels ?? copies
}

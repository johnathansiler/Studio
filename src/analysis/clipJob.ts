import type { AudioClip, ClipHearing, Project } from '../model/types'
import { handleClipDetect, type ClipDetectRequest, type ClipDetectResponse } from './clipWorker'

let worker: Worker | null = null
let nextId = 1

function client() {
  if (typeof Worker === 'undefined') return null
  if (!worker) worker = new Worker(new URL('./clipWorker.ts', import.meta.url), { type: 'module' })
  return worker
}

function copyChannels(channels: ArrayLike<number>[]) {
  return channels.map((channel) => Float32Array.from(channel))
}

function request(message: Omit<ClipDetectRequest, 'id'>): Promise<ClipHearing> {
  const host = client()
  const id = nextId++
  if (!host) {
    const response = handleClipDetect({ ...message, id })
    if (response.type === 'error' || !response.hearing) return Promise.reject(new Error(response.message || 'Detection failed'))
    return Promise.resolve(response.hearing)
  }
  const channels = message.channels
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
      reject(new Error('Detection is taking too long.'))
    }, 20000)
    const onMessage = (event: MessageEvent<ClipDetectResponse>) => {
      if (event.data?.id !== id) return
      cleanup()
      if (event.data.type === 'error' || !event.data.hearing) reject(new Error(event.data.message || 'Detection failed'))
      else resolve(event.data.hearing)
    }
    const onError = () => {
      cleanup()
      reject(new Error('Detection failed'))
    }
    const cleanup = () => {
      clearTimeout(timer)
      host.removeEventListener('message', onMessage)
      host.removeEventListener('error', onError)
    }
    host.addEventListener('message', onMessage)
    host.addEventListener('error', onError)
    const payload: ClipDetectRequest = { ...message, id, channels }
    const transfer = channels.map((channel) => channel.buffer)
    host.postMessage(payload, transfer)
  })
}

/**
 * Key of the stretched clip and tempo of its source.
 * The FFT and the stretch render run in a worker when the browser has one.
 * Callers must pass copies of the playback buffers. The worker takes ownership.
 */
export function detectClipHearing(input: {
  channels: ArrayLike<number>[]
  sampleRate: number
  clip: AudioClip
  project: Pick<Project, 'tempo' | 'sampleRate' | 'tempoMap' | 'automation'>
}): Promise<ClipHearing> {
  const channels = copyChannels(input.channels)
  const lanes = (input.project.automation ?? []).filter((lane) => lane.pluginId === 'transport' && lane.param === 'tempo')
  return request({
    type: 'clip-detect',
    sampleRate: input.sampleRate,
    channels,
    clip: input.clip,
    tempo: input.project.tempo,
    tempoMap: input.project.tempoMap,
    automation: lanes,
  })
}

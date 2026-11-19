import { renderClipChannels } from './engine'
import { formantPitchKey, readFormantPitch, writeFormantPitch } from './pitchCache'
import { publishStretch } from './commit'
import type { AudioClip, Project } from '../../model/types'

export interface PitchCacheRequest {
  channels: Float32Array[]
  bufferId: string
  offsetSamples: number
  sourceSamples: number
  sampleRate: number
  semitones: number
  cents: number
  formant: boolean
  mode: string
}

let worker: Worker | null = null
let seq = 1
const pending = new Map<number, { resolve: (channels: Float32Array[]) => void; reject: (error: Error) => void }>()

function client() {
  if (typeof Worker === 'undefined') return null
  try {
    if (!worker) {
      worker = new Worker(new URL('./pitch.worker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (event: MessageEvent<{ id: number; channels?: Float32Array[]; error?: string }>) => {
        const wait = pending.get(event.data?.id)
        if (!wait) return
        pending.delete(event.data.id)
        if (event.data.error || !event.data.channels) wait.reject(new Error(event.data.error || 'Pitch shift failed'))
        else wait.resolve(event.data.channels)
      }
      worker.onerror = () => {
        for (const wait of pending.values()) wait.reject(new Error('Pitch shift failed'))
        pending.clear()
        worker = null
      }
    }
    return worker
  } catch {
    worker = null
    return null
  }
}

async function shiftLocal(channels: Float32Array[], sampleRate: number, semitones: number, cents: number, formant: boolean) {
  const { formantPitchChannels } = await import('./formantPitch')
  return formantPitchChannels(channels, sampleRate, { semitones, cents, formant })
}

/** Offline render. The worker is loaded on the first shift; this tab falls back to the same engine. */
export function shiftOffThread(channels: Float32Array[], sampleRate: number, semitones: number, cents: number, formant: boolean) {
  const host = client()
  const kept = channels.map((channel) => Float32Array.from(channel))
  if (!host) return shiftLocal(kept, sampleRate, semitones, cents, formant)
  const id = seq++
  return new Promise<Float32Array[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      shiftLocal(kept, sampleRate, semitones, cents, formant).then(resolve, reject)
    }, 20000)
    pending.set(id, {
      resolve: (out) => {
        clearTimeout(timer)
        resolve(out)
      },
      reject: () => {
        clearTimeout(timer)
        shiftLocal(kept, sampleRate, semitones, cents, formant).then(resolve, reject)
      },
    })
    const payload = kept.map((channel) => Float32Array.from(channel))
    try {
      host.postMessage({ id, channels: payload, sampleRate, semitones, cents, formant }, payload.map((channel) => channel.buffer))
    } catch {
      clearTimeout(timer)
      pending.delete(id)
      shiftLocal(kept, sampleRate, semitones, cents, formant).then(resolve, reject)
    }
  })
}

function fitLength(channel: Float32Array, length: number) {
  if (channel.length === length) return channel
  const fitted = new Float32Array(length)
  fitted.set(channel.subarray(0, Math.min(channel.length, length)))
  return fitted
}

/** Render the shifted source once and keep the float PCM for playback. */
export async function cacheFormantPitch(request: PitchCacheRequest) {
  const offset = Math.max(0, request.offsetSamples)
  const source = Math.max(1, request.sourceSamples)
  const sliced = request.channels.map((channel) => Float32Array.from(channel.subarray(offset, Math.min(channel.length, offset + source))))
  const length = sliced[0]?.length ?? 0
  if (length < 8) return
  const key = formantPitchKey({ ...request, offsetSamples: offset, sourceSamples: source, length })
  if (readFormantPitch(key)) return
  const shifted = await shiftOffThread(sliced, request.sampleRate, request.semitones, request.cents, request.formant)
  writeFormantPitch(key, shifted.map((channel) => fitLength(channel, length)))
}

const upgrading = new Set<string>()

/** Replace a preview render once the offline pitch PCM is ready. */
export async function upgradeFormantPitch(channels: Float32Array[], clip: AudioClip, project: Project, stretchKey: string) {
  const stretch = clip.stretch
  if (!stretch || upgrading.has(stretchKey)) return
  upgrading.add(stretchKey)
  try {
  await cacheFormantPitch({
    channels,
    bufferId: clip.bufferId,
    offsetSamples: clip.offsetSamples,
    sourceSamples: stretch.sourceSamples || channels[0]?.length || 1,
    sampleRate: project.sampleRate,
    semitones: stretch.semitones,
    cents: stretch.cents,
    formant: stretch.formant !== false,
    mode: stretch.mode,
  })
  const rendered = renderClipChannels(channels, clip, project, 'hq')
  publishStretch(stretchKey, rendered, clip.id)
  } finally {
    upgrading.delete(stretchKey)
  }
}

import type { ProjectStore } from '../../state/store'
import { spectralKey } from './edit'
import { learnNoise, renderSpectral } from './process'
import { HQ_SPECTRAL, type SpectralRegion, type SpectralRepair } from './types'

const failed = new Map<string, string>()
let running = false

const listeners = new Set<() => void>()

export function onSpectralCommit(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify() {
  for (const listener of listeners) listener()
}

export function watchSpectral(store: ProjectStore) {
  const poke = () => schedule(store)
  poke()
  return store.subscribe(poke)
}

export function retrySpectral(store: ProjectStore, clipId: string) {
  failed.delete(clipId)
  schedule(store)
}

export function spectralBlocked(clipId: string, key: string) {
  return failed.get(clipId) === key
}

function schedule(store: ProjectStore) {
  if (store.remoteFollow) return
  if (running) return
  const job = nextJob(store)
  if (!job) return
  running = true
  store.setSpectralStatus('Repairing…')
  void run(store, job.trackId, job.clipId, job.key, job.repair)
    .catch(() => {
      failed.set(job.clipId, job.key)
      store.toast('Spectral repair failed', 'warn')
    })
    .finally(() => {
      running = false
      schedule(store)
      if (!running) store.setSpectralStatus(null)
    })
}

function nextJob(store: ProjectStore) {
  for (const track of store.project.tracks) {
    for (const clip of track.clips) {
      const repair = clip.spectral
      if (!repair?.enabled || !repair.ops.length) continue
      const key = spectralKey(repair)
      if (repair.renderedKey === key && repair.renderId && clip.bufferId === repair.renderId && store.buffers.has(repair.renderId)) continue
      if (failed.get(clip.id) === key) continue
      return { trackId: track.id, clipId: clip.id, key, repair }
    }
  }
  return null
}

async function run(store: ProjectStore, trackId: string, clipId: string, key: string, repair: SpectralRepair) {
  const source = store.buffers.get(repair.sourceBufferId)
  const clip = store.track(trackId)?.clips.find((item) => item.id === clipId)
  if (!source || !clip?.spectral) {
    failed.set(clipId, key)
    return
  }
  const origin = Math.max(0, repair.origin)
  const span = Math.max(1, Math.min(repair.span, (source.channels[0]?.length ?? 0) - origin))
  const slice = source.channels.map((channel) => channel.slice(origin, origin + span))
  const repaired = await renderOffline(slice, source.sampleRate, repair)
  const current = store.track(trackId)?.clips.find((item) => item.id === clipId)
  if (!current?.spectral || spectralKey(current.spectral) !== key) return
  const full = source.channels.map((channel) => Float32Array.from(channel))
  for (let index = 0; index < full.length; index++) {
    const row = repaired[index]
    if (row) full[index].set(row.subarray(0, span), origin)
  }
  failed.delete(clipId)
  store.installSpectral(trackId, clipId, full, source.sampleRate, key)
  notify()
}

function renderOffline(channels: Float32Array[], sampleRate: number, repair: SpectralRepair): Promise<Float32Array[]> {
  if (typeof Worker !== 'function' || typeof document === 'undefined') {
    return Promise.resolve(renderSpectral(channels, sampleRate, repair, HQ_SPECTRAL))
  }
  return postWorker({ type: 'render', channels, sampleRate, repair, quality: HQ_SPECTRAL }).then((result) => result as Float32Array[])
}

export function learnOffline(channels: Float32Array[], sampleRate: number, region: SpectralRegion): Promise<number[]> {
  if (typeof Worker !== 'function' || typeof document === 'undefined') {
    return Promise.resolve(learnNoise(channels, sampleRate, region, HQ_SPECTRAL))
  }
  return postWorker({ type: 'learn', channels, sampleRate, region, quality: HQ_SPECTRAL }).then((result) => result as number[])
}

function postWorker(message: { type: 'render' | 'learn'; channels: Float32Array[]; sampleRate: number; repair?: SpectralRepair; region?: SpectralRegion; quality: typeof HQ_SPECTRAL }): Promise<Float32Array[] | number[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    const copy = message.channels.map((channel) => new Float32Array(channel))
    const payload = { ...message, channels: copy }
    worker.onmessage = (event: MessageEvent<{ type: string; channels?: Float32Array[]; bands?: number[]; message?: string }>) => {
      const data = event.data
      if (data.type === 'progress') return
      worker.terminate()
      if (data.type === 'done' && data.channels) resolve(data.channels)
      else if (data.type === 'profile' && data.bands) resolve(data.bands)
      else reject(new Error(data.message || 'Spectral repair failed'))
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('Spectral repair failed'))
    }
    const transfer = copy.map((channel) => channel.buffer)
    worker.postMessage(payload, transfer)
  })
}

import { etaSeconds, formatEta, modeAllowed, modelFor, shiftsFor, stemBudget, stemLabels, type StemCheckpoint, type StemMode, type StemQuality } from './engine'
import type { ProjectStore } from '../../state/store'

export interface StemRequest {
  trackId: string
  clipId: string
  mode: StemMode
  quality: StemQuality
}

interface WorkerOut {
  type: 'progress' | 'done' | 'paused' | 'error'
  phase?: 'download' | 'separate'
  ratio?: number
  received?: number
  total?: number
  eta?: string
  stems?: Float32Array[][]
  checkpoint?: StemCheckpoint
  message?: string
}

let worker: Worker | null = null
let pending: StemRequest | null = null
let held: StemCheckpoint | null = null

function budget() {
  const phone = window.matchMedia('(max-width: 940px)').matches
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const webgpu = 'gpu' in navigator
  return stemBudget(memory, phone, webgpu)
}

function ensureWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
  return worker
}

export function stemHold() {
  return held
}

export function cancelStems() {
  worker?.postMessage({ type: 'cancel' })
}

export function startStems(store: ProjectStore, request: StemRequest, resume = false) {
  if (store.stemStatus && !resume) return
  const allowed = budget()
  if (!modeAllowed(request.mode, allowed)) {
    store.toast('Use 2-stem on this device')
    return
  }
  const found = store.findClip(request.clipId)
  const asset = found ? store.buffers.get(found.clip.bufferId) : undefined
  if (!found || !asset) return
  const start = Math.max(0, found.clip.offsetSamples)
  const length = found.clip.durationSamples
  const channels = asset.channels.map((channel) => channel.slice(start, start + length))
  pending = request
  const active = ensureWorker()
  const shifts = shiftsFor(request.quality, allowed)
  const guess = etaSeconds(length, asset.sampleRate, shifts)
  store.setStemStatus({ phase: 'download', ratio: 0, line: lineFor(request, 0, guess) })
  active.onmessage = (event: MessageEvent<WorkerOut>) => {
    const message = event.data
    if (message.type === 'progress') {
      const eta = message.phase === 'separate' ? formatEta(Number(message.eta)) : formatEta(etaSeconds(length, asset.sampleRate, shifts))
      const ratio = message.ratio ?? 0
      store.setStemStatus({
        phase: message.phase ?? 'separate',
        ratio,
        line: message.phase === 'download' ? lineFor(request, ratio, etaSeconds(length, asset.sampleRate, shifts)) : `${Math.round(ratio * 100)}% · ${eta}`,
      })
      return
    }
    if (message.type === 'paused' && message.checkpoint) {
      held = message.checkpoint
      store.setStemStatus(null)
      store.setStemPaused(true)
      return
    }
    if (message.type === 'error') {
      held = null
      store.setStemStatus(null)
      store.toast(message.message || 'Stem separation failed', 'warn')
      return
    }
    if (message.type === 'done' && message.stems && pending) {
      const labels = stemLabels(pending.mode)
      store.placeStems(pending.trackId, pending.clipId, message.stems.map((channelsOut, index) => ({
        name: labels[index]?.name ?? 'Stem',
        color: labels[index]?.color ?? '#73c48f',
        channels: channelsOut,
      })), pending.mode === 'sampler')
      held = null
      pending = null
      store.setStemPaused(false)
      store.setStemStatus(null)
      store.closeStems()
    }
  }
  active.postMessage({
    type: 'start',
    channels,
    sampleRate: asset.sampleRate,
    mode: request.mode,
    shifts,
    checkpoint: resume ? held ?? undefined : undefined,
  })
  if (!resume) held = null
  store.setStemPaused(false)
}

function lineFor(request: StemRequest, ratio: number, seconds: number) {
  const model = modelFor(request.mode)
  const size = `${Math.max(1, Math.round(model.bytes / 1e6))} MB`
  if (ratio > 0 && ratio < 1) return `${size} · ${Math.round(ratio * 100)}%`
  return `${size} · ${formatEta(seconds)}`
}

export function resumeStems(store: ProjectStore) {
  if (!pending) return
  startStems(store, pending, true)
}

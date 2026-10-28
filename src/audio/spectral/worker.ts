import { learnNoise, renderSpectral } from './process'
import type { SpectralRegion, SpectralRepair, SpectralSettings } from './types'

interface RenderRequest {
  type: 'render'
  channels: Float32Array[]
  sampleRate: number
  repair: SpectralRepair
  quality: SpectralSettings
}

interface LearnRequest {
  type: 'learn'
  channels: Float32Array[]
  sampleRate: number
  region: SpectralRegion
  quality: SpectralSettings
}

self.onmessage = (event: MessageEvent<RenderRequest | LearnRequest>) => {
  const message = event.data
  try {
    if (message.type === 'learn') {
      const bands = learnNoise(message.channels, message.sampleRate, message.region, message.quality)
      self.postMessage({ type: 'profile', bands })
      return
    }
    const channels = renderSpectral(message.channels, message.sampleRate, message.repair, message.quality, (ratio) => {
      self.postMessage({ type: 'progress', ratio })
    })
    const host = self as unknown as { postMessage: (data: unknown, transfer?: Transferable[]) => void }
    host.postMessage({ type: 'done', channels }, channels.map((channel) => channel.buffer))
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Spectral repair failed' })
  }
}

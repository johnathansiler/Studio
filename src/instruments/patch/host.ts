import type { OmniPatch } from './types'
import type { StripNodes } from '../../audio/strips'
import { matchBufferRate, PatchEngine } from './engine'

interface AudioLookup {
  sampleRate: number
  channel: Float32Array
}

interface Live {
  engine: PatchEngine
  gain: GainNode
}

/**
 * One patch per MIDI track. The engine pulls samples on the audio thread's script callback
 * so grain buffers stay shared with the project instead of being copied into a worklet.
 */
export class PatchHost {
  private lives = new Map<string, Live>()
  private pending = new Map<string, { pitch: number; vel: number; time: number }[]>()
  private cache = new Map<string, Float32Array>()
  private cacheOrder: string[] = []

  sync(
    ctx: AudioContext,
    tracks: { id: string; type: string; omniPatch?: OmniPatch | null }[],
    strips: Map<string, StripNodes>,
    lookup: (id: string) => AudioLookup | null,
  ) {
    const used = new Set<string>()
    for (const track of tracks) {
      const patch = track.type === 'midi' ? track.omniPatch : null
      if (!patch?.enabled) {
        if (this.lives.has(track.id)) this.drop(track.id)
        continue
      }
      const strip = strips.get(track.id)
      if (!strip) continue
      const live = this.ensure(ctx, track.id, strip)
      live.engine.setPatch(patch)
      this.pushBuffers(live, patch, lookup)
      for (const note of this.pending.get(track.id) ?? []) live.engine.schedule(note.pitch, note.vel, note.time)
      this.pending.delete(track.id)
      used.add(track.id)
    }
    for (const id of [...this.lives.keys()]) if (!used.has(id)) this.drop(id)
  }

  note(trackId: string, pitch: number, vel: number, time: number) {
    const live = this.lives.get(trackId)
    if (!live) {
      const queue = this.pending.get(trackId) ?? []
      queue.push({ pitch, vel, time })
      this.pending.set(trackId, queue)
      return
    }
    live.engine.schedule(pitch, vel, time)
  }

  allOff() {
    for (const live of this.lives.values()) live.engine.allOff()
  }

  private ensure(ctx: AudioContext, id: string, strip: StripNodes) {
    const existing = this.lives.get(id)
    if (existing) return existing
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    gain.connect(strip.input)
    const engine = new PatchEngine(ctx.sampleRate)
    engine.connect(gain)
    const live = { engine, gain }
    this.lives.set(id, live)
    return live
  }

  private pushBuffers(live: Live, patch: OmniPatch, lookup: (id: string) => AudioLookup | null) {
    const seen = new Set<string>()
    for (const layer of patch.layers) {
      if (!layer.bufferId || seen.has(layer.bufferId)) continue
      seen.add(layer.bufferId)
      const asset = lookup(layer.bufferId)
      if (!asset?.channel?.length) {
        live.engine.setBuffer(layer.bufferId, null)
        continue
      }
      const key = `${layer.bufferId}:${asset.sampleRate}:${asset.channel.length}:${live.engine.sampleRate}:${asset.channel[0] || 0}`
      let channel = this.cache.get(key)
      if (!channel) {
        channel = matchBufferRate(asset.channel, asset.sampleRate, live.engine.sampleRate)
        this.cache.set(key, channel)
        this.cacheOrder.push(key)
        while (this.cacheOrder.length > 12) {
          const stale = this.cacheOrder.shift()
          if (stale) this.cache.delete(stale)
        }
      }
      live.engine.setBuffer(layer.bufferId, channel)
    }
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    this.pending.delete(id)
    live?.engine.dispose()
    try { live?.gain.disconnect() } catch { /* already disconnected */ }
  }
}

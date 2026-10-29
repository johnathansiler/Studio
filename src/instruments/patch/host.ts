import type { OmniPatch } from './types'
import type { StripNodes } from '../../audio/strips'
import { acceptNoteOn, clearNote } from '../../audio/liveStage'
import { matchBufferRate, PatchEngine } from './engine'

interface AudioLookup {
  sampleRate: number
  channel: Float32Array
}

interface Live {
  engine: PatchEngine
  gain: GainNode
  worklet: AudioWorkletNode | null
  dedupe: Map<number, number>
  patch: OmniPatch | null
  patchSig: string
  sent: Set<string>
  audio: Map<string, Float32Array>
  open: boolean
  waiting: { pitch: number; vel: number; time: number }[]
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
  private module: Promise<boolean> | null = null

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
      live.patch = patch
      const sig = `${patch.id}:${patch.enabled ? 1 : 0}:${patch.layers.map((layer) => `${layer.id}:${layer.enabled ? 1 : 0}:${layer.kind}`).join(',')}`
      if (sig !== live.patchSig) {
        live.patchSig = sig
        live.engine.setPatch(patch)
        live.worklet?.port.postMessage({ type: 'patch', patch })
      }
      this.pushBuffers(live, patch, lookup)
      for (const note of this.pending.get(track.id) ?? []) this.play(live, note.pitch, note.vel, note.time)
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
    this.play(live, pitch, vel, time)
  }

  private play(live: Live, pitch: number, vel: number, time: number) {
    if (vel > 0) {
      if (!acceptNoteOn(live.dedupe, pitch, time)) return
    } else clearNote(live.dedupe, pitch)
    if (live.worklet) {
      live.worklet.port.postMessage({ type: 'note', pitch, vel, time })
      return
    }
    if (!live.open) {
      live.waiting.push({ pitch, vel, time })
      return
    }
    live.engine.schedule(pitch, vel, time)
  }

  private flushWaiting(live: Live) {
    const queued = live.waiting.splice(0, live.waiting.length)
    for (const note of queued) {
      if (live.worklet) live.worklet.port.postMessage({ type: 'note', pitch: note.pitch, vel: note.vel, time: note.time })
      else live.engine.schedule(note.pitch, note.vel, note.time)
    }
  }

  release(trackId: string, pitch: number) {
    const midi = Math.round(pitch)
    const live = this.lives.get(trackId)
    if (!live) {
      const queue = (this.pending.get(trackId) ?? []).filter((note) => note.pitch !== midi)
      this.pending.set(trackId, queue)
      return
    }
    live.dedupe.delete(midi)
    live.waiting = live.waiting.filter((note) => Math.round(note.pitch) !== midi)
    if (live.worklet) {
      live.worklet.port.postMessage({ type: 'release', pitch: midi })
      return
    }
    if (live.open) live.engine.releasePitch(midi)
  }

  allOff() {
    for (const live of this.lives.values()) {
      live.dedupe.clear()
      live.engine.allOff()
      live.worklet?.port.postMessage({ type: 'off' })
    }
  }

  private ensure(ctx: AudioContext, id: string, strip: StripNodes) {
    const existing = this.lives.get(id)
    if (existing) return existing
    const gain = ctx.createGain()
    gain.gain.value = 0.9
    gain.connect(strip.input)
    const engine = new PatchEngine(ctx.sampleRate)
    const live: Live = { engine, gain, worklet: null, dedupe: new Map(), patch: null, patchSig: '', sent: new Set(), audio: new Map(), open: false, waiting: [] }
    this.lives.set(id, live)
    void this.load(ctx).then((ok) => {
      if (live.worklet || live.open) return
      if (ok && this.mount(ctx, live)) {
        live.open = true
        this.flushWaiting(live)
        return
      }
      engine.connect(gain)
      live.open = true
      this.flushWaiting(live)
    })
    return live
  }

  private load(ctx: AudioContext) {
    if (!this.module) {
      this.module = ctx.audioWorklet.addModule(new URL('../../audio/patch.worklet.ts', import.meta.url)).then(() => true).catch(() => false)
    }
    return this.module
  }

  private mount(ctx: AudioContext, live: Live) {
    try {
      const node = new AudioWorkletNode(ctx, 'cueharbor-patch', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
      node.connect(live.gain)
      live.worklet = node
      if (live.patch) node.port.postMessage({ type: 'patch', patch: live.patch })
      for (const [id, channel] of live.audio) {
        if (live.sent.has(id)) continue
        live.sent.add(id)
        node.port.postMessage({ type: 'buffer', id, channel: channel.slice() })
      }
      return true
    } catch {
      return false
    }
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
      live.audio.set(layer.bufferId, channel)
      const mark = `${layer.bufferId}:${key}`
      if (live.worklet && !live.sent.has(mark)) {
        live.sent.add(mark)
        live.worklet.port.postMessage({ type: 'buffer', id: layer.bufferId, channel: channel.slice() })
      }
    }
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    this.pending.delete(id)
    try { live?.worklet?.disconnect() } catch { /* already disconnected */ }
    live?.engine.dispose()
    try { live?.gain.disconnect() } catch { /* already disconnected */ }
  }
}

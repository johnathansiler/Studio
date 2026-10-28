import type { Project } from '../model/types'
import type { StripNodes } from '../audio/strips'
import { LayerRuntime, type LayerBuffer } from './engine'
import type { LayerPatch } from './types'

interface Live {
  worklet: AudioWorkletNode | null
  script: ScriptProcessorNode | null
  runtime: LayerRuntime
  gain: GainNode
  patch: LayerPatch | null
  buffers: Map<string, LayerBuffer>
  bufferSig: string
  notes: { pitch: number; vel: number; time: number }[]
}

/**
 * Plays a layered patch on one instrument track.
 * The worklet renders it. A script processor is the fallback.
 */
export class LayerHost {
  cpu = 0
  quality: 'full' | 'eco' = 'full'
  private phone = false
  private lives = new Map<string, Live>()
  private ready: Promise<boolean> | null = null
  private workletOk = false
  private pending = new Map<string, { pitch: number; vel: number; time: number }[]>()

  constructor() {
    if (typeof matchMedia !== 'undefined') this.phone = matchMedia('(max-width: 520px), (max-height: 520px) and (orientation: landscape)').matches
  }

  sync(
    ctx: AudioContext,
    project: Project,
    strips: Map<string, StripNodes>,
    assetOf: (id: string) => { id: string; sampleRate: number; channels: Float32Array[] } | undefined,
  ) {
    void this.ensure(ctx).then((ok) => {
      this.workletOk = ok
      for (const track of project.tracks) {
        if (track.type !== 'midi' || track.instrument !== 'layers' || !track.layerPatch) continue
        const strip = strips.get(track.id)
        if (!strip) continue
        const live = this.ensureLive(ctx, track.id, strip)
        const buffers = new Map<string, LayerBuffer>()
        for (const layer of track.layerPatch.layers) {
          const id = layer.source.bufferId || ''
          if (!id || buffers.has(id)) continue
          const asset = assetOf(id)
          const channel = asset?.channels[0]
          if (asset && channel) buffers.set(id, { sampleRate: asset.sampleRate, channel })
        }
        this.pushState(live, track.layerPatch, buffers)
        for (const note of this.pending.get(track.id) ?? []) {
          if (live.worklet) live.worklet.port.postMessage({ type: 'note', ...note })
          else live.notes.push(note)
        }
        live.notes.sort((a, b) => a.time - b.time)
        this.pending.delete(track.id)
      }
      for (const id of [...this.lives.keys()]) {
        const track = project.tracks.find((item) => item.id === id)
        if (!track || track.instrument !== 'layers' || !track.layerPatch) this.drop(id)
      }
    })
  }

  note(trackId: string, pitch: number, vel: number, time: number) {
    const live = this.lives.get(trackId)
    if (!live) {
      const queue = this.pending.get(trackId) ?? []
      queue.push({ pitch, vel, time })
      this.pending.set(trackId, queue)
      return
    }
    if (live.worklet) live.worklet.port.postMessage({ type: 'note', pitch, vel, time })
    else {
      live.notes.push({ pitch, vel, time })
      live.notes.sort((a, b) => a.time - b.time)
    }
  }

  allOff() {
    for (const live of this.lives.values()) {
      live.worklet?.port.postMessage({ type: 'off' })
      live.runtime.allOff()
      live.notes = []
    }
  }

  private async ensure(ctx: AudioContext) {
    if (this.ready) return this.ready
    this.ready = ctx.audioWorklet.addModule(new URL('./worklet.ts', import.meta.url)).then(() => true).catch(() => false)
    return this.ready
  }

  private ensureLive(ctx: AudioContext, id: string, strip: StripNodes) {
    const existing = this.lives.get(id)
    if (existing) return existing
    const gain = ctx.createGain()
    gain.connect(strip.input)
    const runtime = new LayerRuntime(ctx.sampleRate)
    const live: Live = { worklet: null, script: null, runtime, gain, patch: null, buffers: new Map(), bufferSig: '', notes: [] }
    if (this.workletOk) {
      const node = new AudioWorkletNode(ctx, 'cueharbor-layers', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
      node.port.onmessage = (event: MessageEvent<{ type?: string; value?: number }>) => {
        if (event.data?.type !== 'cpu' || typeof event.data.value !== 'number') return
        this.cpu = this.cpu * 0.8 + Math.min(4, event.data.value) * 0.2
        if (this.phone && this.cpu > 0.7) this.quality = 'eco'
        else if (this.cpu < 0.3) this.quality = 'full'
      }
      node.connect(gain)
      live.worklet = node
    } else {
      try {
        const script = ctx.createScriptProcessor(256, 0, 2)
        script.onaudioprocess = (event) => {
          const patch = live.patch
          if (!patch) return
          const when = event.playbackTime || ctx.currentTime
          while (live.notes.length && live.notes[0].time <= when) {
            const item = live.notes.shift()!
            runtime.note(item.pitch, item.vel, patch.polyphony)
          }
          const started = performance.now()
          const rendered = runtime.render(patch, event.outputBuffer.length, this.quality, live.buffers)
          event.outputBuffer.getChannelData(0).set(rendered[0])
          event.outputBuffer.getChannelData(1).set(rendered[1])
          const budget = (event.outputBuffer.length / ctx.sampleRate) * 1000
          this.cpu = this.cpu * 0.8 + (budget > 0 ? (performance.now() - started) / budget : 0) * 0.2
          if (this.phone && this.cpu > 0.7) this.quality = 'eco'
          else if (this.cpu < 0.3) this.quality = 'full'
        }
        script.connect(gain)
        live.script = script
      } catch {
        /* the track stays silent until the worklet loads */
      }
    }
    this.lives.set(id, live)
    return live
  }

  private pushState(live: Live, patch: LayerPatch, buffers: Map<string, LayerBuffer>) {
    live.patch = patch
    live.buffers = buffers
    if (!live.worklet) return
    const sig = [...buffers.entries()].map(([id, buffer]) => `${id}:${buffer.channel.length}:${buffer.sampleRate}`).join('|')
    const same = sig === live.bufferSig
    live.bufferSig = sig
    const packed = same ? undefined : [...buffers.entries()].slice(0, 4).map(([id, buffer]) => ({
      id,
      sampleRate: buffer.sampleRate,
      data: buffer.channel.slice(0, 48000 * 12),
    }))
    live.worklet.port.postMessage({ type: 'state', patch, quality: this.quality, buffers: packed })
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    try { live?.worklet?.disconnect() } catch { /* gone */ }
    try { live?.script?.disconnect() } catch { /* gone */ }
    try { live?.gain.disconnect() } catch { /* gone */ }
  }
}

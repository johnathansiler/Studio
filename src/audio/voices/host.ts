/** Live Beat Machine voices. The pool runs on the audio clock with no extra delay line. */

import { residentDrums } from '../../model/drums'
import { normalizePadKit } from '../../model/padMachine'
import type { AudioAsset, Project, Track } from '../../model/types'
import { preloadWasmInserts } from '../plugins/createAll'
import type { StripNodes } from '../strips'
import { wasmDspRequested } from '../wasm/flag'
import { PadGraph } from './live'
import { planPads, type PadPlan } from './program'

interface Live {
  graph: PadGraph
  script: ScriptProcessorNode | null
  gain: GainNode | null
  dest: AudioNode | null
  keeper: ConstantSourceNode | null
  signature: string
  failed: boolean
  /** True after the audio thread has pulled a block. Until then live hits use the buffer voice. */
  pulled: boolean
}

export class PadHost {
  private lives = new Map<string, Live>()
  private drums = new Map<number, { pitch: number; samples: Float32Array; sampleRate: number }[]>()

  sync(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>, assetOf: (id: string) => AudioAsset | undefined) {
    if (wasmDspRequested()) void preloadWasmInserts()
    const keep = new Set<string>()
    for (const track of project.tracks) {
      if (track.instrument !== 'pads') continue
      const strip = strips.get(track.id)
      if (!strip) continue
      keep.add(track.id)
      this.syncTrack(ctx, track, strip.input, assetOf, project.tempo || 120)
    }
    for (const id of [...this.lives.keys()]) if (!keep.has(id)) this.drop(id)
  }

  hit(
    ctx: AudioContext,
    track: Track,
    dest: AudioNode,
    assetOf: (id: string) => AudioAsset | undefined,
    tempo: number,
    hit: { pitch: number; velocity: number; time: number; tune?: number; filter?: number },
  ) {
    if (track.instrument !== 'pads') return false
    this.syncTrack(ctx, track, dest, assetOf, tempo)
    const live = this.lives.get(track.id)
    if (!live || live.failed || !live.script || !live.pulled) return false
    return live.graph.hit(hit.pitch, hit.velocity, hit.time, { tune: hit.tune, filter: hit.filter })
  }

  release(trackId: string | null, pitch: number, time: number) {
    if (!trackId) return
    this.lives.get(trackId)?.graph.release(pitch, time)
  }

  cancel(pitch: number, afterTime: number) {
    for (const live of this.lives.values()) live.graph.cancel(pitch, afterTime)
  }

  duck(pitch: number, time: number) {
    for (const live of this.lives.values()) live.graph.release(pitch, time)
  }

  dispose() {
    for (const id of [...this.lives.keys()]) this.drop(id)
  }

  private syncTrack(ctx: AudioContext, track: Track, dest: AudioNode, assetOf: (id: string) => AudioAsset | undefined, tempo: number) {
    const plan = this.planFor(ctx, track, assetOf, tempo)
    const signature = sign(plan)
    let live = this.lives.get(track.id)
    if (!live) {
      live = {
        graph: new PadGraph(ctx.sampleRate, undefined, { wasm: wasmDspRequested() }),
        script: null,
        gain: null,
        dest: null,
        keeper: null,
        signature: '',
        failed: false,
        pulled: false,
      }
      this.lives.set(track.id, live)
      this.attach(ctx, live, dest)
    } else if (live.dest !== dest && live.gain && typeof live.gain.disconnect === 'function') {
      try { live.gain.disconnect() } catch { /* already disconnected */ }
      try { live.gain.connect(dest) } catch { /* the strip is gone */ }
      live.dest = dest
    }
    if (live.signature !== signature) {
      live.graph.arm(plan)
      live.signature = signature
    }
  }

  private planFor(ctx: AudioContext, track: Track, assetOf: (id: string) => AudioAsset | undefined, tempo: number) {
    const kit = normalizePadKit(track.padKit)
    const pads = kit.banks[Math.min(kit.banks.length - 1, Math.max(0, kit.activeBank || 0))] ?? []
    const buffers: { id: string; samples: Float32Array; sampleRate: number }[] = []
    const push = (id: string | undefined) => {
      if (!id || buffers.some((item) => item.id === id)) return
      const asset = assetOf(id)
      const channel = asset?.channels[0]
      if (!asset || !channel?.length) return
      buffers.push({ id, samples: channel, sampleRate: asset.sampleRate })
    }
    for (const pad of pads) push((pad.layers.find((layer) => layer.bufferId) ?? pad.layers[0])?.bufferId)
    push(kit.chop?.bufferId)
    return planPads({
      pads,
      buffers,
      vintage: kit.vintage,
      chop: kit.chop,
      sampleRate: ctx.sampleRate,
      tempo,
      resident: this.resident(ctx.sampleRate),
    })
  }

  private resident(sampleRate: number) {
    let hit = this.drums.get(sampleRate)
    if (!hit) {
      hit = residentDrums(sampleRate).map((drum) => ({ pitch: drum.pitch, samples: drum.samples, sampleRate }))
      this.drums.set(sampleRate, hit)
    }
    return hit
  }

  private attach(ctx: AudioContext, live: Live, dest: AudioNode) {
    const create = (ctx as AudioContext & { createScriptProcessor?: (size: number, inputs: number, outputs: number) => ScriptProcessorNode }).createScriptProcessor
    if (typeof create !== 'function') {
      live.failed = true
      return
    }
    let script: ScriptProcessorNode | null = null
    let keeper: ConstantSourceNode | null = null
    try {
      script = create.call(ctx, 256, 1, 2)
      if (typeof ctx.createConstantSource === 'function') {
        keeper = ctx.createConstantSource()
        keeper.offset.value = 0
        keeper.connect(script)
        keeper.start()
      }
    } catch {
      try { script = create.call(ctx, 256, 0, 2) } catch { script = null }
      keeper = null
    }
    if (!script || typeof script.connect !== 'function') {
      live.failed = true
      return
    }
    const gain = ctx.createGain()
    script.onaudioprocess = (event: AudioProcessingEvent) => {
      live.pulled = true
      const buffer = event.outputBuffer
      if (!buffer) return
      const left = buffer.getChannelData(0)
      const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left
      const when = event.playbackTime
      live.graph.renderInto(Number.isFinite(when) ? when : ctx.currentTime, left, right)
    }
    try {
      script.connect(gain)
      gain.connect(dest)
    } catch {
      try { keeper?.stop() } catch { /* already stopped */ }
      live.failed = true
      return
    }
    live.script = script
    live.keeper = keeper
    live.gain = gain
    live.dest = dest
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    if (!live) return
    try { live.keeper?.stop() } catch { /* already stopped */ }
    try { live.script?.disconnect() } catch { /* gone */ }
    try { live.gain?.disconnect() } catch { /* gone */ }
  }
}

function sign(plan: PadPlan) {
  const samples = plan.samples.map((sample) => `${sample.key}:${sample.samples.length}:${sample.sampleRate}`).join(',')
  const slots = plan.slots.map((slot) => [
    slot.pitch, slot.sampleId, slot.start, slot.end, slot.semis, slot.cents, slot.mode,
    slot.highpass, slot.lowpass, slot.choke, slot.reverse ? 1 : 0, slot.hold ? 1 : 0,
    slot.swing, slot.level, slot.pan, slot.loop ? 1 : 0, slot.busId,
    slot.vintage.bitDepth, slot.vintage.sampleRate, slot.vintage.wow, slot.vintage.crackle, slot.vintage.lowpass,
  ].join(':')).join('|')
  return `${samples}#${slots}`
}

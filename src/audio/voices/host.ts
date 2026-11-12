/** Live Beat Machine voices. The pool runs on the audio clock with no extra delay line. */

import { residentDrums } from '../../model/drums'
import { normalizePadKit } from '../../model/padMachine'
import type { AudioAsset, Project, Track } from '../../model/types'
import { loadProcessors } from '../plugins/loadProcessors'
import type { StripNodes } from '../strips'
import { wasmDspRequested } from '../wasm/flag'
import padWorkletUrl from './pad.worklet.ts?worker&url'
import { planPads, type PadPlan } from './program'

interface Live {
  id: string
  node: AudioWorkletNode | null
  gain: GainNode | null
  dest: AudioNode | null
  plan: PadPlan | null
  /** Pitches the armed plan can play. The worklet owns the sounding graph. */
  pitches: Set<number>
  signature: string
  failed: boolean
  /** True after the audio thread has pulled a block. Until then live hits use the buffer voice. */
  pulled: boolean
  /** Bumps when the live is replaced so a late worklet load does not attach twice. */
  generation: number
}

export class PadHost {
  private lives = new Map<string, Live>()
  private drums = new Map<number, { pitch: number; samples: Float32Array; sampleRate: number }[]>()
  private module: Promise<boolean> | null = null

  sync(ctx: AudioContext, project: Project, strips: Map<string, StripNodes>, assetOf: (id: string) => AudioAsset | undefined) {
    if (wasmDspRequested()) void loadProcessors().then((mod) => mod.preloadWasmInserts())
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
    if (!live || live.failed || !live.node || !live.pulled || !live.pitches.has(hit.pitch)) return false
    live.node.port.postMessage({
      type: 'hit',
      pitch: hit.pitch,
      velocity: hit.velocity,
      time: hit.time,
      tune: hit.tune,
      filter: hit.filter,
    })
    return true
  }

  release(trackId: string | null, pitch: number, time: number) {
    if (!trackId) return
    this.lives.get(trackId)?.node?.port.postMessage({ type: 'release', pitch, time })
  }

  cancel(pitch: number, afterTime: number) {
    for (const live of this.lives.values()) live.node?.port.postMessage({ type: 'cancel', pitch, afterTime })
  }

  duck(pitch: number, time: number) {
    for (const live of this.lives.values()) live.node?.port.postMessage({ type: 'duck', pitch, time })
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
        id: track.id,
        node: null,
        gain: null,
        dest: null,
        plan: null,
        pitches: new Set(),
        signature: '',
        failed: false,
        pulled: false,
        generation: 0,
      }
      this.lives.set(track.id, live)
      void this.attach(ctx, live, dest)
    } else if (live.dest !== dest && live.gain && typeof live.gain.disconnect === 'function') {
      try { live.gain.disconnect() } catch { /* already disconnected */ }
      try { live.gain.connect(dest) } catch { /* the strip is gone */ }
      live.dest = dest
    }
    if (live.signature !== signature) {
      live.plan = plan
      live.pitches = new Set(plan.slots.filter((slot) => !slot.loop && !slot.busId).map((slot) => slot.pitch))
      live.signature = signature
      live.node?.port.postMessage({ type: 'arm', plan })
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

  private ensure(ctx: AudioContext) {
    const add = ctx.audioWorklet?.addModule
    if (typeof add !== 'function') return Promise.resolve(false)
    this.module ??= add.call(ctx.audioWorklet, padWorkletUrl).then(() => true).catch(() => false)
    return this.module
  }

  private async attach(ctx: AudioContext, live: Live, dest: AudioNode) {
    const generation = ++live.generation
    const ready = await this.ensure(ctx)
    if (generation !== live.generation || this.lives.get(live.id) !== live) return
    if (!ready || typeof AudioWorkletNode !== 'function') {
      live.failed = true
      return
    }
    let node: AudioWorkletNode
    try {
      node = new AudioWorkletNode(ctx, 'cueharbor-pads', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] })
    } catch {
      live.failed = true
      return
    }
    const gain = ctx.createGain()
    node.port.onmessage = (event: MessageEvent<{ type?: string }>) => {
      if (event.data?.type === 'pulled') live.pulled = true
    }
    try {
      node.connect(gain)
      gain.connect(dest)
    } catch {
      try { node.disconnect() } catch { /* gone */ }
      live.failed = true
      return
    }
    live.node = node
    live.gain = gain
    live.dest = dest
    if (live.plan) node.port.postMessage({ type: 'arm', plan: live.plan })
  }

  private drop(id: string) {
    const live = this.lives.get(id)
    this.lives.delete(id)
    if (!live) return
    live.generation += 1
    try { live.node?.disconnect() } catch { /* gone */ }
    try { live.gain?.disconnect() } catch { /* gone */ }
  }
}

function sign(plan: PadPlan) {
  const samples = plan.samples.map((sample) => `${sample.key}:${sample.samples.length}:${sample.sampleRate}`).join(',')
  const slots = plan.slots.map((slot) => [
    slot.pitch, slot.sampleId, slot.start, slot.end, slot.semis, slot.cents, slot.mode,
    slot.highpass, slot.lowpass, slot.choke, slot.reverse ? 1 : 0, slot.hold ? 1 : 0,
    slot.swing, slot.level, slot.pan, slot.loop ? 1 : 0, slot.busId, slot.fadeIn,
    slot.vintage.bitDepth, slot.vintage.sampleRate, slot.vintage.wow, slot.vintage.crackle, slot.vintage.lowpass,
  ].join(':')).join('|')
  return `${samples}#${slots}`
}

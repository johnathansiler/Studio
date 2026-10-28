import { resampleSinc } from '../../audio/quality/resample'
import { createLayerSource } from './adapters'
import { biquadStep, clamp, freshBiq, san } from './dsp'
import {
  fieldOf,
  inRange,
  modulate,
  morphedPatch,
  parseTarget,
  sourceIsBipolar,
} from './model'
import { bindStereo, emptyLink, markConnected, releaseOutput, type LayerSource, type OutputLink } from './source'
import { FIELD_RANGE, type LayerKind, type OmniPatch, type PatchLayer } from './types'

interface Smooth {
  ready: boolean
  level: number
  pan: number
  cutoff: number
  resonance: number
  send: number
  low: ReturnType<typeof freshBiq>
  low2: ReturnType<typeof freshBiq>
}

interface Scheduled {
  note: number
  vel: number
  time: number
}

const FIELDS = ['level', 'pan', 'cutoff', 'resonance', 'fxSend', 'position', 'size', 'density', 'spray', 'pitch'] as const

function silence(frames: number) {
  return { left: new Float32Array(frames), right: new Float32Array(frames) }
}

/**
 * Mixes up to four layer sources, then the per-layer filter, pan, and effect send.
 * The mod matrix and the morph pad are applied on the way in.
 */
export class PatchEngine {
  readonly sampleRate: number
  private patch: OmniPatch | null = null
  private readonly sources = new Map<string, LayerSource>()
  private readonly kinds = new Map<string, LayerKind>()
  private readonly held = new Map<string, Set<number>>()
  private readonly buffers = new Map<string, Float32Array>()
  private readonly smooth = new Map<string, Smooth>()
  private readonly fieldScratch = new Map<number, Record<string, number>>()
  private readonly link: OutputLink = emptyLink()
  private queue: Scheduled[] = []
  private velocity = 0
  private lfo1 = 0
  private lfo2 = 0
  private env1 = 0
  private env2 = 0
  private delay: Float32Array
  private delayPos = 0
  private combs: Float32Array[]
  private combPos: number[]
  private combLow: number[]
  private fxLow = 0
  private dcL = 0
  private dcR = 0
  private readonly glide: number
  private readonly dcCoeff: number

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.glide = 1 - Math.exp(-1 / (0.004 * sampleRate))
    this.dcCoeff = 1 - Math.exp((-2 * Math.PI * 18) / sampleRate)
    const scale = sampleRate / 48000
    this.delay = new Float32Array(Math.max(32, Math.round(sampleRate * 0.18)))
    this.combs = [1051, 1373, 1621, 1889].map((length) => new Float32Array(Math.max(32, Math.round(length * scale))))
    this.combPos = this.combs.map(() => 0)
    this.combLow = this.combs.map(() => 0)
  }

  setPatch(patch: OmniPatch) {
    this.patch = patch
  }

  setBuffer(id: string, channel: Float32Array | null) {
    if (!id) return
    if (channel && channel.length > 8) this.buffers.set(id, channel)
    else this.buffers.delete(id)
  }

  noteOn(note: number, velocity: number) {
    if (!this.patch) return
    const midi = clamp(Math.round(note), 0, 127)
    const level = clamp(velocity, 0, 1)
    if (level <= 0.0001) {
      this.noteOff(midi)
      return
    }
    this.velocity = level
    const heard = morphedPatch(this.patch)
    this.prepare(heard)
    for (const layer of heard.layers) {
      if (!layer.enabled || !inRange(layer, midi, level)) continue
      this.ensure(layer).noteOn(midi, level)
      let notes = this.held.get(layer.id)
      if (!notes) this.held.set(layer.id, notes = new Set())
      notes.add(midi)
    }
  }

  noteOff(note: number) {
    const midi = Math.round(note)
    for (const [id, notes] of this.held) {
      if (!notes.has(midi)) continue
      this.sources.get(id)?.noteOff(midi)
      notes.delete(midi)
    }
  }

  /** Context-time note. The audio callback fires it on the sample it belongs to. */
  schedule(note: number, velocity: number, time: number) {
    this.queue.push({ note, vel: velocity, time: Number.isFinite(time) ? time : 0 })
    this.queue.sort((a, b) => a.time - b.time)
  }

  allOff() {
    this.queue = []
    for (const [id, notes] of this.held) {
      const source = this.sources.get(id)
      for (const note of notes) source?.noteOff(note)
      notes.clear()
    }
  }

  connect(destination: AudioNode) {
    const ctx = destination?.context as AudioContext | undefined
    bindStereo(this, (frames) => this.renderAt(frames, ctx?.currentTime ?? 0), destination, this.link)
    if (!this.link.node) markConnected(this, destination)
  }

  disconnect() {
    releaseOutput(this, this.link)
  }

  dispose() {
    this.disconnect()
    for (const source of this.sources.values()) source.dispose()
    this.sources.clear()
    this.kinds.clear()
    this.held.clear()
  }

  render(frames: number) {
    return this.renderBlock(frames)
  }

  renderAt(frames: number, startTime: number | null) {
    if (startTime == null || !this.queue.length) return this.renderBlock(frames)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    let offset = 0
    while (offset < frames) {
      const now = startTime + offset / this.sampleRate
      while (this.queue.length && this.queue[0].time <= now + 0.5 / this.sampleRate) {
        const item = this.queue.shift()!
        if (item.vel <= 0.0001) this.noteOff(item.note)
        else this.noteOn(item.note, item.vel)
      }
      let until = frames
      if (this.queue.length) {
        const at = Math.floor((this.queue[0].time - startTime) * this.sampleRate)
        if (at > offset) until = Math.min(frames, at)
      }
      const span = Math.max(1, Math.min(frames - offset, until - offset))
      const part = this.renderBlock(span)
      left.set(part.left.subarray(0, span), offset)
      right.set(part.right.subarray(0, span), offset)
      offset += span
    }
    return { left, right }
  }

  private renderBlock(frames: number) {
    if (!this.patch || frames <= 0) return silence(Math.max(0, frames))
    const heard = morphedPatch(this.patch)
    this.prepare(heard)
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const baked = new Map<string, Float32Array>()
    for (const layer of heard.layers) {
      if (!layer.enabled || layer.kind === 'granular') continue
      const source = this.sources.get(layer.id)
      if (!source) continue
      baked.set(layer.id, source.render(frames))
    }
    const gate = this.sounding()
    for (let i = 0; i < frames; i++) {
      this.lfo1 += heard.lfo1Rate / this.sampleRate
      this.lfo2 += heard.lfo2Rate / this.sampleRate
      this.env1 = stepEnv(this.env1, gate, heard.env1Attack, heard.env1Decay, heard.env1Sustain, heard.env1Release, this.sampleRate)
      this.env2 = stepEnv(this.env2, gate, heard.env2Attack, heard.env2Decay, heard.env2Sustain, heard.env2Release, this.sampleRate)
      const sources = this.sourceValues(heard)
      let send = 0
      for (let index = 0; index < heard.layers.length; index++) {
        const layer = heard.layers[index]
        if (!layer.enabled) continue
        const source = this.sources.get(layer.id)
        if (!source) continue
        const mod = this.modulated(layer, index, heard, sources)
        let sample = 0
        if (layer.kind === 'granular') {
          source.setParam('position', mod.position)
          source.setParam('size', mod.size)
          source.setParam('density', mod.density)
          source.setParam('spray', mod.spray)
          source.setParam('pitch', mod.pitch)
          sample = source.tick ? source.tick() : source.render(1)[0] || 0
        } else sample = baked.get(layer.id)?.[i] || 0
        const shaped = this.shape(layer, sample, mod)
        left[i] += shaped.left
        right[i] += shaped.right
        send += shaped.send
      }
      const wet = this.fxTick(send)
      left[i] = this.dc(left[i] + wet, true)
      right[i] = this.dc(right[i] + wet, false)
    }
    return { left, right }
  }

  private prepare(heard: OmniPatch) {
    const live = new Set(heard.layers.map((layer) => layer.id))
    for (const [id, source] of this.sources) {
      if (live.has(id)) continue
      source.dispose()
      this.sources.delete(id)
      this.kinds.delete(id)
      this.held.delete(id)
      this.smooth.delete(id)
    }
    for (const layer of heard.layers) {
      const source = this.ensure(layer)
      source.setBuffer?.(this.buffers.get(layer.bufferId) ?? null)
      for (const [key, value] of Object.entries(layer.params)) source.setParam(key, value)
      source.setParam('root', layer.root)
      if (!layer.enabled) {
        const notes = this.held.get(layer.id)
        if (notes?.size) {
          for (const note of notes) source.noteOff(note)
          notes.clear()
        }
      }
    }
  }

  private ensure(layer: PatchLayer) {
    const current = this.sources.get(layer.id)
    if (current && this.kinds.get(layer.id) === layer.kind) return current
    current?.dispose()
    const source = createLayerSource(layer.kind, this.sampleRate)
    this.sources.set(layer.id, source)
    this.kinds.set(layer.id, layer.kind)
    return source
  }

  private sounding() {
    for (const notes of this.held.values()) if (notes.size) return true
    return false
  }

  private sourceValues(heard: OmniPatch) {
    return {
      lfo1: Math.sin(2 * Math.PI * this.lfo1),
      lfo2: Math.sin(2 * Math.PI * this.lfo2),
      env1: this.env1,
      env2: this.env2,
      velocity: this.velocity,
      aftertouch: heard.aftertouch,
      modwheel: heard.modWheel,
      x: heard.morph.x * 2 - 1,
      y: heard.morph.y * 2 - 1,
    }
  }

  private modulated(layer: PatchLayer, index: number, heard: OmniPatch, sources: Record<string, number>) {
    let slot = this.fieldScratch.get(index)
    if (!slot) {
      slot = {}
      this.fieldScratch.set(index, slot)
    }
    for (const field of FIELDS) {
      const base = fieldOf(layer, field)
      slot[field] = base == null ? 0 : base
    }
    for (const route of heard.routes) {
      const target = parseTarget(route.target)
      if (!target || target.index !== index) continue
      const range = FIELD_RANGE[target.field]
      const base = slot[target.field]
      if (!range || base == null) continue
      slot[target.field] = modulate(base, range, route.depth, sources[route.source] ?? 0, sourceIsBipolar(route.source))
    }
    return slot
  }

  private shape(layer: PatchLayer, input: number, mod: Record<string, number>) {
    let state = this.smooth.get(layer.id)
    if (!state) {
      state = { ready: false, level: 0, pan: 0, cutoff: 3200, resonance: 0, send: 0, low: freshBiq(), low2: freshBiq() }
      this.smooth.set(layer.id, state)
    }
    const level = mod.level ?? layer.level
    const pan = mod.pan ?? layer.pan
    const cutoff = mod.cutoff ?? layer.cutoff
    const resonance = mod.resonance ?? layer.resonance
    const send = mod.fxSend ?? layer.fxSend
    if (!state.ready) {
      state.level = level
      state.pan = pan
      state.cutoff = cutoff
      state.resonance = resonance
      state.send = send
      state.ready = true
    } else {
      const glide = this.glide
      state.level += (level - state.level) * glide
      state.pan += (pan - state.pan) * glide
      state.cutoff += (cutoff - state.cutoff) * glide
      state.resonance += (resonance - state.resonance) * glide
      state.send += (send - state.send) * glide
    }
    const mode = clamp(Math.round(layer.filterMode), 0, 2)
    const open = mode === 0 && state.cutoff >= 12000 && state.resonance < 0.05
    let filtered = input
    if (!open) {
      const q = 0.707 + clamp(state.resonance, 0, 0.92) * 7
      filtered = biquadStep(state.low, input, state.cutoff, q, mode, this.sampleRate)
      if (mode === 0) filtered = biquadStep(state.low2, filtered, state.cutoff, 0.707, 0, this.sampleRate)
    }
    const angle = (clamp(state.pan, -1, 1) + 1) * Math.PI * 0.25
    const gain = clamp(state.level, 0, 1)
    return {
      left: filtered * gain * Math.cos(angle),
      right: filtered * gain * Math.sin(angle),
      send: filtered * gain * clamp(state.send, 0, 1),
    }
  }

  private fxTick(input: number) {
    this.fxLow += ((Number.isFinite(input) ? input : 0) - this.fxLow) * 0.35
    const delay = this.delay
    const pos = this.delayPos % delay.length
    const delayed = delay[pos] || 0
    delay[pos] = san(this.fxLow + delayed * 0.42)
    this.delayPos = pos + 1
    let combSum = 0
    for (let i = 0; i < this.combs.length; i++) {
      const comb = this.combs[i]
      const at = this.combPos[i] % comb.length
      const wet = comb[at] || 0
      this.combLow[i] += (wet - this.combLow[i]) * 0.28
      comb[at] = san(input * 0.22 + this.combLow[i] * 0.68)
      this.combPos[i] = at + 1
      combSum += wet
    }
    return san(delayed * 0.55 + combSum / this.combs.length)
  }

  private dc(sample: number, left: boolean) {
    if (left) {
      this.dcL += (sample - this.dcL) * this.dcCoeff
      return san(sample - this.dcL)
    }
    this.dcR += (sample - this.dcR) * this.dcCoeff
    return san(sample - this.dcR)
  }
}

function stepEnv(value: number, gate: boolean, attackMs: number, decayMs: number, sustain: number, releaseMs: number, sampleRate: number) {
  if (gate) {
    const attack = Math.max(1, (attackMs / 1000) * sampleRate)
    if (value < 0.999) return Math.min(1, value + 1 / attack)
    const decay = Math.max(1, (decayMs / 1000) * sampleRate)
    return value + (clamp(sustain, 0, 1) - value) * (1 - Math.exp(-1 / decay))
  }
  const release = Math.max(1, (releaseMs / 1000) * sampleRate)
  const next = value * Math.exp(-1 / release)
  return next < 1e-5 ? 0 : next
}

export function renderPatchSpan(
  patch: OmniPatch,
  buffers: Map<string, Float32Array>,
  note: number,
  velocity: number,
  seconds: number,
  sampleRate: number,
) {
  const engine = new PatchEngine(sampleRate)
  engine.setPatch(patch)
  for (const [id, channel] of buffers) engine.setBuffer(id, channel)
  const on = Math.max(1, Math.round(Math.max(0.01, seconds) * sampleRate))
  const tail = Math.round(0.45 * sampleRate)
  engine.noteOn(note, velocity)
  const attack = engine.render(on)
  engine.noteOff(note)
  const release = engine.render(tail)
  const left = new Float32Array(on + tail)
  const right = new Float32Array(on + tail)
  left.set(attack.left)
  right.set(attack.right)
  left.set(release.left, on)
  right.set(release.right, on)
  engine.dispose()
  return { left, right }
}

/** Match a project buffer to the engine rate once. Long files use a shorter kernel so the load stays responsive. */
export function matchBufferRate(channel: Float32Array, fromRate: number, toRate: number) {
  if (!(fromRate > 0) || fromRate === toRate) return channel
  const outLen = Math.max(1, Math.round(channel.length * toRate / fromRate))
  const taps = channel.length > fromRate * 90 ? 24 : 64
  return resampleSinc(channel, outLen, taps)
}

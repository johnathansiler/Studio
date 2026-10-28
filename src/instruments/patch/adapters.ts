import { createSampler } from '../../audio/plugins/sampler'
import { freshState, renderTone, tableFromAudio, type FxBus, type PlayVoice, type ToneCtx } from '../../audio/rack/synth'
import { emptySampler } from '../../audio/sample/engine'
import type { DeviceKind } from '../../model/rack'
import type { PluginInstance } from '../../model/types'
import type { BlockContext } from '../../audio/plugins/types'
import { clamp, san } from './dsp'
import { GranularSource } from './granular'
import { NoteClock, bindMono, emptyLink, releaseOutput, type LayerSource, type OutputLink } from './source'
import type { LayerKind } from './types'

const ANALOG: Record<string, number> = {
  mix1: 0.75, mix2: 0.18, mix3: 0, wave1: 0, wave2: 1, wave3: 3,
  detune: 4, cutoff: 14000, res: 0, famt: 0, attack: 8, decay: 260, sustain: 0.78, release: 280,
  uni: 1, uniDet: 6, drive: 0, pw: 0.5, glide: 0, sync: 0, ring: 0,
  fxDrv: 0, fxChor: 0, fxDel: 0, fxRev: 0,
}

const WAVE: Record<string, number> = {
  table: 0, position: 0, warp: 0, warpAmt: 0, uni: 1, uniDet: 6, pw: 0.5,
  cutoff: 14000, res: 0, attack: 8, decay: 240, sustain: 0.8, release: 280, glide: 0,
}

const FM: Record<string, number> = {
  algo: 0, index: 1.1, ratio: 2, feedback: 0.08, attack: 6, decay: 280, sustain: 0.72, release: 300,
  op3: 1, op4: 1, op5: 1, op6: 1, lv3: 0, lv4: 0, lv5: 0, lv6: 0, fixed: 0,
}

function emptyFx(): FxBus {
  return { phase: 0, delay: new Float32Array(2400), delayPos: 0, combs: [], combPos: [], low: 0, band: 0 }
}

function voice(note: number): PlayVoice {
  return { note, vel: 0.8, bend: 0, pressure: 0, glideFrom: note, released: false, active: false, synth: {} }
}

/**
 * Analog, wavetable, and FM layers. They render through the existing tone engine.
 */
export class SynthSource implements LayerSource {
  readonly kind: LayerKind
  private readonly device: DeviceKind
  private readonly clock = new NoteClock()
  private readonly link: OutputLink = emptyLink()
  private readonly params: Record<string, number>
  private readonly voices: PlayVoice[] = []
  private readonly fx = emptyFx()
  private sampleTime = 0
  private last = 60
  private table: Float32Array[] | null = null
  private channel: Float32Array | null = null
  private readonly tone: ToneCtx

  constructor(kind: 'analog' | 'wavetable' | 'fm', private readonly sampleRate: number) {
    this.kind = kind
    this.device = kind === 'fm' ? 'fm' : kind === 'wavetable' ? 'wave' : 'sub'
    this.params = { ...(kind === 'fm' ? FM : kind === 'wavetable' ? WAVE : ANALOG) }
    this.tone = {
      sr: sampleRate,
      time: 0,
      quality: 'full',
      params: this.params,
      voices: this.voices,
      played: (item) => (item.active ? item.note : null),
      table: null,
      fx: this.fx,
      publish: () => undefined,
      deviceId: this.kind,
    }
  }

  noteOn(note: number, velocity: number, time?: number) {
    this.clock.noteOn(note, velocity, time, (midi, level) => this.begin(midi, level))
  }

  noteOff(note: number, time?: number) {
    this.clock.noteOff(note, time, (midi) => this.end(midi))
  }

  connect(destination: AudioNode) {
    bindMono(this, (frames) => this.render(frames), destination, this.link)
  }

  disconnect() {
    releaseOutput(this, this.link)
  }

  setParam(id: string, value: number) {
    if (!Number.isFinite(value)) return
    this.params[id] = value
  }

  setBuffer(channel: Float32Array | null) {
    const next = channel && channel.length > 8 ? channel : null
    if (next === this.channel) return
    this.channel = next
    this.table = next ? tableFromAudio(next) : null
  }

  tick() {
    this.clock.advance(1, this.sampleRate, (note, velocity) => this.begin(note, velocity), (note) => this.end(note))
    this.tone.time = this.sampleTime++
    this.tone.table = this.table
    return san(renderTone(this.device, this.tone))
  }

  render(frames: number) {
    const out = new Float32Array(frames)
    for (let i = 0; i < frames; i++) out[i] = this.tick()
    return out
  }

  dispose() {
    this.disconnect()
    this.voices.length = 0
  }

  private begin(note: number, velocity: number) {
    const midi = clamp(Math.round(note), 0, 127)
    const level = clamp(velocity, 0, 1)
    let slot = this.voices.find((item) => item.active && item.note === midi)
    if (!slot) {
      slot = this.voices.find((item) => !item.active)
      if (!slot && this.voices.length < 8) {
        slot = voice(midi)
        this.voices.push(slot)
      } else if (!slot) {
        slot = this.voices.slice().sort((a, b) => Number(a.released) - Number(b.released))[0]
      }
    }
    if (!slot) return
    slot.note = midi
    slot.vel = level
    slot.bend = 0
    slot.pressure = 0
    slot.glideFrom = this.last
    slot.released = false
    slot.active = true
    slot.synth = { [this.kind]: freshState() }
    this.last = midi
  }

  private end(note: number) {
    const midi = Math.round(note)
    for (const item of this.voices) if (item.note === midi) item.released = true
  }
}

/**
 * Sampler layer. Notes go through the existing sampler processor.
 */
export class SamplerSource implements LayerSource {
  readonly kind: LayerKind = 'sampler'
  private readonly clock = new NoteClock()
  private readonly link: OutputLink = emptyLink()
  private readonly sampler: ReturnType<typeof createSampler>
  private readonly plugin: PluginInstance
  private channel: Float32Array | null = null
  private readonly bufferId = 'patch-sample'
  private scratchIn = new Float32Array(1)
  private scratchL = new Float32Array(1)
  private scratchR = new Float32Array(1)
  private block: BlockContext

  constructor(private readonly sampleRate: number) {
    this.sampler = createSampler(sampleRate)
    this.plugin = {
      id: 'patch-sampler',
      pluginId: 'sampler',
      version: '1',
      enabled: true,
      wet: 1,
      params: { attack: 4, release: 180, cutoff: 17000, gain: 0.9, pan: 0, pitch: 0, keys: 1, stretch: 0, mono: 0, record: 0 },
      sidechain: '',
      sampler: emptySampler(),
    }
    this.plugin.sampler!.bufferId = ''
    this.block = {
      sampleRate,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    }
    this.rebind()
  }

  noteOn(note: number, velocity: number, time?: number) {
    this.clock.noteOn(note, velocity, time, (midi, level) => this.sampler.note(midi, clamp(level, 0, 1)))
  }

  noteOff(note: number, time?: number) {
    this.clock.noteOff(note, time, (midi) => this.sampler.note(midi, 0))
  }

  connect(destination: AudioNode) {
    bindMono(this, (frames) => this.render(frames), destination, this.link)
  }

  disconnect() {
    releaseOutput(this, this.link)
  }

  setParam(id: string, value: number) {
    if (!Number.isFinite(value)) return
    if (id === 'root' && this.plugin.sampler) this.plugin.sampler.root = clamp(Math.round(value), 0, 127)
    else if (id === 'pitch' || id === 'attack' || id === 'release' || id === 'gain') this.plugin.params[id] = value
    this.rebind()
  }

  setBuffer(channel: Float32Array | null) {
    const next = channel && channel.length > 8 ? channel : null
    if (next === this.channel) return
    this.channel = next
    if (this.plugin.sampler) this.plugin.sampler.bufferId = this.channel ? this.bufferId : ''
    this.rebind()
  }

  tick() {
    const audio = this.render(1)
    return audio[0] || 0
  }

  render(frames: number) {
    this.clock.advance(frames, this.sampleRate, (note, velocity) => this.sampler.note(note, clamp(velocity, 0, 1)), (note) => this.sampler.note(note, 0))
    if (this.scratchIn.length !== frames) {
      this.scratchIn = new Float32Array(frames)
      this.scratchL = new Float32Array(frames)
      this.scratchR = new Float32Array(frames)
    } else {
      this.scratchL.fill(0)
      this.scratchR.fill(0)
    }
    this.sampler.process([this.scratchIn, this.scratchIn], [this.scratchL, this.scratchR], this.plugin.params, this.block)
    this.block.sampleTime += frames
    return this.scratchL
  }

  dispose() {
    this.disconnect()
    this.sampler.reset()
    this.channel = null
  }

  private rebind() {
    this.sampler.bind(this.plugin, (id) => (id === this.bufferId ? this.channel : null))
  }
}

export function createLayerSource(kind: LayerKind, sampleRate: number): LayerSource {
  if (kind === 'granular') return new GranularSource(sampleRate)
  if (kind === 'sampler') return new SamplerSource(sampleRate)
  if (kind === 'fm') return new SynthSource('fm', sampleRate)
  if (kind === 'wavetable') return new SynthSource('wavetable', sampleRate)
  return new SynthSource('analog', sampleRate)
}

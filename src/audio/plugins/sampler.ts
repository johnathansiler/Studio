import { descriptor, FACTORY } from './catalog'
import { clamp, sanitize } from './dsp'
import type { PluginInstance } from '../../model/types'
import type { PluginModule, Processor } from './types'

interface Voice {
  note: number
  vel: number
  pos: number
  rate: number
  active: boolean
  buffer: Float32Array
}

const TAPS = 16

/** Windowed-sinc read. Pitching up stays band-limited. */
function readAt(input: Float32Array, at: number) {
  if (at < 0 || at >= input.length) return 0
  const index = Math.floor(at)
  let sum = 0
  let weight = 0
  for (let i = 1 - TAPS; i <= TAPS; i++) {
    const pos = index + i
    const x = at - pos
    if (Math.abs(x) >= TAPS) continue
    const sample = pos >= 0 && pos < input.length ? input[pos] || 0 : 0
    const sinc = Math.abs(x) < 1e-6 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
    const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / TAPS)
    const kernel = sinc * window
    sum += sample * kernel
    weight += kernel
  }
  return weight > 1e-8 ? sum / weight : 0
}

export interface SamplerProcessor extends Processor {
  bind(plugin: PluginInstance, channel: (id: string) => Float32Array | null): void
  note(pitch: number, vel: number): void
}

export function createSampler(sampleRate: number): SamplerProcessor {
  const voices: Voice[] = []
  let buffer: Float32Array | null = null
  let root = 60
  let bufferId = ''
  return {
    latencySamples: 0,
    reset() {
      voices.length = 0
    },
    bind(plugin, channel) {
      const state = plugin.sampler
      root = state?.root ?? 60
      const next = state?.bufferId ?? ''
      if (next !== bufferId) {
        bufferId = next
        buffer = next ? channel(next) : null
        voices.length = 0
      }
    },
    note(pitch, vel) {
      const midi = Math.round(pitch)
      if (vel <= 0.0001) {
        for (const voice of voices) if (voice.note === midi) voice.active = false
        return
      }
      if (!buffer || buffer.length < 2) return
      const limit = sampleRate > 0 ? 8 : 8
      let slot = voices.find((voice) => !voice.active)
      if (!slot && voices.length < limit) {
        slot = { note: midi, vel, pos: 0, rate: 1, active: true, buffer }
        voices.push(slot)
      }
      if (!slot) slot = voices[0]
      slot.note = midi
      slot.vel = vel
      slot.pos = 0
      slot.rate = 2 ** ((midi - root) / 12)
      slot.active = true
      slot.buffer = buffer
    },
    process(input, output, params, ctx) {
      const n = input[0]?.length ?? 0
      const cap = ctx.quality === 'eco' ? 4 : 8
      const active = voices.filter((voice) => voice.active)
      while (active.length > cap) {
        const drop = active.shift()
        if (drop) drop.active = false
      }
      const gain = clamp(params.gain ?? 0.8, 0, 1)
      for (let i = 0; i < n; i++) {
        let sample = 0
        for (const voice of voices) {
          if (!voice.active) continue
          if (voice.pos >= voice.buffer.length - 1) {
            voice.active = false
            continue
          }
          sample += readAt(voice.buffer, voice.pos) * voice.vel * gain
          voice.pos += voice.rate
        }
        const out = sanitize(sample)
        if (output[0]) output[0][i] = out
        if (output[1]) output[1][i] = out
      }
    },
  }
}

const plugin: PluginModule = { descriptor: descriptor('sampler')!, presets: FACTORY.sampler ?? [], create: createSampler }
export default plugin

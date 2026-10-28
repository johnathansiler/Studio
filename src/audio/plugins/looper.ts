import { descriptor, FACTORY } from './catalog'
import { sanitize } from './dsp'
import { emptyLooper, mixTakes, nextBar, syncedLoopSamples, type LoopBox, type LoopTake, type LooperState } from '../sample/engine'
import { playbackChannel, readSlotPoints } from '../sample/slot'
import type { PluginInstance } from '../../model/types'
import type { PluginModule, Processor } from './types'

export interface LooperProcessor extends Processor {
  bind(plugin: PluginInstance, channel: (id: string) => Float32Array | null): void
  kept(): Float32Array | null
}

export function createLooper(sampleRate: number): LooperProcessor {
  let state: LooperState = emptyLooper()
  let box: LoopBox = { length: 0, takes: [], undone: [], feedback: 0.85 }
  let cursor = 0
  let pending: number[] = []
  let ready: Float32Array | null = null
  let signature = ''
  return {
    latencySamples: 0,
    reset() {
      cursor = 0
      pending = []
      ready = null
    },
    bind(plugin, channel) {
      state = plugin.looper ?? emptyLooper()
      const fileRate = state.sourceRate && state.sourceRate > 0 ? state.sourceRate : sampleRate
      const next = `${state.layers.map((layer) => layer.bufferId).join(',')}:${fileRate}:${sampleRate}:${state.lengthSamples}`
      if (next !== signature) {
        signature = next
        const takes: LoopTake[] = []
        for (const layer of state.layers) {
          const samples = channel(layer.bufferId)
          if (!samples?.length) continue
          takes.push({ samples: playbackChannel(samples, fileRate, sampleRate), gain: layer.gain, mute: layer.mute, reverse: layer.reverse, speed: layer.speed || 1 })
        }
        const rawLength = state.lengthSamples || takes[0]?.samples.length || 0
        const length = fileRate === sampleRate ? rawLength : Math.max(1, Math.round((rawLength * sampleRate) / fileRate))
        box = { length, takes, undone: [], feedback: state.feedback }
      }
      box.feedback = state.feedback
    },
    kept() {
      const out = ready
      ready = null
      return out
    },
    process(input, output, params, ctx) {
      const n = input[0]?.length ?? 0
      const transport = Math.round(params.transport ?? state.transport ?? 0)
      const bars = Math.max(1, Math.round(params.bars ?? state.bars ?? 1))
      const sync = (params.sync ?? (state.sync ? 1 : 0)) >= 0.5
      const rate = ctx.sampleRate || sampleRate
      const target = sync ? syncedLoopSamples(bars, ctx.tempo, rate, 4) : 0
      const start = beatsToSamples(state.startBeat || 0, rate, ctx.tempo)
      if (transport >= 2) {
        const src = ctx.sidechain ?? input[0]
        for (let i = 0; i < n; i++) {
          if (ctx.sampleTime + i < start) continue
          pending.push(sanitize(src?.[i] || 0))
          const limit = target > 0 ? target : pending.length
          if (target > 0 && pending.length >= limit) {
            ready = Float32Array.from(pending.slice(0, limit))
            pending = []
            break
          }
        }
        if (!sync && transport === 2 && pending.length > rate * (ctx.quality === 'eco' ? 4 : 30)) {
          ready = Float32Array.from(pending)
          pending = []
        }
      }
      const mix = box.length > 0 && transport !== 0 ? mixTakes(box) : null
      const level = params.level ?? 0.9
      const points = mix?.length ? readSlotPoints(state) : null
      const from = points ? Math.min(mix!.length - 1, Math.floor(points.loopStart * mix!.length)) : 0
      const to = points ? Math.max(from + 1, Math.min(mix!.length, Math.ceil(points.loopEnd * mix!.length))) : 0
      const span = Math.max(1, to - from)
      const fade = Math.min(Math.floor(span / 3), Math.max(0, Math.floor((rate * 12) / 1000)))
      for (let i = 0; i < n; i++) {
        let sample = 0
        if (mix && mix.length) {
          const at = cursor % span
          sample = mix[from + at] || 0
          if (fade > 1 && at >= span - fade) {
            const t = (at - (span - fade) + 1) / fade
            sample = sample * (1 - t) + (mix[from] || 0) * t
          }
          cursor += 1
        }
        if (output[0]) output[0][i] = sanitize(sample * level)
        if (output[1]) output[1][i] = sanitize(sample * level)
      }
    },
  }
}

function beatsToSamples(beat: number, sampleRate: number, tempo: number) {
  return Math.round((beat * 60 * sampleRate) / Math.max(1, tempo))
}

export function armBeat(beat: number, beatsPerBar = 4) {
  return nextBar(beat, beatsPerBar)
}

const plugin: PluginModule = {
  descriptor: descriptor('looper')!,
  presets: FACTORY.looper,
  create: createLooper,
}

export default plugin

import type { AudioClip, LaunchQuant, MidiClip } from './types'
import { quantizeSample } from './launch'
import { beatsToSamples, type TimeSignature } from './time'

export type SlotPhase = 'empty' | 'idle' | 'queued' | 'playing' | 'stopping'

/** Stop lands on the same grid as launch. A clip that has not started yet cancels immediately. */
export function stopPlan(input: {
  now: number
  launchAt: number | undefined
  hasClip: boolean
  quant: LaunchQuant
  sampleRate: number
  tempo: number
  sig: TimeSignature
}): { when: number; immediate: boolean } {
  const when = quantizeSample(input.now, input.quant, input.sampleRate, input.tempo, input.sig)
  const started = input.hasClip && (input.launchAt ?? 0) <= input.now + 0.5
  const immediate = !input.hasClip || !started || when <= input.now + 0.5
  return { when, immediate }
}

export function clipLoopSamples(clip: AudioClip | MidiClip, sampleRate: number, tempo: number): number {
  if ('bufferId' in clip) {
    if (clip.durationBeats && clip.warp !== false) return Math.max(1, Math.round(beatsToSamples(clip.durationBeats, sampleRate, tempo)))
    return Math.max(1, clip.durationSamples)
  }
  return Math.max(1, Math.round(beatsToSamples(Math.max(0.25, clip.durationBeats), sampleRate, tempo)))
}

/** Queued launches and queued stops blink. Playing slots report loop progress from 0 to 1. */
export function slotPhase(input: {
  hasClip: boolean
  launched: boolean
  now: number
  launchAt?: number
  stopAt?: number
  lengthSamples: number
}): { phase: SlotPhase; progress: number } {
  if (!input.hasClip) return { phase: 'empty', progress: 0 }
  if (!input.launched) return { phase: 'idle', progress: 0 }
  const start = input.launchAt ?? 0
  if (input.now + 1e-3 < start) return { phase: 'queued', progress: 0 }
  const length = Math.max(1, input.lengthSamples)
  const progress = Math.min(1, Math.max(0, ((input.now - start) % length) / length))
  if (input.stopAt != null && input.now + 1e-3 < input.stopAt) return { phase: 'stopping', progress }
  return { phase: 'playing', progress }
}

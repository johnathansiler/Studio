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

/**
 * Audio-clock time for a quantized launch.
 * Null while the start is still beyond the look-ahead, so the clip does not begin early.
 */
export function sessionStartContext(input: {
  targetSample: number
  playOriginSample: number
  playOriginCtx: number
  sampleRate: number
  nowCtx: number
  horizonSec: number
  leadSec?: number
}): number | null {
  const rate = input.sampleRate > 0 ? input.sampleRate : 1
  const when = input.playOriginCtx + (input.targetSample - input.playOriginSample) / rate
  if (when > input.nowCtx + input.horizonSec) return null
  return Math.max(when, input.nowCtx + (input.leadSec ?? 0.01))
}

/** A clip loops unless Loop is off. Repeat mode always loops. */
export function clipLoops(clip: { loop?: boolean; mode?: string }): boolean {
  return clip.mode === 'repeat' || clip.loop !== false
}

/**
 * The clip already sounding keeps going until the next launch reaches the grid.
 * Same generation means this clip is the one that should be sounding.
 */
export function holdUntilGrid(input: {
  sounding: boolean
  sameGeneration: boolean
  nowCtx: number
  targetSample: number
  playOriginSample: number
  playOriginCtx: number
  sampleRate: number
}): boolean {
  if (!input.sounding || input.sameGeneration) return false
  const rate = input.sampleRate > 0 ? input.sampleRate : 1
  const when = input.playOriginCtx + (input.targetSample - input.playOriginSample) / rate
  return when > input.nowCtx + 0.02
}

export interface SlotHandoff {
  clipId: string
  at: number
}

/** The clip that is still audible while a different launch waits for the grid. */
export function handoffAfter(
  prev: { launched: Record<string, string | null | undefined>; at: Record<string, number | undefined> },
  next: { launched: Record<string, string | null | undefined>; at: Record<string, number | undefined> },
  nowSample: number,
): Record<string, SlotHandoff> {
  const handoff: Record<string, SlotHandoff> = {}
  const ids = new Set([...Object.keys(prev.launched), ...Object.keys(next.launched)])
  for (const id of ids) {
    const before = prev.launched[id]
    const after = next.launched[id]
    const beforeAt = prev.at[id] ?? 0
    const afterAt = next.at[id]
    if (!before || beforeAt > nowSample + 1) continue
    if (!after || afterAt == null || afterAt <= nowSample + 0.5) continue
    if (before !== after || afterAt > beforeAt + 1) handoff[id] = { clipId: before, at: beforeAt }
  }
  return handoff
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

/**
 * One slot's indicator. The clip still sounding stays "playing" while the next
 * one waits on the grid. A clip that has not started yet is queued.
 */
export function slotDisplay(input: {
  clipId: string | null
  launchedId: string | null
  handoffId?: string | null
  handoffAt?: number
  now: number
  launchAt?: number
  stopAt?: number
  lengthSamples: number
}): { phase: SlotPhase; progress: number } {
  if (!input.clipId) return { phase: 'empty', progress: 0 }
  const length = Math.max(1, input.lengthSamples)
  const waiting = input.launchAt != null && input.now + 1e-3 < input.launchAt
  if (input.handoffId && input.handoffId === input.clipId && waiting) {
    const start = input.handoffAt ?? 0
    const progress = Math.min(1, Math.max(0, ((input.now - start) % length) / length))
    if (input.stopAt != null && input.now + 1e-3 < input.stopAt) return { phase: 'stopping', progress }
    return { phase: 'playing', progress }
  }
  return slotPhase({
    hasClip: true,
    launched: input.launchedId === input.clipId,
    now: input.now,
    launchAt: input.launchAt,
    stopAt: input.stopAt,
    lengthSamples: length,
  })
}

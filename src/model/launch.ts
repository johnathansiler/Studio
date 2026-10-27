import { renderStretch } from '../audio/stretch/engine'
import type { AudioClip, FollowAction, LaunchMode, LaunchQuant, MidiClip, MidiNote, Track } from './types'
import { uid } from './types'
import { beatsToSamples, samplesPerBar, samplesPerQuarter, type TimeSignature } from './time'

export const SESSION_SCENES = 8

export const LAUNCH_QUANTS: LaunchQuant[] = ['none', '1/16', '1/4', '1bar', '2bar', '4bar']

export const QUANT_LABEL: Record<LaunchQuant, string> = {
  none: 'None',
  '1/16': '1/16',
  '1/4': '1/4',
  '1bar': '1 bar',
  '2bar': '2 bars',
  '4bar': '4 bars',
}

export const LAUNCH_MODES: LaunchMode[] = ['trigger', 'gate', 'toggle', 'repeat']

export const FOLLOW_ACTIONS: FollowAction[] = ['none', 'next', 'prev', 'any', 'other', 'stop']

/** Next grid line at or after `sample`. An exact line launches immediately. */
export function quantizeSample(
  sample: number,
  quant: LaunchQuant,
  sampleRate: number,
  tempo: number,
  sig: TimeSignature,
): number {
  const safe = Math.max(0, sample)
  if (quant === 'none') return Math.round(safe)
  const quarter = samplesPerQuarter(sampleRate, tempo)
  const bar = samplesPerBar(sampleRate, tempo, sig)
  const step =
    quant === '1/16' ? quarter / 4 : quant === '1/4' ? quarter : quant === '2bar' ? bar * 2 : quant === '4bar' ? bar * 4 : bar
  if (!(step > 0)) return Math.round(safe)
  const units = safe / step
  const nearest = Math.round(units)
  if (Math.abs(safe - nearest * step) <= 0.5) return Math.round(nearest * step)
  return Math.round(Math.ceil(units - 1e-9) * step)
}

export function followTarget(
  action: FollowAction,
  scene: number,
  sceneCount: number,
  pick: (count: number) => number = Math.random,
): number | 'stop' | null {
  if (sceneCount <= 0 || action === 'none') return null
  if (action === 'stop') return 'stop'
  if (action === 'next') return (scene + 1) % sceneCount
  if (action === 'prev') return (scene - 1 + sceneCount) % sceneCount
  const roll = Math.min(sceneCount - 1, Math.max(0, Math.floor(pick(action === 'other' ? Math.max(1, sceneCount - 1) : sceneCount))))
  if (action === 'any') return roll
  if (sceneCount === 1) return 0
  return roll >= scene ? roll + 1 : roll
}

export function dueFollow(
  launchSample: number,
  followBeats: number,
  nowSample: number,
  sampleRate: number,
  tempo: number,
): boolean {
  if (!(followBeats > 0)) return false
  return nowSample + 1e-3 >= launchSample + beatsToSamples(followBeats, sampleRate, tempo)
}

/** Playback rate that keeps `durationBeats` locked to the tempo. Warp off stays at 1. */
export function warpRate(
  durationSamples: number,
  durationBeats: number | undefined,
  sampleRate: number,
  tempo: number,
  warp: boolean,
): number {
  if (!warp || !durationBeats || durationBeats <= 0 || durationSamples <= 0) return 1
  const musical = beatsToSamples(durationBeats, sampleRate, tempo)
  if (!(musical > 0)) return 1
  const rate = durationSamples / musical
  return Number.isFinite(rate) && rate > 0 ? rate : 1
}

/** Tempo-follow at constant pitch. Output length is the musical length of `durationBeats`. */
export function renderTempoWarp(
  channels: Float32Array[],
  offsetSamples: number,
  durationSamples: number,
  sampleRate: number,
  tempo: number,
  durationBeats: number,
): Float32Array[] {
  const length = Math.max(1, Math.round(durationSamples))
  const musical = Math.max(1, Math.round(beatsToSamples(durationBeats, sampleRate, tempo)))
  const slices = channels.map((channel) => {
    const slice = new Float32Array(length)
    const start = Math.max(0, offsetSamples)
    slice.set(channel.subarray(start, start + length))
    return slice
  })
  if (Math.abs(musical - length) <= 1) return slices
  return renderStretch(slices, sampleRate, { ratio: musical / length, mode: 'tonal' })
}

export function retrigger(mode: LaunchMode, alreadyPlaying: boolean, legato: boolean): 'start' | 'stop' | 'hold' {
  if (mode === 'toggle') return alreadyPlaying ? 'stop' : 'start'
  if (legato && alreadyPlaying) return 'hold'
  return 'start'
}

export interface SessionClock {
  launched: Record<string, string | null>
  at: Record<string, number>
  gen: Record<string, number>
  mode: 'arrangement' | 'session'
}

export interface TransportSlot {
  trackId: string
  clipId: string | null
  timelineSample?: number
}

export interface TransportLaunch {
  action?: string
  trackId?: string
  clipId?: string | null
  timelineSample?: number
  slots?: TransportSlot[]
  gen?: Record<string, number>
}

const emptyClock = (): SessionClock => ({ launched: {}, at: {}, gen: {}, mode: 'arrangement' })

/**
 * Apply a host transport payload as-is. `timelineSample` is already quantized,
 * so the guest does not measure the grid again.
 */
export function applyTransportLaunch(state: SessionClock, cmd: TransportLaunch): SessionClock {
  const action = cmd.action || 'launch'
  const atSample = Number.isFinite(cmd.timelineSample) ? Math.max(0, Math.round(Number(cmd.timelineSample))) : 0
  if (action === 'stop-clips') return { launched: {}, at: {}, gen: { ...state.gen }, mode: 'session' }
  if (action === 'back') return { launched: {}, at: {}, gen: { ...state.gen }, mode: 'arrangement' }
  if (action === 'scene') {
    const launched = { ...state.launched }
    const at = { ...state.at }
    const gen = { ...state.gen }
    for (const slot of cmd.slots || []) {
      launched[slot.trackId] = slot.clipId
      if (slot.clipId) {
        at[slot.trackId] = slot.timelineSample != null ? Math.max(0, Math.round(slot.timelineSample)) : atSample
        const fromHost = cmd.gen?.[slot.trackId]
        gen[slot.trackId] = fromHost != null ? fromHost : (gen[slot.trackId] || 0) + 1
      } else {
        delete at[slot.trackId]
      }
    }
    return { launched, at, gen, mode: 'session' }
  }
  if (!cmd.trackId) return state.mode ? state : emptyClock()
  const launched = { ...state.launched, [cmd.trackId]: cmd.clipId ?? null }
  const at = { ...state.at }
  const gen = { ...state.gen }
  if (cmd.clipId) {
    at[cmd.trackId] = atSample
    gen[cmd.trackId] = cmd.gen?.[cmd.trackId] != null ? cmd.gen[cmd.trackId] : (gen[cmd.trackId] || 0) + 1
  } else {
    delete at[cmd.trackId]
  }
  return { launched, at, gen, mode: 'session' }
}

export function sceneClip(track: Track, scene: number): AudioClip | MidiClip | null {
  if (track.type === 'audio') {
    if (track.audioSlots) {
      const id = track.audioSlots[scene]
      return id ? track.clips.find((clip) => clip.id === id) || null : null
    }
    return track.clips[scene] || null
  }
  if (track.midiSlots) {
    const id = track.midiSlots[scene]
    return id ? track.midiClips.find((clip) => clip.id === id) || null : null
  }
  return track.midiClips[scene] || null
}

export function sceneIndex(track: Track, clipId: string): number {
  const slots = track.type === 'audio' ? track.audioSlots : track.midiSlots
  if (slots) {
    const index = slots.indexOf(clipId)
    if (index >= 0) return index
  }
  const list = track.type === 'audio' ? track.clips : track.midiClips
  const index = list.findIndex((clip) => clip.id === clipId)
  return index >= 0 ? index : 0
}

export function clipById(track: Track, clipId: string): AudioClip | MidiClip | null {
  return track.clips.find((clip) => clip.id === clipId) || track.midiClips.find((clip) => clip.id === clipId) || null
}

export function overdubNotes(clip: MidiClip, notes: Omit<MidiNote, 'id'>[]): MidiClip {
  return {
    ...clip,
    notes: [...clip.notes, ...notes.map((note) => ({ ...note, id: uid('note') }))],
  }
}

/** Open-ended recording keeps the take. A bar count trims it to that many bars. */
export function recordedLength(
  capturedSamples: number,
  recordBars: number,
  sampleRate: number,
  tempo: number,
  sig: TimeSignature,
): number {
  const captured = Math.max(1, Math.round(capturedSamples))
  if (!(recordBars > 0)) return captured
  const fixed = Math.max(1, Math.round(recordBars * samplesPerBar(sampleRate, tempo, sig)))
  return Math.min(captured, fixed)
}

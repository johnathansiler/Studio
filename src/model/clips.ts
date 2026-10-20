import type { AudioClip, MidiNote } from './types'
import { uid } from './types'

export function splitAudioClip(clip: AudioClip, atSample: number): [AudioClip, AudioClip] | null {
  const at = Math.round(atSample)
  const end = clip.startSample + clip.durationSamples
  if (at <= clip.startSample || at >= end) return null
  const leftDur = at - clip.startSample
  const rightDur = clip.durationSamples - leftDur
  const left: AudioClip = {
    ...clip,
    id: uid('clip'),
    durationSamples: leftDur,
    fadeInSamples: Math.min(clip.fadeInSamples, leftDur),
    fadeOutSamples: 0,
  }
  const right: AudioClip = {
    ...clip,
    id: uid('clip'),
    name: `${clip.name} b`,
    startSample: at,
    offsetSamples: clip.offsetSamples + leftDur,
    durationSamples: rightDur,
    fadeInSamples: 0,
    fadeOutSamples: Math.min(clip.fadeOutSamples, rightDur),
  }
  return [left, right]
}

export function trimAudioClip(
  clip: AudioClip,
  edge: 'start' | 'end',
  newSample: number,
  bufferLength: number,
): AudioClip {
  const end = clip.startSample + clip.durationSamples
  if (edge === 'start') {
    const minStart = clip.startSample - clip.offsetSamples
    const maxStart = end - 1
    const start = clamp(Math.round(newSample), minStart, maxStart)
    const delta = start - clip.startSample
    const duration = clip.durationSamples - delta
    return {
      ...clip,
      startSample: start,
      offsetSamples: clip.offsetSamples + delta,
      durationSamples: duration,
      fadeInSamples: Math.min(clip.fadeInSamples, duration),
      fadeOutSamples: Math.min(clip.fadeOutSamples, duration),
    }
  }
  const maxEnd = clip.startSample - clip.offsetSamples + bufferLength
  const nextEnd = clamp(Math.round(newSample), clip.startSample + 1, Math.max(clip.startSample + 1, maxEnd))
  const duration = nextEnd - clip.startSample
  return {
    ...clip,
    durationSamples: duration,
    fadeInSamples: Math.min(clip.fadeInSamples, duration),
    fadeOutSamples: Math.min(clip.fadeOutSamples, duration),
  }
}

export function moveAudioClip(clip: AudioClip, newStart: number): AudioClip {
  return { ...clip, startSample: Math.max(0, Math.round(newStart)) }
}

export function clampFade(clip: AudioClip, edge: 'in' | 'out', samples: number): AudioClip {
  const max = Math.max(0, clip.durationSamples)
  const value = clamp(Math.round(samples), 0, max)
  return edge === 'in' ? { ...clip, fadeInSamples: value } : { ...clip, fadeOutSamples: value }
}

export function moveMidiNote(note: MidiNote, startBeat: number, pitch: number): MidiNote {
  return {
    ...note,
    startBeat: Math.max(0, startBeat),
    pitch: clamp(Math.round(pitch), 0, 127),
  }
}

export function resizeMidiNote(note: MidiNote, durationBeats: number): MidiNote {
  return { ...note, durationBeats: Math.max(1 / 16, durationBeats) }
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

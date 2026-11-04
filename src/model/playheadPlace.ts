import { projectSampleBeat } from './tempoMap'
import type { AudioClip, MidiClip, Project } from './types'

/** Where the playhead is, with no extra snap. */
export interface Playhead {
  sample: number
  beat: number
}

export function readPlayhead(project: Project, sample: number): Playhead {
  const at = Math.max(0, Number.isFinite(sample) ? sample : 0)
  return { sample: at, beat: projectSampleBeat(project, at) }
}

export function isAudioArrangeClip(clip: AudioClip | MidiClip): clip is AudioClip {
  return 'bufferId' in clip && !('notes' in clip)
}

/** Stamp a new clip so it starts at the playhead. Notes inside a MIDI clip stay relative. */
export function stampClipAtPlayhead<T extends AudioClip | MidiClip>(clip: T, playhead: Playhead): T {
  if (isAudioArrangeClip(clip)) {
    return { ...clip, startSample: Math.round(playhead.sample) }
  }
  return { ...clip, startBeat: playhead.beat }
}

/** 0..1 across the file. Loops wrap. A finished one-shot stays at the end. */
export function previewHeadRatio(now: number, start: number, duration: number, loop: boolean) {
  if (!(duration > 0) || !Number.isFinite(now) || !Number.isFinite(start)) return { ratio: 0, done: true }
  const elapsed = Math.max(0, now - start)
  const wrapped = loop ? elapsed % duration : Math.min(elapsed, duration)
  return { ratio: wrapped / duration, done: !loop && elapsed >= duration - 1e-3 }
}

export function waveformPeaks(channel: Float32Array, buckets = 48) {
  const count = Math.max(1, buckets)
  const peaks = new Array<number>(count).fill(0)
  if (!channel.length) return peaks
  const size = Math.max(1, Math.floor(channel.length / count))
  let max = 0
  for (let i = 0; i < count; i++) {
    const from = i * size
    const to = i === count - 1 ? channel.length : from + size
    let peak = 0
    for (let j = from; j < to; j++) peak = Math.max(peak, Math.abs(channel[j] || 0))
    peaks[i] = peak
    max = Math.max(max, peak)
  }
  if (max <= 1e-8) return peaks
  return peaks.map((peak) => peak / max)
}

/** How many bars a tempo-synced loop covers. */
export function loopBarCount(durationSeconds: number, tempo: number, quartersPerBar: number) {
  if (!(durationSeconds > 0) || !(tempo > 0)) return 0
  const beats = durationSeconds * (tempo / 60)
  return Math.max(1, Math.round(beats / Math.max(1, quartersPerBar)))
}

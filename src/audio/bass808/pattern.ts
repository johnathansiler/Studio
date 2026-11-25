/** A two-bar trap/drill bass line in the song key, with slides marked. */

import { scaleById } from '../../model/scale'

export interface PatternNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  slide?: boolean
}

export interface SlideNote {
  id: string
  pitch: number
  startBeat: number
  durationBeats: number
  slide?: boolean
}

/** The note a slide arrives on, and the note it leaves. */
export function slideLinks<T extends SlideNote>(notes: readonly T[]): { from: T; to: T }[] {
  const sorted = notes.slice().sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  const links: { from: T; to: T }[] = []
  for (const note of sorted) {
    if (!note.slide) continue
    let from: T | null = null
    let end = -Infinity
    for (const other of sorted) {
      if (other === note) continue
      const stop = other.startBeat + other.durationBeats
      if (stop <= note.startBeat + 0.02 && stop >= end) {
        end = stop
        from = other
      }
    }
    if (from) links.push({ from, to: note })
  }
  return links
}

/**
 * Eight beats of 808 slides. Every pitch is a scale tone of `root`.
 * Slide notes overlap the one before them so legato glide has a source.
 */
/** Eight bass pads in the song key, starting on the root. */
export function bassPadPitches(root: number, scaleId: string | undefined, count = 8) {
  const scale = scaleById(scaleId)
  const pc = ((Math.round(root) % 12) + 12) % 12
  const base = 36 + pc
  const len = Math.max(1, scale.intervals.length)
  return Array.from({ length: count }, (_, index) => {
    const wrapped = index % len
    const oct = Math.floor(index / len)
    return Math.max(0, Math.min(127, base + scale.intervals[wrapped] + oct * 12))
  })
}

export function drillTrapPattern(root: number, scaleId: string | undefined): PatternNote[] {
  const scale = scaleById(scaleId)
  const pc = ((Math.round(root) % 12) + 12) % 12
  const base = 36 + pc
  const tone = (degree: number, oct = 0) => {
    const len = Math.max(1, scale.intervals.length)
    const wrapped = ((degree % len) + len) % len
    const extra = Math.floor(degree / len)
    return Math.max(0, Math.min(127, base + scale.intervals[wrapped] + (oct + extra) * 12))
  }
  return [
    // Punches start after the previous note. Slides overlap it so legato has a source.
    { pitch: tone(0), startBeat: 0, durationBeats: 1.15, velocity: 0.96 },
    { pitch: tone(4), startBeat: 1, durationBeats: 0.7, velocity: 0.8, slide: true },
    { pitch: tone(0, 1), startBeat: 1.9, durationBeats: 0.5, velocity: 0.9 },
    { pitch: tone(6), startBeat: 2.28, durationBeats: 0.72, velocity: 0.76, slide: true },
    { pitch: tone(0), startBeat: 2.9, durationBeats: 0.7, velocity: 0.84, slide: true },
    { pitch: tone(0), startBeat: 4, durationBeats: 1.05, velocity: 0.96 },
    { pitch: tone(2), startBeat: 4.9, durationBeats: 0.55, velocity: 0.74, slide: true },
    { pitch: tone(4), startBeat: 5.6, durationBeats: 0.55, velocity: 0.82 },
    { pitch: tone(0, -1), startBeat: 6.02, durationBeats: 0.7, velocity: 0.7, slide: true },
    { pitch: tone(0), startBeat: 6.58, durationBeats: 1.4, velocity: 0.9, slide: true },
  ]
}

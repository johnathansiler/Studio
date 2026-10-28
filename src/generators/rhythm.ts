import type { ResolvedChord } from './chords'
import { roundBeat, swingTime } from './rng'
import type { Style } from './styles'
import type { GeneratedNote, GeneratorInput, StrumPattern } from './types'

interface StrumHit {
  at: number
  dur: number
  vel: number
  dir: -1 | 0 | 1
}

const PATTERNS: Record<StrumPattern, StrumHit[]> = {
  block: [{ at: 0, dur: 3.6, vel: 0.8, dir: 0 }],
  down: [{ at: 0, dur: 1.6, vel: 0.82, dir: 1 }, { at: 2, dur: 1.5, vel: 0.74, dir: 1 }],
  folk: [
    { at: 0, dur: 0.7, vel: 0.84, dir: 1 },
    { at: 1, dur: 0.4, vel: 0.7, dir: 1 },
    { at: 1.5, dur: 0.4, vel: 0.66, dir: -1 },
    { at: 2, dur: 0.4, vel: 0.72, dir: -1 },
    { at: 2.5, dur: 0.4, vel: 0.7, dir: 1 },
    { at: 3.5, dur: 0.35, vel: 0.64, dir: -1 },
  ],
  skank: [
    { at: 0.5, dur: 0.22, vel: 0.78, dir: 0 },
    { at: 1.5, dur: 0.22, vel: 0.74, dir: 0 },
    { at: 2.5, dur: 0.22, vel: 0.78, dir: 0 },
    { at: 3.5, dur: 0.2, vel: 0.7, dir: 0 },
  ],
  funk: [
    { at: 0, dur: 0.12, vel: 0.86, dir: 0 },
    { at: 0.75, dur: 0.1, vel: 0.62, dir: 0 },
    { at: 1.5, dur: 0.12, vel: 0.8, dir: 0 },
    { at: 2.25, dur: 0.1, vel: 0.58, dir: 0 },
    { at: 2.75, dur: 0.1, vel: 0.7, dir: 0 },
    { at: 3.5, dur: 0.12, vel: 0.76, dir: 0 },
  ],
  disco: [
    { at: 0.5, dur: 0.28, vel: 0.8, dir: 0 },
    { at: 1.5, dur: 0.28, vel: 0.76, dir: 0 },
    { at: 2.5, dur: 0.28, vel: 0.8, dir: 0 },
    { at: 3.5, dur: 0.24, vel: 0.72, dir: 0 },
  ],
  jazz: [
    { at: 0, dur: 0.4, vel: 0.7, dir: 0 },
    { at: 1.5, dur: 0.35, vel: 0.62, dir: 0 },
    { at: 3, dur: 0.3, vel: 0.58, dir: 0 },
  ],
  tresillo: [
    { at: 0, dur: 0.4, vel: 0.84, dir: 0 },
    { at: 1.5, dur: 0.35, vel: 0.76, dir: 0 },
    { at: 3, dur: 0.35, vel: 0.74, dir: 0 },
  ],
  rock: [
    { at: 0, dur: 0.4, vel: 0.86, dir: 1 },
    { at: 1, dur: 0.35, vel: 0.74, dir: 1 },
    { at: 1.5, dur: 0.2, vel: 0.6, dir: -1 },
    { at: 2, dur: 0.4, vel: 0.82, dir: 1 },
    { at: 3, dur: 0.35, vel: 0.72, dir: 1 },
    { at: 3.5, dur: 0.2, vel: 0.58, dir: -1 },
  ],
  afro: [
    { at: 0.5, dur: 0.28, vel: 0.78, dir: 0 },
    { at: 1.5, dur: 0.24, vel: 0.7, dir: 0 },
    { at: 2, dur: 0.28, vel: 0.8, dir: 0 },
    { at: 3.25, dur: 0.24, vel: 0.68, dir: 0 },
  ],
  gospel: [
    { at: 0, dur: 1.2, vel: 0.82, dir: 1 },
    { at: 1.5, dur: 0.4, vel: 0.68, dir: 0 },
    { at: 3.5, dur: 0.28, vel: 0.74, dir: 1 },
  ],
  montuno: [
    { at: 0, dur: 0.22, vel: 0.8, dir: 0 },
    { at: 0.75, dur: 0.18, vel: 0.64, dir: 0 },
    { at: 1.5, dur: 0.22, vel: 0.76, dir: 0 },
    { at: 2, dur: 0.2, vel: 0.7, dir: 0 },
    { at: 2.75, dur: 0.18, vel: 0.66, dir: 0 },
    { at: 3.5, dur: 0.2, vel: 0.74, dir: 0 },
  ],
}

export function rhythmNotes(chords: ResolvedChord[], style: Style, input: GeneratorInput): GeneratedNote[] {
  const pattern = input.options?.strum ?? style.strum
  const hits = PATTERNS[pattern] ?? PATTERNS.block
  const notes: GeneratedNote[] = []
  for (const chord of chords) {
    const tones = chord.pitches.map((pitch, index) => ({ pitch, fine: chord.cents?.[index] || 0 })).sort((a, b) => a.pitch - b.pitch)
    let origin = 0
    while (origin < chord.beats - 0.02) {
      const window = Math.min(4, chord.beats - origin)
      for (const hit of hits) {
        if (hit.at >= window - 0.001) continue
        const at = swingTime(chord.start + origin + hit.at, style.swing)
        const ordered = hit.dir < 0 ? [...tones].reverse() : tones
        ordered.forEach((tone, index) => {
          const stagger = hit.dir === 0 ? 0 : index * 0.02
          notes.push({
            pitch: tone.pitch,
            fine: tone.fine || undefined,
            startBeat: roundBeat(at + stagger),
            durationBeats: roundBeat(Math.max(0.08, Math.min(hit.dur, chord.start + chord.beats - at - stagger - 0.02))),
            velocity: hit.vel,
          })
        })
      }
      origin += 4
    }
  }
  return notes
}

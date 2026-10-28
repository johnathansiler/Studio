import { surfaceRng } from './chords'
import { roundBeat, swingTime } from './rng'
import { rowVelocities, type Style } from './styles'
import type { GeneratedNote, GeneratorInput } from './types'

const KICK = 36
const SNARE = 38
const HAT = 42

export function drumNotes(style: Style, input: GeneratorInput): GeneratedNote[] {
  const rng = surfaceRng(input, 8)
  const bar = input.beatsPerBar ?? 4
  const steps = Math.max(1, Math.round(bar * 4))
  const notes: GeneratedNote[] = []
  const lanes = [
    { pitch: KICK, row: rowVelocities(style.drums.kick), dur: 0.22 },
    { pitch: SNARE, row: rowVelocities(style.drums.snare), dur: 0.18 },
    { pitch: HAT, row: rowVelocities(style.drums.hat), dur: 0.08 },
    ...(style.drums.extra ?? []).map((extra) => ({ pitch: extra.pitch, row: rowVelocities(extra.row), dur: extra.pitch === 46 || extra.pitch === 51 || extra.pitch === 49 ? 0.35 : 0.12 })),
  ]
  for (let barIndex = 0; barIndex < input.bars; barIndex++) {
    for (const lane of lanes) {
      for (let step = 0; step < steps; step++) {
        const velocity = lane.row[step % lane.row.length]
        if (velocity <= 0) continue
        const beat = barIndex * bar + step / 4
        notes.push({
          pitch: lane.pitch,
          startBeat: roundBeat(swingTime(beat, style.swing)),
          durationBeats: lane.dur,
          velocity,
        })
      }
    }
    if (style.rolls) {
      for (let step = 1; step < steps * 2; step += 2) {
        if (rng() > 0.48) continue
        notes.push({
          pitch: HAT,
          startBeat: roundBeat(barIndex * bar + step / 8),
          durationBeats: 0.06,
          velocity: 0.28 + rng() * 0.25,
        })
      }
    }
    if (barIndex === input.bars - 1 && rng() > 0.4) {
      const start = barIndex * bar + Math.max(0, bar - 1)
      for (let step = 0; step < 4; step++) {
        notes.push({
          pitch: SNARE,
          startBeat: roundBeat(start + step / 4),
          durationBeats: 0.1,
          velocity: 0.45 + step * 0.1,
        })
      }
    }
  }
  return notes
}

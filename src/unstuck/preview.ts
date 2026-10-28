/** Preview notes: the previous chord, then the suggestion, at the song tempo. */

import { spellSymbol } from '../model/progressions'
import { voiceChord } from '../model/scale'
import { normalizeSongContext } from './context'
import type { SongContextInput, Suggestion } from './types'

export interface AuditionNote {
  pitch: number
  /** Seconds from the start of the preview. */
  at: number
  dur: number
  velocity: number
  drum: boolean
}

export function audition(input: SongContextInput, suggestion: Suggestion): AuditionNote[] {
  const context = normalizeSongContext(input)
  const beat = 60 / context.tempo
  const events: AuditionNote[] = []
  let offset = 0
  if (suggestion.hear === 'continue') {
    const tail = context.chordsByBar.at(-1)
    const pitches = tailPitches(tail?.pitches, tail?.symbol, context.mode, context.key)
    if (pitches.length) {
      const voiced = voiceChord(pitches)
      const bars = Math.min(context.beatsPerBar, tail?.beats || context.beatsPerBar)
      for (const pitch of voiced) {
        events.push({ pitch, at: 0, dur: bars * beat * 0.92, velocity: 0.7, drum: false })
      }
      offset = bars
    }
  }
  for (const part of suggestion.parts) {
    const drum = part.role === 'drums' || part.role === 'fill'
    for (const note of part.notes) {
      events.push({
        pitch: note.pitch,
        at: (offset + note.startBeat) * beat,
        dur: Math.max(0.05, note.durationBeats) * beat,
        velocity: note.velocity,
        drum,
      })
    }
  }
  return events
}

function tailPitches(pitches: number[] | undefined, symbol: string | undefined, mode: 'major' | 'minor', key: number): number[] {
  if (pitches?.length) return pitches
  if (!symbol || !isNumeral(symbol)) return []
  return spellSymbol(symbol, mode, key).pitches
}

function isNumeral(symbol: string): boolean {
  return /^[#b]*(i{1,3}|iv|vi{0,3}|v)/i.test(symbol.trim())
}

/** Turn roman numerals into notes a track can hold. */

import { spellSymbol, type Mode } from '../model/progressions'
import { voiceChord } from '../model/scale'
import type { SectionKind, SuggestionNote, SuggestionPart } from './types'

export type Groove = 'pop' | 'edm' | 'trap' | 'sparse'

export function grooveFor(tempo: number, mode: Mode, kind?: SectionKind): Groove {
  if (kind === 'breakdown' || kind === 'outro' || kind === 'intro') return 'sparse'
  if (tempo >= 126 && mode === 'minor' && (kind === 'drop' || kind === 'chorus')) return 'trap'
  if (tempo >= 118 && (kind === 'drop' || kind === 'chorus')) return 'edm'
  return 'pop'
}

export function renderHarmony(symbols: string[], mode: Mode, key: number, beatsPerBar: number, band: 'chords' | 'band' | 'pad', groove: Groove = 'pop'): SuggestionPart[] {
  const chords: SuggestionNote[] = []
  const bass: SuggestionNote[] = []
  const drums: SuggestionNote[] = []
  const pad: SuggestionNote[] = []
  let previous: number[] = []
  symbols.forEach((symbol, index) => {
    const spelled = spellSymbol(symbol, mode, key)
    const voiced = voiceChord(spelled.pitches, { voiceLead: previous.length > 0, previous })
    previous = voiced
    const start = index * beatsPerBar
    const held = Math.max(0.25, beatsPerBar - 0.08)
    for (const pitch of voiced) {
      chords.push({ pitch, startBeat: start, durationBeats: held, velocity: 0.74 })
      if (band === 'pad') pad.push({ pitch: pitch + 12, startBeat: start, durationBeats: beatsPerBar - 0.02, velocity: 0.42 })
    }
    if (band !== 'pad') bass.push({ pitch: bassPitch(spelled.pc), startBeat: start, durationBeats: Math.min(beatsPerBar * 0.9, beatsPerBar - 0.05), velocity: 0.78 })
    if (band === 'band') drums.push(...drumBar(groove, start, beatsPerBar))
  })
  const parts: SuggestionPart[] = []
  if (band === 'pad') parts.push({ role: 'pad', notes: pad })
  else parts.push({ role: 'chords', notes: chords }, { role: 'bass', notes: bass })
  if (drums.length) parts.push({ role: 'drums', notes: drums })
  return parts
}

export function bedParts(symbols: string[], mode: Mode, key: number, beatsPerBar: number): SuggestionPart[] {
  return renderHarmony(symbols.length ? symbols : [mode === 'minor' ? 'i' : 'I'], mode, key, beatsPerBar, 'chords').map((part) => ({ ...part, write: false }))
}

export function halfTimeDrums(bars: number, beatsPerBar: number): SuggestionNote[] {
  const notes: SuggestionNote[] = []
  for (let bar = 0; bar < bars; bar++) {
    const start = bar * beatsPerBar
    notes.push({ pitch: 36, startBeat: start, durationBeats: 0.3, velocity: 0.9 })
    notes.push({ pitch: 38, startBeat: start + beatsPerBar / 2, durationBeats: 0.25, velocity: 0.82 })
    for (let hat = 0; hat < beatsPerBar; hat += 1) {
      notes.push({ pitch: 42, startBeat: start + hat, durationBeats: 0.1, velocity: 0.34 })
    }
  }
  return notes
}

export function fillNotes(beatsPerBar: number): SuggestionNote[] {
  const start = Math.max(0, beatsPerBar - 1)
  const notes: SuggestionNote[] = []
  notes.push({ pitch: 36, startBeat: start, durationBeats: 0.2, velocity: 0.8 })
  for (let step = 0; step < 4; step++) {
    notes.push({ pitch: 38, startBeat: start + step * 0.25, durationBeats: 0.18, velocity: 0.5 + step * 0.1 })
  }
  notes.push({ pitch: 49, startBeat: Math.max(0, beatsPerBar - 0.25), durationBeats: 0.22, velocity: 0.7 })
  return notes
}

export function riserNotes(key: number, mode: Mode, beatsPerBar: number): { line: SuggestionNote[]; drums: SuggestionNote[] } {
  const scale = mode === 'minor' ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11]
  const start = Math.max(0, beatsPerBar - 2)
  const line: SuggestionNote[] = []
  const steps = 8
  for (let index = 0; index < steps; index++) {
    const degree = scale[index % scale.length]
    const octave = Math.floor(index / scale.length)
    line.push({
      pitch: 60 + ((key % 12) + 12) % 12 + degree + octave * 12,
      startBeat: start + (index * 2) / steps,
      durationBeats: 0.2,
      velocity: 0.42 + index * 0.04,
    })
  }
  const drums: SuggestionNote[] = []
  for (let index = 0; index < 8; index++) {
    drums.push({
      pitch: index > 5 ? 46 : 42,
      startBeat: start + index * 0.25,
      durationBeats: 0.1,
      velocity: 0.28 + index * 0.05,
    })
  }
  drums.push({ pitch: 49, startBeat: Math.max(0, beatsPerBar - 0.25), durationBeats: 0.22, velocity: 0.72 })
  return { line, drums }
}

export function pickupNotes(key: number, mode: Mode, beatsPerBar: number): SuggestionNote[] {
  const degrees = mode === 'minor' ? [7, 8, 10] : [7, 9, 11]
  const start = Math.max(0, beatsPerBar - 1.5)
  return degrees.map((degree, index) => ({
    pitch: 72 + ((key % 12) + 12) % 12 + degree,
    startBeat: start + index * 0.5,
    durationBeats: 0.42,
    velocity: 0.62,
  }))
}

export function symbolsInSpan(chords: { bar: number; symbol: string }[], startBar: number, bars: number, fallback: string): string[] {
  const symbols: string[] = []
  for (let bar = startBar; bar < startBar + bars; bar++) {
    const found = chords.find((chord) => chord.bar === bar)
    symbols.push(found?.symbol || symbols.at(-1) || fallback)
  }
  return symbols
}

function drumBar(groove: Groove, start: number, beats: number): SuggestionNote[] {
  const notes: SuggestionNote[] = []
  const add = (pitch: number, beatsIn: number[], velocity: number, duration = 0.2) => {
    for (const beat of beatsIn) {
      if (beat < beats) notes.push({ pitch, startBeat: start + beat, durationBeats: duration, velocity })
    }
  }
  if (groove === 'trap') {
    add(36, [0, 0.75, 2.5], 0.9, 0.25)
    add(38, [2], 0.8)
    add(42, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].filter((beat) => beat < beats), 0.4, 0.08)
  } else if (groove === 'edm') {
    add(36, [0, 1, 2, 3], 0.9, 0.25)
    add(38, [1, 3], 0.7)
    add(42, [0.5, 1.5, 2.5, 3.5], 0.45, 0.08)
  } else if (groove === 'sparse') {
    add(36, [0], 0.75, 0.4)
    add(42, [0, beats / 2], 0.28, 0.12)
  } else {
    const quarter = beats / 4
    add(36, [0, beats / 2], 0.86, 0.25)
    add(38, [quarter, quarter * 3], 0.78)
    const hats: number[] = []
    for (let beat = 0.5; beat < beats; beat += 1) hats.push(beat)
    add(42, hats, 0.38, 0.08)
  }
  return notes
}

function bassPitch(pc: number): number {
  return 36 + ((pc % 12) + 12) % 12
}

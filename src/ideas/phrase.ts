/** Keep generated and varied notes from stacking on themselves. */

import type { PartNote } from './types'

export function settleNotes(notes: PartNote[], role: string): PartNote[] {
  const sorted = notes
    .map((note) => ({ ...note }))
    .filter((note) => note.durationBeats >= 0.05 && note.velocity > 0)
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  if (role === 'drums') return settleDrums(sorted)
  if (role === 'chords' || role === 'pad') return settleChords(sorted)
  return settleLine(sorted)
}

function settleDrums(notes: PartNote[]) {
  const kept: PartNote[] = []
  for (const note of notes) {
    const clash = kept.find((item) => item.pitch === note.pitch && Math.abs(item.startBeat - note.startBeat) < 0.045)
    if (clash) {
      if (note.velocity > clash.velocity) clash.velocity = note.velocity
      continue
    }
    kept.push(note)
  }
  return kept
}

function settleChords(notes: PartNote[]) {
  const kept: PartNote[] = []
  for (const note of notes) {
    const same = kept.find((item) => item.pitch === note.pitch && note.startBeat < item.startBeat + item.durationBeats - 0.02)
    if (!same) {
      kept.push(note)
      continue
    }
    if (note.startBeat - same.startBeat < 0.04) {
      if (note.velocity > same.velocity) same.velocity = note.velocity
      continue
    }
    same.durationBeats = Math.max(0.08, note.startBeat - same.startBeat - 0.02)
    kept.push(note)
  }
  return kept.filter((note) => note.durationBeats >= 0.05)
}

function settleLine(notes: PartNote[]) {
  const kept: PartNote[] = []
  for (const note of notes) {
    const previous = kept[kept.length - 1]
    if (previous && note.startBeat - previous.startBeat < 0.09) {
      if (note.velocity >= previous.velocity) kept[kept.length - 1] = note
      continue
    }
    if (previous && previous.startBeat + previous.durationBeats > note.startBeat - 0.02) {
      previous.durationBeats = Math.max(0.05, note.startBeat - previous.startBeat - 0.02)
    }
    kept.push(note)
  }
  return kept.filter((note) => note.durationBeats >= 0.05)
}

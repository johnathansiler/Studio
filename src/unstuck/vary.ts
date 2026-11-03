/**
 * A variation keeps the clip's key, function, and contour, then dresses it.
 * Subtle ornaments. Medium moves rhythm and voicing. Wild substitutes and rebuilds the line.
 */

import { getScale } from '../theory/scales'
import { hashSeed, mulberry32, roundBeat } from '../generators/rng'
import { ensureScale, type AmountId } from './brief'
import type { ClipPicture, DraftNote } from './draft'

const STEP: Record<AmountId, number> = { subtle: 1, medium: 2, wild: 4 }

export function varyNotes(picture: ClipPicture, amount: AmountId, seed: number, scaleId: string, key: number): DraftNote[] {
  const rng = mulberry32(hashSeed(seed, STEP[amount], 11))
  const scale = scaleClasses(scaleId, key)
  if (picture.role === 'drums') return varyDrums(picture.notes, amount, rng)
  if (picture.role === 'chords' || picture.role === 'pad') return varyChords(picture.notes, amount, rng, scale)
  return varyLine(picture.notes, amount, rng, scale, picture.role === 'bass')
}

function varyDrums(notes: DraftNote[], amount: AmountId, rng: () => number): DraftNote[] {
  const out = notes.map((note) => ({
    ...note,
    velocity: clampVel(note.velocity * (0.92 + rng() * 0.16)),
  }))
  if (amount === 'subtle') {
    for (const note of notes) {
      if (note.pitch !== 38 || rng() > 0.7) continue
      const at = note.startBeat - 0.25
      if (at < 0 || out.some((item) => Math.abs(item.startBeat - at) < 0.05 && item.pitch === 38)) continue
      out.push({ pitch: 38, startBeat: at, durationBeats: 0.08, velocity: 0.28 })
    }
    return sort(out)
  }
  const moved = out.map((note) => {
    if (note.pitch !== 42 || note.velocity > 0.75) return note
    const shift = amount === 'wild' ? (rng() > 0.5 ? 0.25 : -0.25) : 0.25
    return { ...note, startBeat: Math.max(0, roundBeat(note.startBeat + shift)), velocity: clampVel(note.velocity * 0.9) }
  })
  const end = notes.reduce((max, note) => Math.max(max, note.startBeat + note.durationBeats), 1)
  const fillFrom = Math.max(0, end - (amount === 'wild' ? 2 : 1))
  if (amount === 'wild') {
    const kept = moved.filter((note) => note.pitch === 36 || note.startBeat < fillFrom)
    for (let beat = fillFrom; beat < end - 0.05; beat += 0.25) {
      kept.push({ pitch: rng() > 0.25 ? 38 : 42, startBeat: roundBeat(beat), durationBeats: 0.1, velocity: 0.45 + (beat - fillFrom) * 0.2 })
    }
    return sort(kept)
  }
  for (let beat = fillFrom; beat < end - 0.05; beat += 0.5) {
    moved.push({ pitch: 38, startBeat: roundBeat(beat), durationBeats: 0.1, velocity: 0.55 })
  }
  return sort(moved)
}

function varyChords(notes: DraftNote[], amount: AmountId, rng: () => number, scale: number[]): DraftNote[] {
  const groups = group(notes)
  const out: DraftNote[] = []
  groups.forEach((chord, index) => {
    const inversion = amount === 'subtle' ? 1 : amount === 'medium' ? 1 + (index % 2) : index % 3
    let voiced = invert(chord, inversion)
    if (amount !== 'subtle') voiced = voiced.map((note) => dropVoicing(note, chord, amount))
    if (amount === 'wild' && index > 0 && index < groups.length - 1 && rng() > 0.45) {
      voiced = substitute(voiced, scale, rng)
    }
    if (amount !== 'subtle' && chord.length >= 2 && rng() > 0.4) {
      const top = Math.max(...voiced.map((note) => note.pitch))
      const extension = scale.find((pitchClass) => !voiced.some((note) => pc(note.pitch) === pitchClass))
      if (extension != null) {
        let pitch = top - pc(top) + extension
        while (pitch <= top) pitch += 12
        if (pitch < 96) voiced.push({ ...voiced[0], pitch, startBeat: voiced[0].startBeat, durationBeats: voiced[0].durationBeats, velocity: 0.62 })
      }
    }
    const rhythm = amount === 'subtle' ? 0 : amount === 'medium' ? 0.5 : 0.25
    if (rhythm && index % 2 === 1) {
      for (const note of voiced) out.push({ ...note, startBeat: roundBeat(note.startBeat + rhythm), durationBeats: Math.max(0.2, note.durationBeats - rhythm) })
    } else {
      out.push(...voiced)
    }
    if (amount === 'wild' && index < groups.length - 1) {
      const next = groups[index + 1]
      const gap = next[0].startBeat - (chord[0].startBeat + 0.5)
      if (gap > 0.4) {
        const passing = invert(chord, 2).map((note) => ({
          ...note,
          pitch: nearestScale(note.pitch + 1, scale),
          startBeat: roundBeat(next[0].startBeat - 0.5),
          durationBeats: 0.45,
          velocity: 0.55,
        }))
        out.push(...passing)
      }
    }
  })
  return sort(out)
}

function varyLine(notes: DraftNote[], amount: AmountId, rng: () => number, scale: number[], bass: boolean): DraftNote[] {
  if (!notes.length) return []
  const floor = bass ? 28 : 52
  const ceil = bass ? 55 : 84
  const out: DraftNote[] = []
  notes.forEach((note, index) => {
    const next = notes[index + 1]
    const direction = next ? Math.sign(next.pitch - note.pitch) : 0
    if (amount === 'subtle') {
      out.push(note)
      if (note.durationBeats >= 0.75 && rng() > 0.45) {
        const ornament = nearestScale(note.pitch + (rng() > 0.5 ? 1 : -1), scale)
        out.push({
          pitch: clampPitch(ornament, floor, ceil),
          startBeat: roundBeat(note.startBeat + note.durationBeats * 0.55),
          durationBeats: Math.max(0.12, note.durationBeats * 0.3),
          velocity: clampVel(note.velocity * 0.75),
        })
      }
      return
    }
    const shift = amount === 'wild' ? (index % 2 === 0 ? 0 : 0.25) : index % 3 === 2 ? 0.25 : 0
    let pitch = note.pitch
    if (amount === 'wild' && index > 0 && index < notes.length - 1) {
      const leap = direction === 0 ? 2 : direction * (2 + (rng() > 0.5 ? 2 : 0))
      pitch = nearestScale(notes[0].pitch + (note.pitch - notes[0].pitch) + leap * 0, scale)
      pitch = nearestScale(note.pitch + direction * 2, scale)
    }
    out.push({
      ...note,
      pitch: clampPitch(pitch, floor, ceil),
      startBeat: roundBeat(Math.max(0, note.startBeat + shift)),
      durationBeats: Math.max(0.12, note.durationBeats - (shift ? 0.1 : 0)),
      velocity: clampVel(note.velocity * (0.9 + rng() * 0.2)),
    })
    if (amount === 'wild' && note.durationBeats >= 0.5 && rng() > 0.55) {
      out.push({
        pitch: clampPitch(nearestScale(pitch + (direction || 1), scale), floor, ceil),
        startBeat: roundBeat(note.startBeat + note.durationBeats * 0.5),
        durationBeats: 0.2,
        velocity: 0.5,
      })
    }
  })
  if (out.length) {
    out[0].pitch = notes[0].pitch
    out[out.length - 1].pitch = pc(notes[notes.length - 1].pitch) === pc(out[out.length - 1].pitch)
      ? out[out.length - 1].pitch
      : nearestScale(notes[notes.length - 1].pitch, scale)
  }
  return sort(out)
}

function group(notes: DraftNote[]) {
  const groups: DraftNote[][] = []
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)) {
    const last = groups[groups.length - 1]
    if (!last || Math.abs(note.startBeat - last[0].startBeat) > 0.08) groups.push([note])
    else last.push(note)
  }
  return groups
}

function invert(chord: DraftNote[], times: number): DraftNote[] {
  const voiced = [...chord].sort((a, b) => a.pitch - b.pitch)
  const count = voiced.length ? times % voiced.length : 0
  for (let i = 0; i < count; i++) {
    const low = voiced.shift()
    if (!low) break
    voiced.push({ ...low, pitch: low.pitch + 12 })
  }
  return voiced
}

function dropVoicing(note: DraftNote, chord: DraftNote[], amount: AmountId): DraftNote {
  const sorted = [...chord].sort((a, b) => a.pitch - b.pitch)
  const fromTop = sorted.length - 1 - sorted.findIndex((item) => item.pitch === note.pitch && item.startBeat === note.startBeat)
  if (amount === 'medium' && fromTop === 1 && note.pitch - 12 >= 48) return { ...note, pitch: note.pitch - 12 }
  return note
}

function substitute(chord: DraftNote[], scale: number[], rng: () => number): DraftNote[] {
  const step = rng() > 0.5 ? 2 : -2
  return chord.map((note) => ({ ...note, pitch: nearestScale(note.pitch + step, scale) }))
}

function scaleClasses(scaleId: string, key: number) {
  const spec = getScale(ensureScale(scaleId))
  const classes = spec.cents.map((cents) => pc(key + Math.round(cents / 100)))
  return classes.length ? [...new Set(classes)] : [pc(key)]
}

function nearestScale(pitch: number, scale: number[]) {
  const want = pc(pitch)
  if (scale.includes(want)) return pitch
  let best = pitch
  let dist = 99
  for (let delta = -6; delta <= 6; delta++) {
    if (!scale.includes(pc(pitch + delta))) continue
    if (Math.abs(delta) < dist) {
      dist = Math.abs(delta)
      best = pitch + delta
    }
  }
  return best
}

function pc(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}

function clampPitch(pitch: number, floor: number, ceil: number) {
  return Math.max(floor, Math.min(ceil, Math.round(pitch)))
}

function clampVel(value: number) {
  return Math.max(0.08, Math.min(1, value))
}

function sort(notes: DraftNote[]) {
  return notes
    .filter((note) => note.durationBeats > 0.04)
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
}

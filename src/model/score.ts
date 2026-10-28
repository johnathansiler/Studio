/** Standard notation for one MIDI clip. Drawn as SVG, edited back into the same notes. */

import { scaleById } from './scale'
import { quartersPerBar, type TimeSignature } from './time'
import type { MidiNote } from './types'

const NAT = [0, 2, 4, 5, 7, 9, 11]
const SHARP_LETTERS = [3, 0, 4, 1, 5, 2, 6]
const FLAT_LETTERS = [6, 2, 5, 1, 4, 0, 3]
const SHARP_ROOTS = [0, 7, 2, 9, 4, 11, 6, 1]
const FLAT_ROOTS = [0, 5, 10, 3, 8, 1, 6, 11]
const MODE_PARENT: Record<string, number> = {
  ionian: 0,
  dorian: -2,
  phrygian: -4,
  lydian: -5,
  mixolydian: -7,
  aeolian: -9,
  locrian: -11,
  harmonicMinor: -9,
  melodicMinor: -9,
}

const TREBLE_SHARP = [8, 5, 9, 6, 3, 7, 4]
const TREBLE_FLAT = [4, 7, 3, 6, 2, 5, 1]
const BASS_SHARP = [6, 3, 7, 4, 1, 5, 2]
const BASS_FLAT = [2, 5, 1, 4, 0, 3, -1]

const LINE = 8
const COL = 18
const STAFF_GAP = 46
const PAGE_BARS = 4

export type ClefName = 'treble' | 'bass' | 'grand'
export type StaffName = 'treble' | 'bass'

export interface Spelling {
  letter: number
  octave: number
  /** null uses the key signature. 0 is a printed natural. */
  printed: -1 | 0 | 1 | null
}

export interface ScoreGlyph {
  noteId: string | null
  pitch: number | null
  startBeat: number
  beats: number
  unit: number
  dots: number
  staff: StaffName
  position: number
  accidental: -1 | 0 | 1 | null
  tieStart: boolean
  tieEnd: boolean
  wholeRest: boolean
  x: number
  y: number
  measure: number
}

export interface ScoreCell {
  beat: number
  pitch: number
  staff: StaffName
  x: number
  y: number
  w: number
  h: number
  noteId?: string
}

export interface ScoreLayout {
  fifths: number
  clef: ClefName
  time: TimeSignature
  barBeats: number
  measures: number
  page: number
  pages: number
  width: number
  height: number
  glyphs: ScoreGlyph[]
  cells: ScoreCell[]
}

export function keyFifths(root: number, scaleId: string): number {
  const pc = mod12(root)
  const shift = MODE_PARENT[scaleId]
  let tonic = pc
  if (shift == null) {
    const intervals = scaleById(scaleId).intervals as readonly number[]
    const minorish = !intervals.includes(4) && intervals.includes(3)
    tonic = minorish ? mod12(pc + 3) : pc
  } else tonic = mod12(pc + shift)
  const sharp = SHARP_ROOTS.indexOf(tonic)
  const flat = FLAT_ROOTS.indexOf(tonic)
  if (sharp >= 0 && (flat < 0 || sharp <= flat)) return sharp
  if (flat >= 0) return -flat
  return 0
}

export function signatureAccidentals(fifths: number): number[] {
  const acc = [0, 0, 0, 0, 0, 0, 0]
  const count = Math.max(-7, Math.min(7, Math.round(fifths)))
  if (count > 0) for (let i = 0; i < count; i++) acc[SHARP_LETTERS[i]] = 1
  if (count < 0) for (let i = 0; i < -count; i++) acc[FLAT_LETTERS[i]] = -1
  return acc
}

export function spellPitch(midi: number, fifths: number): Spelling {
  const pitch = clamp(Math.round(midi), 0, 127)
  const pc = mod12(pitch)
  const acc = signatureAccidentals(fifths)
  for (let letter = 0; letter < 7; letter++) {
    const wrapped = wrap(NAT[letter] + acc[letter])
    if (wrapped.pc !== pc) continue
    return { letter, octave: writtenOctave(pitch, wrapped.shift), printed: null }
  }
  for (let letter = 0; letter < 7; letter++) {
    if (NAT[letter] !== pc || acc[letter] === 0) continue
    return { letter, octave: writtenOctave(pitch, 0), printed: 0 }
  }
  const preferFlat = fifths < 0
  if (preferFlat) {
    for (let letter = 0; letter < 7; letter++) {
      const wrapped = wrap(NAT[letter] - 1)
      if (wrapped.pc !== pc) continue
      return { letter, octave: writtenOctave(pitch, wrapped.shift), printed: -1 }
    }
  }
  for (let letter = 0; letter < 7; letter++) {
    const wrapped = wrap(NAT[letter] + 1)
    if (wrapped.pc !== pc) continue
    return { letter, octave: writtenOctave(pitch, wrapped.shift), printed: 1 }
  }
  return { letter: 0, octave: Math.floor(pitch / 12) - 1, printed: 0 }
}

export function staffPosition(midi: number, fifths: number, clef: StaffName): { position: number; accidental: -1 | 0 | 1 | null } {
  const spelled = spellPitch(midi, fifths)
  const base = clef === 'treble' ? { letter: 2, octave: 4 } : { letter: 4, octave: 2 }
  return {
    position: (spelled.octave - base.octave) * 7 + (spelled.letter - base.letter),
    accidental: spelled.printed,
  }
}

export function midiAtPosition(position: number, fifths: number, clef: StaffName): number {
  const base = clef === 'treble' ? { letter: 2, octave: 4 } : { letter: 4, octave: 2 }
  let letter = base.letter + position
  let octave = base.octave
  while (letter < 0) {
    letter += 7
    octave -= 1
  }
  while (letter > 6) {
    letter -= 7
    octave += 1
  }
  const wrapped = wrap(NAT[letter] + signatureAccidentals(fifths)[letter])
  return clamp((octave + wrapped.shift + 1) * 12 + wrapped.pc, 0, 127)
}

export function chooseClef(notes: { pitch: number }[]): ClefName {
  if (!notes.length) return 'treble'
  const low = notes.some((note) => note.pitch < 60)
  const high = notes.some((note) => note.pitch >= 60)
  if (low && high) return 'grand'
  return low ? 'bass' : 'treble'
}

export function layoutScore(
  notes: MidiNote[],
  time: TimeSignature,
  root: number,
  scaleId: string,
  durationBeats: number,
  page = 0,
): ScoreLayout {
  const sig = {
    numerator: Math.max(1, Math.round(time.numerator) || 4),
    denominator: time.denominator === 8 || time.denominator === 2 ? time.denominator : 4,
  }
  const barBeats = quartersPerBar(sig)
  const fifths = keyFifths(root, scaleId)
  const clef = chooseClef(notes)
  const end = Math.max(barBeats, durationBeats, ...notes.map((note) => note.startBeat + note.durationBeats))
  const measures = Math.max(1, Math.ceil(end / barBeats - 1e-9))
  const pages = Math.max(1, Math.ceil(measures / PAGE_BARS))
  const safePage = Math.max(0, Math.min(pages - 1, Math.round(page) || 0))
  const first = safePage * PAGE_BARS
  const last = Math.min(measures, first + PAGE_BARS)
  const staves: StaffName[] = clef === 'grand' ? ['treble', 'bass'] : [clef]
  const columns = Math.max(1, Math.round(barBeats / 0.25))
  const keyW = 10 + Math.abs(fifths) * 11
  const header = 46 + keyW + 28
  const measureW = header + columns * COL + 10
  const width = 16 + (last - first) * measureW
  const staffTop = 28
  const height = staffTop + staves.length * (LINE * 4 + STAFF_GAP) + 8
  const glyphs: ScoreGlyph[] = []
  const pieces = notes.flatMap((note) => splitNote(note, barBeats))
  for (let measure = first; measure < last; measure++) {
    const barStart = measure * barBeats
    const origin = 16 + (measure - first) * measureW + header
    for (const piece of pieces) {
      if (piece.start < barStart - 1e-6 || piece.start >= barStart + barBeats - 1e-6) continue
      const staff = staffFor(piece.pitch, clef)
      const placed = staffPosition(piece.pitch, fifths, staff)
      glyphs.push({
        noteId: piece.noteId,
        pitch: piece.pitch,
        startBeat: piece.start,
        beats: piece.beats,
        unit: piece.unit,
        dots: piece.dots,
        staff,
        position: placed.position,
        accidental: placed.accidental,
        tieStart: piece.tieStart,
        tieEnd: piece.tieEnd,
        wholeRest: false,
        x: origin + ((piece.start - barStart) / 0.25) * COL,
        y: yOf(placed.position, staffTopOf(staff, staves, staffTop)),
        measure,
      })
    }
    for (const rest of restsIn(notes, barStart, barBeats)) {
      const staff = staves[0]
      const position = rest.wholeRest ? 4 : 4
      glyphs.push({
        noteId: null,
        pitch: null,
        startBeat: rest.start,
        beats: rest.beats,
        unit: rest.unit,
        dots: rest.dots,
        staff,
        position,
        accidental: null,
        tieStart: false,
        tieEnd: false,
        wholeRest: rest.wholeRest,
        x: origin + ((rest.start - barStart) / 0.25) * COL,
        y: yOf(position, staffTopOf(staff, staves, staffTop)),
        measure,
      })
    }
  }
  const cells: ScoreCell[] = []
  for (let measure = first; measure < last; measure++) {
    const barStart = measure * barBeats
    const origin = 16 + (measure - first) * measureW + header
    for (const staff of staves) {
      const top = staffTopOf(staff, staves, staffTop)
      for (let column = 0; column < columns; column++) {
        const beat = barStart + column * 0.25
        for (let position = -4; position <= 12; position++) {
          const pitch = midiAtPosition(position, fifths, staff)
          const y = yOf(position, top)
          const note = glyphs.find((glyph) => glyph.noteId && glyph.pitch === pitch && Math.abs(glyph.startBeat - beat) < 0.02 && glyph.staff === staff)
          cells.push({
            beat,
            pitch,
            staff,
            x: origin + column * COL - COL / 2,
            y: y - LINE / 4,
            w: COL,
            h: LINE / 2,
            noteId: note?.noteId ?? undefined,
          })
        }
      }
    }
  }
  return { fifths, clef, time: sig, barBeats, measures, page: safePage, pages, width, height, glyphs, cells }
}

export function scoreSvg(layout: ScoreLayout): string {
  const staves: StaffName[] = layout.clef === 'grand' ? ['treble', 'bass'] : [layout.clef]
  const staffTop = 28
  const columns = Math.max(1, Math.round(layout.barBeats / 0.25))
  const keyW = 10 + Math.abs(layout.fifths) * 11
  const header = 46 + keyW + 28
  const measureW = header + columns * COL + 10
  const first = layout.page * PAGE_BARS
  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="score-svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Score">`)
  for (let measure = first; measure < Math.min(layout.measures, first + PAGE_BARS); measure++) {
    const left = 16 + (measure - first) * measureW
    for (const staff of staves) {
      const top = staffTopOf(staff, staves, staffTop)
      for (let line = 0; line < 5; line++) {
        const y = top + line * LINE
        parts.push(`<line x1="${left}" y1="${y}" x2="${left + measureW - 8}" y2="${y}" stroke="currentColor" stroke-width="1"/>`)
      }
      parts.push(clefPath(staff, left + 8, top))
      if (measure === first) {
        parts.push(keyPath(layout.fifths, staff, left + 40, top))
        const timeX = left + 40 + keyW
        parts.push(`<text class="score-time" x="${timeX}" y="${top + LINE}" font-size="18" font-family="serif" font-weight="700">${layout.time.numerator}</text>`)
        parts.push(`<text class="score-time" x="${timeX}" y="${top + LINE * 3}" font-size="18" font-family="serif" font-weight="700">${layout.time.denominator}</text>`)
      }
    }
    parts.push(`<line x1="${left}" y1="${staffTop}" x2="${left}" y2="${staffTopOf(staves[staves.length - 1], staves, staffTop) + LINE * 4}" stroke="currentColor" stroke-width="1"/>`)
  }
  const beams = new Map<string, ScoreGlyph[]>()
  for (const glyph of layout.glyphs) {
    if (glyph.pitch == null || glyph.unit > 0.5) continue
    const group = beamBeats(layout.time)
    const slot = Math.floor((glyph.startBeat - glyph.measure * layout.barBeats) / group + 1e-6)
    const key = `${glyph.measure}:${glyph.staff}:${slot}`
    const list = beams.get(key) ?? []
    list.push(glyph)
    beams.set(key, list)
  }
  const beamed = new Set<ScoreGlyph>()
  for (const group of beams.values()) {
    if (group.length < 2) continue
    for (const glyph of group) beamed.add(glyph)
    parts.push(beamPath(group))
  }
  for (const glyph of layout.glyphs) {
    if (glyph.pitch == null) parts.push(restPath(glyph))
    else parts.push(notePath(glyph, beamed.has(glyph)))
  }
  for (const cell of layout.cells) {
    const note = cell.noteId ? ` data-note="${escapeAttr(cell.noteId)}"` : ''
    parts.push(`<rect data-beat="${round(cell.beat)}" data-pitch="${cell.pitch}" data-staff="${cell.staff}"${note} x="${round(cell.x)}" y="${round(cell.y)}" width="${cell.w}" height="${cell.h}" fill="transparent"/>`)
  }
  parts.push('</svg>')
  return parts.join('')
}

interface Piece {
  noteId: string
  pitch: number
  start: number
  beats: number
  unit: number
  dots: number
  tieStart: boolean
  tieEnd: boolean
}

function splitNote(note: MidiNote, barBeats: number): Piece[] {
  const out: Piece[] = []
  let start = Math.max(0, note.startBeat)
  let left = Math.max(0.125, note.durationBeats)
  let first = true
  let guard = 0
  while (left > 0.06 && guard < 32) {
    guard += 1
    const barEnd = (Math.floor(start / barBeats + 1e-9) + 1) * barBeats
    const room = Math.max(0.125, barEnd - start)
    const fitted = fitDuration(Math.min(left, room))
    out.push({
      noteId: note.id,
      pitch: note.pitch,
      start,
      beats: fitted.beats,
      unit: fitted.unit,
      dots: fitted.dots,
      tieStart: !first,
      tieEnd: left - fitted.beats > 0.06,
    })
    first = false
    start += fitted.beats
    left -= fitted.beats
  }
  return out
}

function restsIn(notes: MidiNote[], barStart: number, barBeats: number): { start: number; beats: number; unit: number; dots: number; wholeRest: boolean }[] {
  const spans = notes
    .map((note) => ({
      start: Math.max(barStart, note.startBeat),
      end: Math.min(barStart + barBeats, note.startBeat + note.durationBeats),
    }))
    .filter((span) => span.end - span.start > 0.04)
    .sort((a, b) => a.start - b.start)
  const merged: { start: number; end: number }[] = []
  for (const span of spans) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end + 0.04) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  const gaps: [number, number][] = []
  let cursor = barStart
  for (const span of merged) {
    if (span.start - cursor > 0.06) gaps.push([cursor, span.start])
    cursor = Math.max(cursor, span.end)
  }
  if (barStart + barBeats - cursor > 0.06) gaps.push([cursor, barStart + barBeats])
  if (gaps.length === 1 && gaps[0][1] - gaps[0][0] >= barBeats - 0.06) {
    return [{ start: barStart, beats: barBeats, unit: 4, dots: 0, wholeRest: true }]
  }
  const rests: { start: number; beats: number; unit: number; dots: number; wholeRest: boolean }[] = []
  for (const [from, to] of gaps) {
    let at = from
    let left = to - from
    let guard = 0
    while (left > 0.06 && guard < 16) {
      guard += 1
      const fitted = fitDuration(left)
      rests.push({ start: at, beats: fitted.beats, unit: fitted.unit, dots: fitted.dots, wholeRest: false })
      at += fitted.beats
      left -= fitted.beats
    }
  }
  return rests
}

function fitDuration(left: number): { beats: number; unit: number; dots: number } {
  const choices = [
    { beats: 4, unit: 4, dots: 0 },
    { beats: 3, unit: 2, dots: 1 },
    { beats: 2, unit: 2, dots: 0 },
    { beats: 1.5, unit: 1, dots: 1 },
    { beats: 1, unit: 1, dots: 0 },
    { beats: 0.75, unit: 0.5, dots: 1 },
    { beats: 0.5, unit: 0.5, dots: 0 },
    { beats: 0.375, unit: 0.25, dots: 1 },
    { beats: 0.25, unit: 0.25, dots: 0 },
    { beats: 0.125, unit: 0.125, dots: 0 },
  ]
  for (const choice of choices) {
    if (choice.beats <= left + 0.02) return choice
  }
  return choices[choices.length - 1]
}

function beamBeats(time: TimeSignature): number {
  if (time.denominator === 8 && time.numerator % 3 === 0) return 1.5
  return 4 / time.denominator
}

function staffFor(pitch: number, clef: ClefName): StaffName {
  if (clef === 'bass') return 'bass'
  if (clef === 'treble') return 'treble'
  return pitch >= 60 ? 'treble' : 'bass'
}

function staffTopOf(staff: StaffName, staves: StaffName[], top: number) {
  const index = Math.max(0, staves.indexOf(staff))
  return top + index * (LINE * 4 + STAFF_GAP)
}

function yOf(position: number, staffTop: number) {
  return staffTop + (8 - position) * (LINE / 2)
}

function notePath(glyph: ScoreGlyph, inBeam: boolean): string {
  const filled = glyph.unit < 2
  const up = glyph.position < 4
  const x = glyph.x
  const y = glyph.y
  const head = filled
    ? `<ellipse cx="${x}" cy="${y}" rx="5.4" ry="3.8" transform="rotate(-18 ${x} ${y})"/>`
    : `<ellipse cx="${x}" cy="${y}" rx="5.4" ry="3.8" fill="none" stroke="currentColor" stroke-width="1.4" transform="rotate(-18 ${x} ${y})"/>`
  const stemX = up ? x + 4.6 : x - 4.6
  const stemEnd = up ? y - 26 : y + 26
  const stem = glyph.unit >= 4 ? '' : `<line x1="${stemX}" y1="${y}" x2="${stemX}" y2="${stemEnd}" stroke="currentColor" stroke-width="1.2"/>`
  let flags = ''
  if (!inBeam && glyph.unit <= 0.5) {
    const dir = up ? 1 : -1
    flags += flag(stemX, stemEnd, dir)
    if (glyph.unit <= 0.25) flags += flag(stemX, stemEnd + dir * 5, dir)
  }
  const accidental = glyph.accidental == null ? '' : accidentalPath(glyph.accidental, x - 12, y)
  const dot = glyph.dots ? `<circle cx="${x + 9}" cy="${y - 2}" r="1.5"/>` : ''
  const tie = glyph.tieEnd ? `<path d="M${x + 6} ${y + 8} Q ${x + 14} ${y + 14} ${x + 22} ${y + 8}" fill="none" stroke="currentColor" stroke-width="1.1"/>` : ''
  const id = escapeAttr(glyph.noteId || '')
  return `<g class="score-note" data-note="${id}" data-beat="${round(glyph.startBeat)}" data-pitch="${glyph.pitch}">${accidental}${head}${stem}${flags}${dot}${tie}</g>`
}

function flag(x: number, y: number, dir: number) {
  return `<path d="M${x} ${y} c ${6} ${dir * 4} ${8} ${dir * 10} ${2} ${dir * 14}" fill="none" stroke="currentColor" stroke-width="1.3"/>`
}

function restPath(glyph: ScoreGlyph): string {
  const x = glyph.x
  const y = glyph.y
  if (glyph.wholeRest) return `<rect x="${x - 6}" y="${y - LINE}" width="12" height="4"/>`
  if (glyph.unit >= 2) return `<rect x="${x - 6}" y="${y}" width="12" height="4"/>`
  if (glyph.unit >= 1) return `<path d="M${x - 4} ${y - 10} q 8 4 0 10 q -8 4 0 8" fill="currentColor"/>`
  if (glyph.unit >= 0.5) return `<path d="M${x} ${y - 8} v 10 M${x} ${y + 2} q 7 -2 4 6" fill="none" stroke="currentColor" stroke-width="1.4"/>`
  return `<path d="M${x} ${y - 8} v 12 M${x} ${y} q 7 -2 4 5 M${x} ${y + 5} q 7 -2 4 5" fill="none" stroke="currentColor" stroke-width="1.3"/>`
}

function beamPath(group: ScoreGlyph[]): string {
  const ordered = [...group].sort((a, b) => a.startBeat - b.startBeat)
  const up = ordered[0].position < 4
  const y1 = up ? ordered[0].y - 26 : ordered[0].y + 26
  const y2 = up ? ordered[ordered.length - 1].y - 26 : ordered[ordered.length - 1].y + 26
  const x1 = up ? ordered[0].x + 4.6 : ordered[0].x - 4.6
  const x2 = up ? ordered[ordered.length - 1].x + 4.6 : ordered[ordered.length - 1].x - 4.6
  const thick = up ? 3 : -3
  let path = `<polygon points="${x1},${y1} ${x2},${y2} ${x2},${y2 + thick} ${x1},${y1 + thick}"/>`
  if (ordered.some((glyph) => glyph.unit <= 0.25)) {
    path += `<polygon points="${x1},${y1 + thick * 2} ${x2},${y2 + thick * 2} ${x2},${y2 + thick * 3} ${x1},${y1 + thick * 3}"/>`
  }
  return path
}

function accidentalPath(kind: -1 | 0 | 1, x: number, y: number): string {
  if (kind > 0) {
    return `<g stroke="currentColor" stroke-width="1.1" fill="none"><line x1="${x - 2}" y1="${y - 7}" x2="${x - 2}" y2="${y + 7}"/><line x1="${x + 2}" y1="${y - 7}" x2="${x + 2}" y2="${y + 7}"/><line x1="${x - 4}" y1="${y - 2}" x2="${x + 4}" y2="${y - 4}"/><line x1="${x - 4}" y1="${y + 3}" x2="${x + 4}" y2="${y + 1}"/></g>`
  }
  if (kind < 0) return `<path d="M${x} ${y - 8} v 14 q 7 -2 6 -7 q -1 -5 -6 -3" fill="none" stroke="currentColor" stroke-width="1.2"/>`
  return `<g stroke="currentColor" stroke-width="1.1"><line x1="${x - 3}" y1="${y - 7}" x2="${x - 3}" y2="${y + 2}"/><line x1="${x + 2}" y1="${y - 2}" x2="${x + 2}" y2="${y + 7}"/><line x1="${x - 3}" y1="${y - 2}" x2="${x + 2}" y2="${y - 4}"/><line x1="${x - 3}" y1="${y + 2}" x2="${x + 2}" y2="${y}"/></g>`
}

function clefPath(staff: StaffName, x: number, top: number): string {
  const bass = staff === 'bass'
  const glyph = bass ? '𝄢' : '𝄞'
  const y = top + (bass ? LINE * 3.1 : LINE * 4.2)
  const size = bass ? 32 : 44
  return `<text font-family="Noto Music, 'Segoe UI Symbol', 'Apple Symbols', serif" font-size="${size}" x="${x - 2}" y="${y}">${glyph}</text>`
}

function keyPath(fifths: number, staff: StaffName, x: number, top: number): string {
  const count = Math.min(7, Math.abs(fifths))
  const table = fifths >= 0 ? (staff === 'treble' ? TREBLE_SHARP : BASS_SHARP) : staff === 'treble' ? TREBLE_FLAT : BASS_FLAT
  let marks = ''
  for (let i = 0; i < count; i++) {
    const y = yOf(table[i], top)
    marks += accidentalPath(fifths >= 0 ? 1 : -1, x + i * 11, y)
  }
  return marks
}

function wrap(value: number): { pc: number; shift: number } {
  if (value < 0) return { pc: value + 12, shift: -1 }
  if (value > 11) return { pc: value - 12, shift: 1 }
  return { pc: value, shift: 0 }
}

function writtenOctave(midi: number, shift: number) {
  return Math.floor(midi / 12) - 1 - shift
}

function mod12(value: number) {
  return ((Math.round(value) % 12) + 12) % 12
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function round(value: number) {
  return Math.round(value * 1000) / 1000
}

function escapeAttr(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

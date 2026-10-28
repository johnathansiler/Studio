/**
 * Virtual drummer and bass/keys session players.
 *
 * Grooves, bass lines, and chord rhythms come from `src/generators`.
 * This module picks the region, follows the chords and the song sections,
 * and turns complexity, loudness, and fills up or down.
 */

import type { AnalysisChord, AnalysisSection, SectionKind } from '../analysis/types'
import { followSource, generate, generatorInput } from '../generators'
import { defaultGenerator } from '../generators/settings'
import { styleById } from '../generators/styles'
import type { GeneratorChord, GeneratorInput, StrumPattern } from '../generators/types'
import { nameChord } from '../model/scale'
import { quartersPerBar } from '../model/time'
import type { Project } from '../model/types'
import { CHORDS, spellChord } from '../theory/chords'
import { normalizePlayer } from './settings'
import type { ChordSource, PlayerSettings, SessionBuild, SessionNote, SessionPart } from './types'

const SNARE = 38
const CHUNK = 32

const ENERGY: Record<SectionKind, { complexity: number; loudness: number; fills: number }> = {
  intro: { complexity: 0.32, loudness: 0.55, fills: 0.2 },
  verse: { complexity: 0.55, loudness: 0.75, fills: 0.45 },
  prechorus: { complexity: 0.7, loudness: 0.84, fills: 0.7 },
  chorus: { complexity: 0.92, loudness: 1, fills: 0.85 },
  bridge: { complexity: 0.48, loudness: 0.68, fills: 0.4 },
  breakdown: { complexity: 0.2, loudness: 0.48, fills: 0.12 },
  outro: { complexity: 0.34, loudness: 0.52, fills: 0.28 },
  section: { complexity: 0.6, loudness: 0.8, fills: 0.55 },
}

const SOURCE_LABEL: Record<ChordSource, string> = {
  track: 'Chord track',
  idea: 'Chord idea',
  memory: 'Last progression',
  detected: 'Detected chords',
  style: 'Style progression',
}

interface Span {
  kind: SectionKind
  startBar: number
  endBar: number
}

export interface SessionDetection {
  sections?: AnalysisSection[]
  detected?: AnalysisChord[]
}

export function chordsFromAnalysis(chords: AnalysisChord[]): GeneratorChord[] {
  return chords
    .filter((chord) => chord.beats > 0 && Number.isFinite(chord.root))
    .slice(0, 64)
    .map((chord) => {
      const voiced = voiceSymbol(chord.symbol || '', chord.root)
      return {
        pitches: voiced.pitches,
        ...(voiced.cents ? { cents: voiced.cents } : {}),
        beats: chord.beats,
        symbol: chord.symbol,
        root: ((Math.round(chord.root) % 12) + 12) % 12,
      }
    })
    .filter((chord) => chord.pitches.length > 0)
}

/** Editable MIDI for the drummer and the players. The same settings always rebuild the same notes. */
export function buildSession(project: Project, raw: Partial<PlayerSettings> | undefined, detection: SessionDetection = {}): SessionBuild {
  const settings = normalizePlayer(raw)
  const bar = quartersPerBar(project.timeSignature)
  const followed = followSource(project)
  let chords = followed.chords
  let source: ChordSource = followed.source === 'none' ? 'style' : followed.source
  if (!chords.length && detection.detected?.length) {
    const detected = chordsFromAnalysis(detection.detected)
    if (detected.length) {
      chords = detected
      source = 'detected'
    }
  }

  const span = settings.endBar - settings.startBar
  const style = styleById(settings.style)
  let written: SessionNote[] | null = null
  if (!chords.length && (settings.keys || settings.bass)) {
    const sketch = generate('chords', inputFor(project, settings, [], span, settings.seed))
    chords = sketch.chords
    written = sketch.notes
    source = 'style'
  }

  const parts: SessionPart[] = []
  if (settings.drummer) parts.push(drumPart(project, settings, bar, settings.followSections ? detection.sections ?? [] : []))
  if (settings.bass && chords.length) {
    const played = generate('bass', inputFor(project, settings, chords, span, settings.seed + 3))
    const instrument = played.instrument === '808' ? '808' : 'synth'
    parts.push(linePart('bass', style.name, instrument, '#79b8d4', settings, bar, shapeLine(played.notes, bar, settings.complexity)))
  }
  if (settings.keys && chords.length) {
    const notes = source === 'style' && written
      ? written
      : generate('rhythm', inputFor(project, settings, chords, span, settings.seed + 5, settings.complexity < 0.42 ? 'block' : style.strum)).notes
    parts.push(linePart('keys', style.name, 'synth', '#e0b15a', settings, bar, shapeLine(notes, bar, settings.complexity)))
  }

  const names = chords.map((chord) => chord.symbol || nameChord(chord.pitches)).filter(Boolean).slice(0, 8)
  const summary = `${style.name} · ${SOURCE_LABEL[source]}${names.length ? ` · ${names.join(' ')}` : ''}`
  return { parts, source, summary }
}

function drumPart(project: Project, settings: PlayerSettings, bar: number, sections: AnalysisSection[]): SessionPart {
  const style = styleById(settings.style)
  const notes: SessionNote[] = []
  for (const span of sectionSpans(settings, sections)) {
    const energy = ENERGY[span.kind]
    const complexity = mix(energy.complexity, settings.complexity)
    const loudness = mix(energy.loudness, settings.loudness)
    const fills = mix(energy.fills, settings.fills)
    for (let barIndex = span.startBar; barIndex < span.endBar; barIndex += CHUNK) {
      const end = Math.min(span.endBar, barIndex + CHUNK)
      const length = end - barIndex
      const seed = (settings.seed + barIndex * 13 + 11) >>> 0
      const played = generate('drums', inputFor(project, settings, [], length, seed))
      const shaped = shapeDrums(played.notes, length, bar, complexity, end === span.endBar ? fills : 0, (step) =>
        generate('drums', inputFor(project, settings, [], length, (seed + step * 97) >>> 0)).notes,
      )
      notes.push(...shift(applyLoudness(shaped, loudness), (barIndex - settings.startBar) * bar))
    }
  }
  return {
    role: 'drums',
    trackName: 'Drums',
    clipName: `${style.name} drummer`,
    color: '#c58be0',
    instrument: 'drum-machine',
    startBeat: settings.startBar * bar,
    durationBeats: (settings.endBar - settings.startBar) * bar,
    notes: notes.sort(byTime),
  }
}

function sectionSpans(settings: PlayerSettings, sections: AnalysisSection[]): Span[] {
  if (!sections.length) return [{ kind: 'section', startBar: settings.startBar, endBar: settings.endBar }]
  const clipped = sections
    .map((section) => ({
      kind: section.kind,
      startBar: Math.max(settings.startBar, section.startBar),
      endBar: Math.min(settings.endBar, section.endBar),
    }))
    .filter((section) => section.endBar > section.startBar)
    .sort((a, b) => a.startBar - b.startBar)
  if (!clipped.length) return [{ kind: 'section', startBar: settings.startBar, endBar: settings.endBar }]
  const out: Span[] = []
  let cursor = settings.startBar
  for (const span of clipped) {
    if (span.startBar > cursor) out.push({ kind: 'section', startBar: cursor, endBar: span.startBar })
    out.push(span)
    cursor = span.endBar
  }
  if (cursor < settings.endBar) out.push({ kind: 'section', startBar: cursor, endBar: settings.endBar })
  return out
}

function linePart(
  role: 'bass' | 'keys',
  styleName: string,
  instrument: 'synth' | '808',
  color: string,
  settings: PlayerSettings,
  bar: number,
  notes: SessionNote[],
): SessionPart {
  return {
    role,
    trackName: role === 'bass' ? 'Bass' : 'Keys',
    clipName: role === 'bass' ? `${styleName} bass player` : `${styleName} keys player`,
    color,
    instrument,
    startBeat: settings.startBar * bar,
    durationBeats: (settings.endBar - settings.startBar) * bar,
    notes: applyLoudness(notes, settings.loudness),
  }
}

function inputFor(project: Project, settings: PlayerSettings, chords: GeneratorChord[], bars: number, seed: number, strum?: StrumPattern): GeneratorInput {
  const style = styleById(settings.style)
  const base = generatorInput(project, {
    ...defaultGenerator(),
    kind: 'drums',
    style: style.id,
    bars,
    seed,
    variation: 0,
    strum: strum ?? style.strum,
    chords,
  }, chords)
  return {
    ...base,
    bars,
    seed,
    chords,
    options: { ...base.options, ...(strum ? { strum } : {}) },
  }
}

/** Drop the quieter hits as complexity falls. The style row already marks the accents. */
function shapeDrums(notes: SessionNote[], bars: number, bar: number, complexity: number, fills: number, again: (step: number) => SessionNote[]) {
  const groove = notes.filter((note) => !isRoll(note, bars, bar))
  const floor = drumFloor(complexity)
  let kept = groove.filter((note) => note.velocity + 1e-4 >= floor)
  if (!kept.length && groove.length) kept = [groove.reduce((best, note) => note.velocity > best.velocity ? note : best)]
  return [...kept, ...rollNotes(notes, bars, bar, fills, again)]
}

function rollNotes(notes: SessionNote[], bars: number, bar: number, fills: number, again: (step: number) => SessionNote[]) {
  let pool = notes.filter((note) => isRoll(note, bars, bar))
  if (fills > 0.08 && !pool.length) {
    for (let step = 1; step <= 16 && !pool.length; step++) pool = again(step).filter((note) => isRoll(note, bars, bar))
  }
  const count = Math.round(pool.length * clamp01(fills))
  return [...pool].sort(byTime).slice(pool.length - count)
}

function isRoll(note: SessionNote, bars: number, bar: number) {
  if (note.pitch !== SNARE || bars < 1) return false
  const into = note.startBeat - (bars - 1) * bar
  return into > Math.max(0, bar - 1) + 0.12
}

function drumFloor(complexity: number) {
  const amount = clamp01(complexity)
  if (amount <= 0.4) return 0.86 - amount * 0.45
  return 0.68 - (amount - 0.4) * 1.05
}

function shapeLine(notes: SessionNote[], bar: number, complexity: number) {
  const groups = new Map<number, SessionNote[]>()
  for (const note of notes) {
    const index = Math.max(0, Math.floor(note.startBeat / bar + 1e-6))
    const list = groups.get(index) ?? []
    list.push(note)
    groups.set(index, list)
  }
  const out: SessionNote[] = []
  for (const list of groups.values()) {
    const kept = list.filter((note) => busyness(note.startBeat, bar) <= complexity + 0.02)
    if (kept.length) out.push(...kept)
    else {
      const first = [...list].sort(byTime)[0]
      if (first) out.push(first)
    }
  }
  return out.sort(byTime)
}

function busyness(beat: number, bar: number) {
  const width = Math.max(0.5, bar)
  const pos = beat - Math.floor(beat / width + 1e-6) * width
  const step = Math.round(pos * 4)
  if (Math.abs(pos - step / 4) > 0.045) return 0.95
  const steps = Math.max(1, Math.round(width * 4))
  if (step % steps === 0) return 0
  if (step % 4 === 0) return 0.34
  if (step % 2 === 0) return 0.62
  return 0.9
}

function applyLoudness(notes: SessionNote[], loudness: number) {
  const gain = 0.35 + 0.65 * clamp01(loudness)
  return notes.map((note) => ({ ...note, velocity: Math.min(1, Math.max(0.05, note.velocity * gain)) }))
}

function shift(notes: SessionNote[], beats: number) {
  if (!beats) return notes
  return notes.map((note) => ({ ...note, startBeat: note.startBeat + beats }))
}

function mix(base: number, user: number) {
  return clamp01(base + (clamp01(user) - 0.5) * 0.8)
}

function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function byTime(a: SessionNote, b: SessionNote) {
  return a.startBeat - b.startBeat || a.pitch - b.pitch
}

function voiceSymbol(symbol: string, root: number) {
  const pc = ((Math.round(root) % 12) + 12) % 12
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const rest = symbol.startsWith(names[pc]) ? symbol.slice(names[pc].length) : ''
  const spec = [...CHORDS].sort((a, b) => b.suffix.length - a.suffix.length).find((item) => item.suffix === rest)
  const spelled = spellChord(pc, spec?.id ?? 'maj', 4)
  const cents = spelled.tones.map((tone) => tone.cents)
  return {
    pitches: spelled.tones.map((tone) => tone.midi),
    ...(cents.some((cent) => cent) ? { cents } : {}),
  }
}

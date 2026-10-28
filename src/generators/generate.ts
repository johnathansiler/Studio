import { arpNotes } from './arp'
import { bassNotes } from './bass'
import { buildChords, chordNotes, coverChords } from './chords'
import { drumNotes } from './drums'
import { melodyNotes } from './melody'
import { clamp, mod12, roundBeat, channelRng } from './rng'
import { rhythmNotes } from './rhythm'
import { styleById } from './styles'
import type { GeneratedNote, GeneratedPart, GeneratorInput, GeneratorKind } from './types'

const TRACK: Record<GeneratorKind, string> = {
  chords: 'Chords',
  bass: 'Bass',
  melody: 'Melody',
  arp: 'Arp',
  rhythm: 'Rhythm',
  drums: 'Drums',
}

const KIND_LABEL: Record<GeneratorKind, string> = {
  chords: 'chords',
  bass: 'bass',
  melody: 'melody',
  arp: 'arp',
  rhythm: 'strum',
  drums: 'drums',
}

export function normalizeInput(raw: GeneratorInput): GeneratorInput {
  const bars = clamp(Math.round(raw.bars || 4), 1, 32)
  const beatsPerBar = clamp(raw.beatsPerBar ?? 4, 0.5, 12)
  return {
    key: mod12(raw.key || 0),
    scale: Array.isArray(raw.scale) ? raw.scale : [],
    chords: Array.isArray(raw.chords) ? raw.chords : [],
    tempo: clamp(raw.tempo || 120, 40, 240),
    bars,
    style: typeof raw.style === 'string' && raw.style ? raw.style : 'pop',
    seed: Number.isFinite(raw.seed) ? raw.seed >>> 0 : 1,
    variation: Math.max(0, Math.round(raw.variation ?? 0)),
    beatsPerBar,
    options: raw.options,
  }
}

/** One pure function for every part. Same input, same MIDI. */
export function generate(kind: GeneratorKind, raw: GeneratorInput): GeneratedPart {
  const input = normalizeInput(raw)
  const style = styleById(input.style)
  const total = input.bars * (input.beatsPerBar ?? 4)
  const follow = kind !== 'chords' && input.chords.length > 0
  const chords = follow ? coverChords(input.chords, total) : buildChords(input, style)
  const plain = notesFor(kind, chords, style, input)
  const notes = clean(humanize(plain, channelRng(input.seed, input.variation ?? 0, 9)), total)
  return {
    kind,
    name: `${style.name} ${KIND_LABEL[kind]}`,
    trackName: TRACK[kind],
    instrument: kind === 'drums' ? 'drum-machine' : kind === 'bass' && (style.id === 'trap' || style.id === 'drill' || style.id === 'amapiano') ? '808' : 'synth',
    notes,
    chords: chords.map((chord) => ({
      pitches: chord.pitches.map((pitch) => Math.round(pitch)),
      ...(chord.cents?.some((cent) => cent) ? { cents: chord.cents.map((cent) => Math.round(cent)) } : {}),
      beats: chord.beats,
      ...(chord.symbol ? { symbol: chord.symbol } : {}),
      root: chord.root,
    })),
    label: chords.map((chord) => chord.symbol).filter(Boolean).join(' '),
    bars: input.bars,
    seed: input.seed,
    variation: input.variation ?? 0,
  }
}

function notesFor(kind: GeneratorKind, chords: ReturnType<typeof buildChords>, style: ReturnType<typeof styleById>, input: GeneratorInput): GeneratedNote[] {
  if (kind === 'chords') return chordNotes(chords, style, input)
  if (kind === 'bass') return bassNotes(chords, style, input)
  if (kind === 'melody') return melodyNotes(chords, style, input)
  if (kind === 'arp') return arpNotes(chords, style, input)
  if (kind === 'rhythm') return rhythmNotes(chords, style, input)
  return drumNotes(style, input)
}

function humanize(notes: GeneratedNote[], rng: () => number) {
  return notes.map((note) => ({
    ...note,
    velocity: note.velocity * (0.9 + rng() * 0.18),
  }))
}

function clean(notes: GeneratedNote[], total: number): GeneratedNote[] {
  return notes
    .filter((note) => Number.isFinite(note.pitch) && note.startBeat >= -0.001 && note.startBeat < total - 0.001)
    .map((note) => {
      const fine = note.fine ? clamp(Math.round(note.fine), -50, 50) : 0
      return {
        pitch: clamp(Math.round(note.pitch), 0, 127),
        startBeat: roundBeat(Math.max(0, note.startBeat)),
        durationBeats: roundBeat(Math.max(0.05, note.durationBeats)),
        velocity: clamp(note.velocity, 0.05, 1),
        ...(fine ? { fine } : {}),
        ...(note.slide ? { slide: true as const } : {}),
      }
    })
    .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || (a.fine ?? 0) - (b.fine ?? 0))
}

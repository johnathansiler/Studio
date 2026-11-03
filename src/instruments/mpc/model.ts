/** Sampler/drums. Old drum plugin ids load this instrument. The chromatic sampler keeps its own processor. */

import { repeatIntervalBeats, type RepeatRate } from '../../model/midiClock'
import {
  chainSong,
  chopSample,
  chopsToPads,
  createKit,
  normalizePadKit,
  padRegion,
  type MpcOutput,
  type PadProgram,
  type PadRegion,
  type PadSequence,
  type PadVoice,
  type SequenceNote,
} from '../../model/padMachine'

export const SAMPLER_DRUMS_ID = 'sampler-drums'
export const SAMPLER_DRUMS_NAME = 'Sampler/drums'

/** Drum-machine ids that become the core plugin when a project opens. */
export const LEGACY_DRUM_IDS = ['pads', 'drum-machine', '808', 'drums'] as const

export type { MpcOutput, PadRegion }

export function canonicalizePluginId(id: string): string {
  if ((LEGACY_DRUM_IDS as readonly string[]).includes(id)) return SAMPLER_DRUMS_ID
  return id
}

/** Sampler stays a chromatic player. Its slices can still feed the pads. */
export function loadsIntoSamplerDrums(id: string): boolean {
  return id === SAMPLER_DRUMS_ID || id === 'sampler' || (LEGACY_DRUM_IDS as readonly string[]).includes(id)
}

export function hostsSamplerDrums(track: { type: string } | null | undefined): boolean {
  return track?.type === 'midi'
}

export function hearsMidi(output: MpcOutput): boolean {
  return output !== 'audio'
}

export function hearsAudio(output: MpcOutput): boolean {
  return output !== 'midi'
}

export interface HitRoute {
  midi: boolean
  audio: boolean
  busId: string
}

/** MIDI out writes clips and can drive another instrument. Audio out renders. Both do both. */
export function hitRoute(kit: Pick<PadProgram, 'output' | 'multiOut'>, pad: { muted?: boolean; busId?: string }): HitRoute {
  const output = kit.output
  const silent = Boolean(pad.muted)
  return {
    midi: output !== 'audio' && !silent,
    audio: output !== 'midi' && !silent,
    busId: kit.multiOut && pad.busId ? pad.busId : '',
  }
}

export function chordPitches(pad: { pitch: number; chord?: number[] } | undefined): number[] {
  if (!pad) return []
  const extra = (pad.chord ?? []).filter((pitch) => pitch !== pad.pitch)
  return [pad.pitch, ...extra]
}

export function expandChord<T extends { pitch: number }>(notes: T[], pads: { pitch: number; chord?: number[] }[]): T[] {
  const byPitch = new Map(pads.map((pad) => [pad.pitch, pad]))
  const out: T[] = []
  for (const note of notes) {
    const pitches = chordPitches(byPitch.get(note.pitch) ?? { pitch: note.pitch })
    for (const pitch of pitches) out.push(pitch === note.pitch ? note : { ...note, pitch })
  }
  return out
}

export interface RepeatChoice {
  id: string
  label: string
  rate: RepeatRate
  triplet: boolean
}

export const REPEAT_CHOICES: RepeatChoice[] = [
  { id: '1/4', label: 'Quarter', rate: '1/4', triplet: false },
  { id: '1/8', label: 'Eighth', rate: '1/8', triplet: false },
  { id: '1/16', label: 'Sixteenth', rate: '1/16', triplet: false },
  { id: '1/32', label: 'Thirty-second', rate: '1/32', triplet: false },
  { id: '1/4t', label: 'Quarter triplet', rate: '1/4', triplet: true },
  { id: '1/8t', label: 'Eighth triplet', rate: '1/8', triplet: true },
  { id: '1/16t', label: 'Sixteenth triplet', rate: '1/16', triplet: true },
  { id: '1/32t', label: 'Thirty-second triplet', rate: '1/32', triplet: true },
]

export function repeatSetting(id: string): RepeatChoice & { beats: number } {
  const found = REPEAT_CHOICES.find((item) => item.id === id) ?? REPEAT_CHOICES[2]
  return { ...found, beats: repeatIntervalBeats(found.rate, found.triplet) }
}

/** Pressure scales the held velocity. Off keeps the velocity the pad was struck with. */
export function repeatVelocity(base: number, pressure: number, enabled: boolean): number {
  const struck = clamp(base, 0, 1)
  if (!enabled) return struck
  return clamp(struck * (0.35 + 0.65 * clamp(pressure, 0, 1)), 0.05, 1)
}

export function mpcTempo(sync: boolean, localBpm: number, projectBpm: number): number {
  if (sync || !(localBpm > 0)) return Math.min(300, Math.max(30, projectBpm || 120))
  return Math.min(300, Math.max(30, localBpm))
}

export interface SliceMark {
  bufferId: string
  root: number
  tune?: number
  reverse?: boolean
  loopStart: number
  loopEnd: number
}

/** A saved chromatic sampler's slices become bank A of the beat machine. */
export function kitFromSlices(slices: SliceMark[], base?: PadProgram): PadProgram {
  const kit = normalizePadKit(base ?? createKit())
  const banks = kit.banks.map((row) => row.map((pad) => ({ ...pad, layers: pad.layers.map((layer) => ({ ...layer })), region: pad.region ? { ...pad.region } : undefined, chord: pad.chord ? [...pad.chord] : [] })))
  slices.slice(0, 16).forEach((slice, index) => {
    const pad = banks[0][index]
    if (!pad || !slice.bufferId) return
    const loopStart = clamp(slice.loopStart, 0, 1)
    const loopEnd = clamp(slice.loopEnd, 0, 1)
    pad.pitch = clamp(Math.round(slice.root), 0, 127)
    pad.tune = clamp(slice.tune ?? 0, -24, 24)
    pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: slice.bufferId }]
    pad.region = {
      start: 0,
      end: 1,
      loop: loopEnd > loopStart + 0.001,
      loopStart: Math.min(loopStart, loopEnd),
      loopEnd: Math.max(loopStart, loopEnd),
      reverse: Boolean(slice.reverse),
    }
  })
  return normalizePadKit({ ...kit, banks })
}

/** Manual slice points, in samples. The ends of the buffer are always included. */
export function manualChops(length: number, markers: number[]): { start: number; end: number }[] {
  const total = Math.max(0, Math.floor(length))
  if (total < 2) return []
  const points = [0, total]
  for (const marker of markers) {
    if (!Number.isFinite(marker)) continue
    const at = Math.round(marker)
    if (at > 0 && at < total) points.push(at)
  }
  const sorted = [...new Set(points)].sort((a, b) => a - b)
  const chops: { start: number; end: number }[] = []
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i + 1] > sorted[i]) chops.push({ start: sorted[i], end: sorted[i + 1] })
  }
  return chops
}

export type MpcChop = 'transient' | 'grid' | 'manual'

export function chopsFor(samples: Float32Array, sampleRate: number, mode: MpcChop, opts?: { regions?: number; bpm?: number; markers?: number[]; threshold?: number }) {
  if (mode === 'manual') return manualChops(samples.length, opts?.markers ?? [])
  if (mode === 'grid') return chopSample(samples, sampleRate, 'regions', { regions: opts?.regions ?? 16 })
  return chopSample(samples, sampleRate, 'transient', { threshold: opts?.threshold })
}

export function chopsOntoPads(chops: { start: number; end: number }[], name: string) {
  return chopsToPads(chops, name)
}

export function toggleStep(notes: SequenceNote[], pitch: number, step: number, stepBeats: number, velocity = 0.9): SequenceNote[] {
  const beats = stepBeats > 0 ? stepBeats : 0.25
  const start = Math.max(0, step) * beats
  const hit = notes.find((note) => note.pitch === pitch && Math.abs(note.startBeat - start) < beats * 0.45)
  if (hit) return notes.filter((note) => note !== hit)
  return [...notes, { pitch, startBeat: start, durationBeats: Math.min(beats, 0.5), velocity: clamp(velocity, 0.05, 1) }]
}

export function stepOn(notes: SequenceNote[], pitch: number, step: number, stepBeats: number): boolean {
  const beats = stepBeats > 0 ? stepBeats : 0.25
  const start = step * beats
  return notes.some((note) => note.pitch === pitch && Math.abs(note.startBeat - start) < beats * 0.45)
}

export function withLength(sequence: PadSequence, beats: number): PadSequence {
  const lengthBeats = beats === 8 || beats === 16 || beats === 32 ? beats : 4
  return { ...sequence, lengthBeats, notes: sequence.notes.filter((note) => note.startBeat < lengthBeats - 1e-6) }
}

export interface ArrangeSpan {
  name: string
  startBeat: number
  durationBeats: number
  notes: SequenceNote[]
}

/** Song order becomes arrangement clips. An empty song plays the pattern once. */
export function arrangeSong(kit: PadProgram, fallbackNotes: SequenceNote[] = [], fallbackLength = 4): ArrangeSpan[] {
  const sequences = kit.sequences.length
    ? kit.sequences
    : [{ id: 'A', name: 'Pattern', lengthBeats: Math.max(0.25, fallbackLength), notes: fallbackNotes }]
  const song = kit.song.length ? kit.song : [{ sequenceId: sequences[0].id, repeats: 1 }]
  return chainSong(song, sequences).map((span) => {
    const sequence = sequences.find((item) => item.id === span.id) ?? sequences[0]
    return {
      name: sequence.name || 'Pattern',
      startBeat: span.start,
      durationBeats: Math.max(0.25, span.end - span.start),
      notes: sequence.notes.map((note) => ({ ...note })),
    }
  })
}

export function padStrip(pad: PadVoice) {
  return {
    level: pad.level,
    pan: pad.pan,
    send: pad.send,
    insertId: pad.insertId || '',
    busId: pad.busId || '',
    mute: Boolean(pad.muted),
    poly: pad.poly,
  }
}

export function windowOf(region: PadRegion): { start: number; end: number } {
  const span = Math.max(0.0001, region.end - region.start)
  const loopStart = clamp((region.loopStart - region.start) / span, 0, 1)
  const loopEnd = clamp((region.loopEnd - region.start) / span, loopStart, 1)
  return { start: loopStart, end: loopEnd }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

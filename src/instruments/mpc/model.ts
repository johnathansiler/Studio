/** Beat Machine (the Sampler plugin in drums mode). Old pad and drum ids load into it. */

import { repeatIntervalBeats, type RepeatRate } from '../../model/midiClock'
import {
  chainSong,
  chopSample,
  chopsToPads,
  createKit,
  normalizePadKit,
  timingCorrect,
  type MpcOutput,
  type PadProgram,
  type PadRegion,
  type PadSequence,
  type PadVoice,
  type SequenceNote,
} from '../../model/padMachine'

/** Core plugin id. Drums is params.kind >= 1, not a separate insert. */
export const SAMPLER_ID = 'sampler'

/** Saved ids that open the Beat Machine. */
export const LEGACY_DRUM_IDS = ['pads', 'drum-machine', '808', 'drums', 'looper'] as const

export type { MpcOutput, PadRegion }

export function drumsMode(id: string): boolean {
  return (LEGACY_DRUM_IDS as readonly string[]).includes(id) && id !== 'looper'
}

/** Sampler, pads, and the looper all load as the Sampler plugin. */
export function loadsIntoSampler(id: string): boolean {
  return id === SAMPLER_ID || (LEGACY_DRUM_IDS as readonly string[]).includes(id)
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

export const VELOCITY_CURVES = [
  { id: 0, label: 'Linear' },
  { id: 1, label: 'Soft' },
  { id: 2, label: 'Hard' },
  { id: 3, label: 'Fixed' },
] as const

/** Fixed, scaled, and limited velocity. Sensitivity blends the hit toward the fixed value. */
/** Smoothstep. The middle of the pad eases instead of jumping. */
export function smoothPad(place: number): number {
  const t = clamp(place, 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Pad velocity from where the finger landed.
 * 1 is the top of the pad, 0 is the bottom.
 * Pressure and contact radius blend in only when the device reports them.
 */
export function touchVelocity(opts: { place: number; pressure?: number; radius?: number }): number {
  const fromPlace = smoothPad(opts.place)
  const sensed: number[] = []
  if (opts.pressure != null && opts.pressure > 0) sensed.push(clamp(opts.pressure, 0, 1))
  if (opts.radius != null && opts.radius > 1) sensed.push(clamp((opts.radius - 4) / 24, 0, 1))
  if (!sensed.length) return Math.max(1 / 127, fromPlace)
  const extra = sensed.reduce((sum, value) => sum + value, 0) / sensed.length
  return Math.max(1 / 127, Math.min(1, fromPlace * 0.7 + extra * 0.3))
}

export function shapeVelocity(played: number, opts: {
  curve: number
  amount: number
  min: number
  max: number
  fixed: number
  sensitivity: number
}): number {
  const dry = clamp(played, 0, 1)
  const sense = clamp(opts.sensitivity, 0, 1)
  const felt = clamp(opts.fixed, 0, 1) * (1 - sense) + dry * sense
  const curve = clamp(Math.round(opts.curve), 0, 3)
  let shaped = felt
  if (curve === 1) shaped = Math.sqrt(felt)
  else if (curve === 2) shaped = felt * felt
  else if (curve === 3) shaped = clamp(opts.fixed, 0, 1)
  const mixed = curve === 3 ? shaped : felt + (shaped - felt) * clamp(opts.amount, 0, 1)
  const floor = clamp(opts.min, 0, 1)
  const ceiling = clamp(opts.max, floor, 1)
  return clamp(mixed, floor, ceiling)
}

/** Timing and velocity scatter. unitTime and unitVel are 0–1. */
export function humanizeHit(beat: number, velocity: number, timing: number, velAmount: number, unitTime: number, unitVel: number) {
  const shift = (clamp(unitTime, 0, 1) * 2 - 1) * Math.max(0, timing)
  const delta = (clamp(unitVel, 0, 1) * 2 - 1) * Math.max(0, velAmount)
  return {
    beat: Math.max(0, beat + shift),
    velocity: clamp(velocity + delta, 0.01, 1),
    shift,
  }
}

/** Rewrites a recorded pattern. The same random sequence always makes the same edit. */
export function humanizeNotes<T extends { startBeat: number; velocity: number }>(
  notes: T[],
  timing: number,
  velAmount: number,
  rng: () => number,
): T[] {
  return notes.map((note) => {
    const next = humanizeHit(note.startBeat, note.velocity, timing, velAmount, rng(), rng())
    return { ...note, startBeat: next.beat, velocity: next.velocity }
  })
}

export function setStepVelocity(notes: SequenceNote[], pitch: number, step: number, stepBeats: number, velocity: number): SequenceNote[] {
  const beats = stepBeats > 0 ? stepBeats : 0.25
  const start = Math.max(0, step) * beats
  const level = clamp(velocity, 0.01, 1)
  return notes.map((note) => (
    note.pitch === pitch && Math.abs(note.startBeat - start) < beats * 0.45
      ? { ...note, velocity: level }
      : note
  ))
}

/** Grid size in quarter notes, including triplet rates. */
export function quantizeGridBeats(rate: string): number {
  return repeatSetting(rate).beats
}

/** Pull recorded notes onto the grid. Strength 0 leaves them. Swing lands on the off-beat. */
export function quantizeNotes<T extends { startBeat: number }>(notes: T[], rate: string, strength: number, swing: number): T[] {
  const grid = quantizeGridBeats(rate)
  const amount = clamp(strength, 0, 1)
  return notes.map((note) => ({
    ...note,
    startBeat: timingCorrect(note.startBeat, grid, amount, swing, true),
  }))
}

export function stepVelocity(notes: SequenceNote[], pitch: number, step: number, stepBeats: number): number | null {
  const beats = stepBeats > 0 ? stepBeats : 0.25
  const start = step * beats
  const note = notes.find((item) => item.pitch === pitch && Math.abs(item.startBeat - start) < beats * 0.45)
  return note ? note.velocity : null
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

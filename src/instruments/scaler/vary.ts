import type { EvolveMode, ScalerNote, VariationAmount } from './types'
import { degreeTone, getScale, snapToScale } from '../../theory'

export type { EvolveMode, VariationAmount } from './types'
export type StyleKind = 'strum' | 'arp' | 'hits' | 'alberti' | 'walk' | 'pad' | 'roll' | 'run' | 'voicing' | 'slide' | 'pick'

export interface PlayStyle {
  id: string
  name: string
  /** Filter shown as Style. */
  category: string
  genre: string
  mood: string
  culture: string
  description: string
  /** Tempo-synced step, in beats. */
  rate: number
  swing: number
  /** Allowed onset patterns, in beats. */
  rhythms: number[][]
  /** Onsets a major variation must keep when they fit in the bar. */
  required: number[]
  /** Notes in one 4-beat bar, inclusive. */
  density: [number, number]
  /** Largest leap a moved voice may take, in semitones. */
  voiceLead: number
  octaves: number
  /** Timing scatter at full humanize, in beats. */
  humanize: number
  /** Velocity multipliers, cycled across hits. */
  velocity: number[]
  gate: number
  kind: StyleKind
  direction?: 'up' | 'down' | 'alt'
  /** Chord-tone indexes for arpeggios and picking. */
  orders?: number[][]
  voicing?: 'close' | 'shell' | 'rootless' | 'quartal' | 'spread' | 'extended'
}

export interface VariationContext {
  seed: number
  amount: VariationAmount
  root: number
  scaleId: string
  pass: number
  evolve: EvolveMode
}

export const TAKE_LIMIT = 8

export function defaultVariation(): VariationContext {
  return { seed: 1, amount: 'subtle', root: 0, scaleId: 'ionian', pass: 0, evolve: 'off' }
}

/** A new seed that is not the one just heard. */
export function freshSeed(previous = 1) {
  const salt = Math.floor(Math.random() * 0x7ffffffe) + 1
  const mixed = (salt ^ Math.imul(previous || 1, 1664525)) >>> 0
  return mixed || 1
}

/** Keep about eight takes. A new take drops anything after the one you were on. */
export function rememberTake(takes: number[], index: number, seed: number) {
  const keep = takes.slice(0, Math.max(0, index) + (takes.length ? 1 : 0))
  const next = [...keep, seed].slice(-TAKE_LIMIT)
  return { takes: next, index: next.length - 1, seed }
}

export function mixSeed(seed: number, pass: number, evolve: EvolveMode) {
  const base = seed >>> 0 || 1
  if (evolve === 'off' || pass <= 0) return base
  const salt = evolve === 'loop' ? 0x9e3779b1 : 0x85ebca6b
  let x = (base ^ Math.imul(pass + 1, salt)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  return (x ^ (x >>> 15)) >>> 0 || 1
}

export function mulberry32(seed: number) {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Tone = { midi: number; cents: number }

/** One bar of a style. The same seed always returns the same notes. */
export function renderStyled(
  style: PlayStyle,
  tones: Tone[],
  spanBeats: number,
  rate: number,
  swing: number,
  context?: Partial<VariationContext>,
): ScalerNote[] {
  if (!tones.length) return []
  const ctx = { ...defaultVariation(), ...context }
  const span = Math.max(0.25, spanBeats)
  const amount = ctx.amount
  const rng = mulberry32(mixSeed(ctx.seed, ctx.pass, ctx.evolve))
  const step = clamp(rate > 0 ? rate : style.rate, 0.125, 2)
  const feel = clamp(style.swing + swing, 0, 0.7)
  let voices = voiceShape(style, sortTones(tones), ctx, rng, amount)
  if (amount !== 'subtle') voices = moveVoices(style, voices, ctx, rng, amount)
  const rhythm = pickRhythm(style, span, amount, rng)
  const order = pickOrder(style, amount, rng)
  let notes = emit(style, voices, rhythm, order, span, step, feel, rng)
  notes = humanize(style, notes, amount, rng, span)
  if (amount === 'major') notes = majorColor(style, notes, voices, ctx, rng, span)
  else notes = colorTones(style, notes, voices, ctx, rng, span, amount)
  notes = fitDensity(style, notes, voices, span, rhythm)
  return notes.map((note) => tune(note, ctx))
}

function sortTones(tones: Tone[]) {
  return tones.slice().sort((a, b) => a.midi - b.midi || a.cents - b.cents)
}

function voiceShape(style: PlayStyle, tones: Tone[], ctx: VariationContext, rng: () => number, amount: VariationAmount): Tone[] {
  const kind = style.voicing ?? 'close'
  if (kind === 'shell') {
    if (tones.length >= 4) return [tones[1], tones[tones.length - 1]]
    return [tones[0], tones[tones.length - 1]]
  }
  if (kind === 'rootless') return tones.length > 1 ? tones.slice(1) : tones.slice()
  if (kind === 'spread' && tones.length > 1) {
    const top = tones[tones.length - 1]
    const lifted = clamp(top.midi + 12, 0, 127)
    return [...tones.slice(0, -1), { midi: lifted, cents: top.cents }]
  }
  if (kind === 'extended') {
    const root = tones[0]
    const ninth = snapTone(root.midi + 14, ctx)
    return ninth.midi === root.midi ? tones.slice() : [...tones, ninth]
  }
  if (kind === 'quartal') return quartal(tones[0], ctx, 3 + (amount === 'major' && rng() > 0.5 ? 1 : 0))
  return tones.slice()
}

function quartal(root: Tone, ctx: VariationContext, count: number): Tone[] {
  const scale = getScale(ctx.scaleId)
  const out: Tone[] = []
  let cursor = root.midi
  for (let i = 0; i < count; i++) {
    const tone = snapTone(cursor, ctx)
    if (!out.some((item) => item.midi === tone.midi && item.cents === tone.cents)) out.push(tone)
    const fourth = scale.cents.find((cents) => cents >= 450 && cents <= 600) ?? 500
    cursor += Math.max(1, Math.round(fourth / 100))
  }
  return out.length ? out : [root]
}

function moveVoices(style: PlayStyle, tones: Tone[], ctx: VariationContext, rng: () => number, amount: VariationAmount): Tone[] {
  let next = tones.slice()
  if (rng() > 0.35) {
    const turns = 1 + Math.floor(rng() * Math.max(1, next.length - 1))
    for (let i = 0; i < turns; i++) {
      const bass = next.shift()
      if (!bass) break
      next.push({ midi: clamp(bass.midi + 12, 0, 127), cents: bass.cents })
    }
  }
  if (amount === 'major' || rng() > 0.5) {
    const leap = Math.min(style.voiceLead, 12)
    const index = Math.floor(rng() * next.length)
    const tone = next[index]
    const dir = rng() > 0.5 ? 1 : -1
    const jumped = clamp(tone.midi + dir * (12 <= style.octaves * 12 ? 12 : leap), 0, 127)
    if (Math.abs(jumped - tone.midi) <= Math.max(12, style.voiceLead + 12)) next[index] = snapTone(jumped, ctx)
  }
  return next
}

function pickRhythm(style: PlayStyle, span: number, amount: VariationAmount, rng: () => number) {
  const pool = style.rhythms.length ? style.rhythms : [[0]]
  const base = pool[0].filter((beat) => beat < span - 0.02)
  if (amount === 'subtle') return base.length ? base : [0]
  if (amount === 'medium') {
    const choice = pool[Math.floor(rng() * pool.length)] ?? pool[0]
    const hits = choice.filter((beat) => beat < span - 0.02)
    return hits.length ? hits : base
  }
  const allowed = [...new Set(pool.flat())].filter((beat) => beat < span - 0.02).sort((a, b) => a - b)
  const required = style.required.filter((beat) => allowed.includes(beat))
  const chosen = new Set(required)
  const wanted = Math.max(required.length, 1 + Math.floor(rng() * Math.max(1, allowed.length)))
  const rest = allowed.filter((beat) => !chosen.has(beat))
  while (chosen.size < wanted && rest.length) {
    chosen.add(rest.splice(Math.floor(rng() * rest.length), 1)[0])
  }
  const hits = [...chosen].sort((a, b) => a - b)
  return hits.length ? hits : base
}

function pickOrder(style: PlayStyle, amount: VariationAmount, rng: () => number) {
  const orders = style.orders?.length ? style.orders : [[0, 1, 2, 3]]
  if (amount === 'subtle') return orders[0]
  const choice = orders[Math.floor(rng() * orders.length)] ?? orders[0]
  if (amount === 'major' && rng() > 0.6) return choice.slice().reverse()
  return choice
}

function emit(
  style: PlayStyle,
  tones: Tone[],
  rhythm: number[],
  order: number[],
  span: number,
  step: number,
  swing: number,
  rng: () => number,
): ScalerNote[] {
  if (style.kind === 'strum') return strum(style, tones, span, rng)
  if (style.kind === 'arp' || style.kind === 'pick' || style.kind === 'alberti') return arp(style, tones, order, span, step, swing)
  if (style.kind === 'walk') return walk(tones, rhythm, span, swing)
  if (style.kind === 'roll') return roll(tones, span, step, swing)
  if (style.kind === 'run') return run(tones, span, step)
  if (style.kind === 'slide') return slide(tones, rhythm, span)
  if (style.kind === 'pad') return pad(tones, span, style.gate)
  return hits(style, tones, rhythm, span, swing, style.gate)
}

function strum(style: PlayStyle, tones: Tone[], span: number, rng: () => number): ScalerNote[] {
  const dirs = style.direction === 'up' ? [-1] : style.direction === 'alt' ? [1, -1, 1, -1] : [1]
  const gap = span / dirs.length
  const notes: ScalerNote[] = []
  dirs.forEach((dir, pass) => {
    const ordered = dir < 0 ? tones.slice().reverse() : tones
    ordered.forEach((tone, index) => {
      const start = pass * gap + index * 0.03
      if (start >= span) return
      notes.push(noteOf(tone, start, Math.max(0.2, span - start), curve(style, index)))
    })
  })
  if (rng() > 2) return notes
  return notes
}

function arp(style: PlayStyle, tones: Tone[], order: number[], span: number, step: number, swing: number): ScalerNote[] {
  const pattern = style.kind === 'alberti' ? [0, 2, 1, 2] : order
  const count = Math.max(1, Math.floor(span / step))
  const notes: ScalerNote[] = []
  for (let i = 0; i < count; i++) {
    const tone = tones[Math.abs(pattern[i % pattern.length] ?? 0) % tones.length]
    const oct = style.octaves > 1 && i % pattern.length === 0 ? (Math.floor(i / pattern.length) % style.octaves) * 12 : 0
    let start = i * step
    if (i % 2 === 1) start += swing * step * 0.5
    if (start >= span - 0.02) break
    notes.push(noteOf({ midi: clamp(tone.midi + oct, 0, 127), cents: tone.cents }, start, Math.max(0.05, Math.min(step * style.gate, span - start)), curve(style, i)))
  }
  return notes
}

function walk(tones: Tone[], rhythm: number[], span: number, swing: number): ScalerNote[] {
  const beats = rhythm.length >= 4 ? rhythm.slice(0, 4) : [0, 1, 2, 3].filter((beat) => beat < span)
  return beats.map((beat, index) => {
    const tone = tones[index % tones.length]
    const start = beat + (index % 2 === 1 ? swing * 0.3 : 0)
    return noteOf(tone, Math.min(start, span - 0.05), Math.max(0.2, Math.min(0.95, span - start)), index % 2 ? 0.72 : 0.84)
  })
}

function roll(tones: Tone[], span: number, step: number, swing: number): ScalerNote[] {
  const top = tones[tones.length - 1]
  const count = Math.max(4, Math.floor(span / Math.max(0.125, step / 2)))
  const notes: ScalerNote[] = []
  for (let i = 0; i < count; i++) {
    let start = i * (span / count)
    if (i % 2 === 1) start += swing * 0.05
    if (start >= span - 0.02) break
    const vel = clamp(0.45 + (i / count) * 0.5, 0.05, 1)
    notes.push(noteOf(top, start, Math.max(0.05, Math.min(0.2, span - start)), vel))
  }
  return notes
}

function run(tones: Tone[], span: number, step: number): ScalerNote[] {
  const notes: ScalerNote[] = []
  const count = Math.max(4, Math.min(8, Math.floor(span / step)))
  for (let i = 0; i < count; i++) {
    const tone = tones[i % tones.length]
    const start = (span - count * step) + i * step
    if (start < 0) continue
    notes.push(noteOf(tone, start, Math.max(0.08, step * 0.9), 0.7 + i * 0.03))
  }
  return notes.length ? notes : [noteOf(tones[0], 0, span, 0.8)]
}

function slide(tones: Tone[], rhythm: number[], span: number): ScalerNote[] {
  const notes: ScalerNote[] = []
  const hits = rhythm.length ? rhythm : [0, 2]
  for (const beat of hits) {
    if (beat >= span) continue
    const tone = tones[Math.floor(beat) % tones.length]
    const grace = { midi: clamp(tone.midi - 1, 0, 127), cents: tone.cents }
    notes.push(noteOf(grace, beat, 0.08, 0.55))
    notes.push(noteOf(tone, beat + 0.08, Math.max(0.12, Math.min(0.4, span - beat)), 0.86))
  }
  return notes
}

function pad(tones: Tone[], span: number, gate: number): ScalerNote[] {
  return tones.map((tone, index) => noteOf(tone, index * 0.02, Math.max(0.5, span * gate), 0.62 + index * 0.04))
}

function hits(style: PlayStyle, tones: Tone[], rhythm: number[], span: number, swing: number, gate: number): ScalerNote[] {
  const notes: ScalerNote[] = []
  const times = rhythm.length ? rhythm : [0]
  for (const beat of times) {
    if (beat >= span) continue
    const late = Math.round(beat * 2) % 2 === 1
    const start = beat + (late ? swing * 0.35 : 0)
    tones.forEach((tone, index) => {
      notes.push(noteOf(tone, start, Math.max(0.08, Math.min(gate, span - start)), curve(style, index) * (late ? 0.9 : 1)))
    })
  }
  return notes
}

function humanize(style: PlayStyle, notes: ScalerNote[], amount: VariationAmount, rng: () => number, span: number): ScalerNote[] {
  const depth = style.humanize * (amount === 'subtle' ? 0.45 : amount === 'medium' ? 0.75 : 1)
  return notes.map((note) => {
    const sway = (rng() - 0.5) * 2 * depth
    const vel = clamp(note.velocity * (0.9 + rng() * 0.18), 0.05, 1)
    return { ...note, startBeat: clamp(note.startBeat + sway, 0, Math.max(0, span - 0.04)), velocity: vel, durationBeats: note.durationBeats }
  }).map((note, index) => ({ ...note, velocity: curveValue(style, index, note.velocity) }))
}

function colorTones(style: PlayStyle, notes: ScalerNote[], _tones: Tone[], ctx: VariationContext, rng: () => number, span: number, amount: VariationAmount): ScalerNote[] {
  const next = notes.slice()
  const room = Math.max(0, barMax(style, span) - next.length)
  if (room < 1 || rng() > (amount === 'subtle' ? 0.55 : 0.85)) return next
  const host = next[Math.floor(rng() * next.length)] ?? next[0]
  if (rng() > 0.45 && room >= 1) {
    next.push({ ...host, startBeat: clamp(host.startBeat + 0.03, 0, span - 0.05), velocity: clamp(host.velocity * 0.42, 0.05, 0.55), durationBeats: 0.08 })
  }
  if (room >= 1 && rng() > 0.4) {
    const neighbor = neighborTone(host, ctx, rng() > 0.5 ? 1 : -1)
    if (Math.abs(neighbor.midi - host.pitch) <= style.voiceLead + 2) {
      next.push(noteOf(neighbor, clamp(host.startBeat + 0.12, 0, span - 0.05), 0.12, clamp(host.velocity * 0.7, 0.05, 1)))
    }
  }
  return next
}

function majorColor(style: PlayStyle, notes: ScalerNote[], tones: Tone[], ctx: VariationContext, rng: () => number, span: number): ScalerNote[] {
  let next = colorTones(style, notes, tones, ctx, rng, span, 'major')
  const max = barMax(style, span)
  if (next.length + 3 <= max) {
    const passing = passingChord(tones[0] ?? { midi: 60, cents: 0 }, ctx)
    const at = Math.min(span * 0.5, (style.rhythms[0]?.[1] ?? 2))
    passing.forEach((tone, index) => next.push(noteOf(tone, at + index * 0.01, 0.35, 0.62)))
  }
  if (next.length + 3 <= max) {
    const top = tones[tones.length - 1] ?? tones[0]
    const start = Math.max(0, span - 1)
    for (let i = 0; i < 4 && next.length < max; i++) {
      const tone = snapTone(top.midi + i, ctx)
      next.push(noteOf(tone, start + i * 0.25, 0.2, 0.5 + i * 0.08))
    }
  }
  if (next.length + 1 <= max && next.length) {
    const call = next[0]
    const answer = neighborTone({ pitch: call.pitch, fine: call.fine }, ctx, 1)
    next.push(noteOf(answer, Math.min(span * 0.75, span - 0.08), 0.3, clamp(call.velocity * 0.8, 0.05, 1)))
  }
  return next
}

function fitDensity(style: PlayStyle, notes: ScalerNote[], tones: Tone[], span: number, rhythm: number[]): ScalerNote[] {
  const min = barMin(style, span)
  const max = barMax(style, span)
  const list = notes.slice().sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  while (list.length > max && list.length > 1) {
    let drop = list.length - 1
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].velocity < 0.5) { drop = i; break }
    }
    list.splice(drop, 1)
  }
  let guard = 0
  const onsets = rhythm.length ? rhythm : [0]
  while (list.length < min && guard < 24) {
    const tone = tones[list.length % tones.length]
    const onset = onsets[list.length % onsets.length] ?? 0
    const start = clamp(onset, 0, Math.max(0, span - 0.05))
    list.push(noteOf(tone, start, Math.max(0.08, Math.min(0.4, span - start)), curve(style, list.length)))
    guard += 1
  }
  return list.slice(0, max)
}

function tune(note: ScalerNote, ctx: VariationContext): ScalerNote {
  const snapped = snapToScale(note.pitch, note.fine ?? 0, ctx.root, ctx.scaleId)
  return {
    ...note,
    pitch: snapped.midi,
    fine: snapped.cents ? Math.round(snapped.cents) : undefined,
    velocity: clamp(note.velocity, 0.05, 1),
    durationBeats: Math.max(0.04, note.durationBeats),
  }
}

function neighborTone(note: { pitch: number; fine?: number }, ctx: VariationContext, dir: number): Tone {
  const scale = getScale(ctx.scaleId)
  const relative = ((note.pitch - ctx.root) % 12 + 12) % 12 * 100 + (note.fine ?? 0)
  let index = 0
  let best = 1200
  scale.cents.forEach((cents, step) => {
    const delta = Math.min(Math.abs(cents - relative), 1200 - Math.abs(cents - relative))
    if (delta < best) { best = delta; index = step }
  })
  const next = scale.cents[(index + (dir < 0 ? scale.cents.length - 1 : 1)) % scale.cents.length]
  const oct = dir < 0 && next > scale.cents[index] ? -12 : dir > 0 && next < scale.cents[index] ? 12 : 0
  return snapTone(note.pitch - ((note.pitch - ctx.root) % 12) + Math.round(next / 100) + oct, ctx)
}

function passingChord(root: Tone, ctx: VariationContext): Tone[] {
  const step = degreeTone(ctx.root, 1, ctx.scaleId)
  const base = snapTone(root.midi + (step.midi - degreeTone(ctx.root, 0, ctx.scaleId).midi), ctx)
  return [0, 2, 4].map((degree) => {
    const tone = degreeTone(base.midi, degree, ctx.scaleId)
    return { midi: clamp(tone.midi, 0, 127), cents: tone.cents }
  })
}

function snapTone(midi: number, ctx: VariationContext): Tone {
  const snapped = snapToScale(clamp(Math.round(midi), 0, 127), 0, ctx.root, ctx.scaleId)
  return { midi: snapped.midi, cents: snapped.cents }
}

function curve(style: PlayStyle, index: number) {
  const table = style.velocity.length ? style.velocity : [0.84]
  return clamp(table[index % table.length], 0.05, 1)
}

function curveValue(style: PlayStyle, index: number, velocity: number) {
  return clamp(velocity * 0.55 + curve(style, index) * 0.45, 0.05, 1)
}

function noteOf(tone: Tone, start: number, duration: number, velocity: number): ScalerNote {
  return {
    pitch: clamp(Math.round(tone.midi), 0, 127),
    fine: tone.cents ? Math.round(tone.cents) : undefined,
    startBeat: Math.max(0, start),
    durationBeats: Math.max(0.04, duration),
    velocity: clamp(velocity, 0.05, 1),
  }
}

function barMin(style: PlayStyle, span: number) {
  return Math.max(1, Math.round(style.density[0] * span / 4))
}

function barMax(style: PlayStyle, span: number) {
  return Math.max(barMin(style, span), Math.round(style.density[1] * span / 4))
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

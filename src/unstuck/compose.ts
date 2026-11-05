/**
 * Seeded Unstuck ideas. Part actions write one role. Full song is explicit.
 * Harmony comes from Scaler's progressions. Grooves come from the style generators.
 */

import { chordNotes, type ResolvedChord } from '../generators/chords'
import { generate } from '../generators/generate'
import { clamp, hashSeed, mulberry32, roundBeat } from '../generators/rng'
import { styleById } from '../generators/styles'
import type { GeneratedNote, GeneratorChord, GeneratorInput } from '../generators/types'
import { getScale } from '../theory/scales'
import { progressionsFor, realizeProgression } from '../theory/progress'
import {
  ensureScale,
  formOf,
  genreById,
  nextKind,
  partBars,
  roleById,
  roleLabel,
  scaleIsBuiltin,
  sectionBars,
  sectionEnergy,
  type MoodId,
  type RoleId,
  type UnstuckBrief,
} from './brief'
import type { ComposeContext, DraftNote, DraftTrack, PlanSection, SongDraft, UnstuckJob } from './draft'
import { complementRole } from './read'
import { varyNotes } from './vary'

const MOOD: Record<MoodId, { vel: number; octave: number }> = {
  calm: { vel: 0.78, octave: 0 },
  warm: { vel: 0.9, octave: 0 },
  bright: { vel: 0.96, octave: 12 },
  dark: { vel: 0.86, octave: -12 },
  tense: { vel: 0.9, octave: 0 },
  lifted: { vel: 1, octave: 12 },
}

const SALT: Record<RoleId, number> = { drums: 3, bass: 5, chords: 7, melody: 9, arp: 11, pad: 13 }

export function pickTempo(brief: UnstuckBrief) {
  const genre = genreById(brief.genre)
  const lo = Math.max(40, Math.min(brief.tempoMin, brief.tempoMax))
  const hi = Math.min(240, Math.max(brief.tempoMin, brief.tempoMax))
  const spanLo = Math.max(lo, genre.tempo[0])
  const spanHi = Math.min(hi, genre.tempo[1])
  if (spanHi <= spanLo) return Math.round(clamp((genre.tempo[0] + genre.tempo[1]) / 2, lo, hi))
  const rng = mulberry32(hashSeed(brief.seed, 0, 4))
  return Math.round(spanLo + rng() * (spanHi - spanLo))
}

export function composeUnstuck(raw: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext): SongDraft {
  const brief = raw
  const bar = Math.max(1, ctx.barBeats || 4)
  const roles = rolesFor(brief, job, ctx)
  const plans = planSections(brief, job, ctx, bar)
  const steer = job.action !== 'vary' && job.action !== 'fill' && job.action !== 'transition'
  const tracks = roles.map((role) => trackFor(brief, job, ctx, role, plans, bar)).filter((track) => track.clips.some((clip) => clip.notes.length))
  const end = plans.reduce((max, plan) => Math.max(max, plan.startBeat + plan.bars * bar), ctx.startBeat)
  const previous = ctx.previousEnd ?? end
  const spanEnd = Math.max(end, previous)
  const written = new Set(tracks.map((track) => track.role))
  return {
    summary: summary(brief, job, plans, tracks),
    seed: brief.seed,
    tempo: steer ? pickTempo(brief) : undefined,
    key: steer ? brief.key : undefined,
    scaleId: steer ? brief.scale : undefined,
    sections: publish(job, plans, bar),
    sectionMode: sectionMode(job, ctx),
    tracks,
    replace: ctx.replace && written.size
      ? { startBeat: Math.min(ctx.startBeat, plans[0]?.startBeat ?? ctx.startBeat), endBeat: spanEnd, roles: [...written] }
      : undefined,
  }
}

function rolesFor(brief: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext): RoleId[] {
  if (job.action === 'part') return [job.role]
  if (job.action === 'fill') return ['drums']
  if (job.action === 'transition') return ['drums', 'melody']
  if (job.action === 'vary' || job.action === 'continue') return [clipRole(ctx)]
  if (job.action === 'complement') return [complementRole(ctx.clip?.role ?? 'other')]
  if (job.action === 'rewrite') return job.roles.filter((role) => !brief.locks.includes(role))
  return brief.parts.filter((role) => !brief.locks.includes(role))
}

function clipRole(ctx: ComposeContext): RoleId {
  const role = ctx.clip?.role
  if (!role || role === 'other') return 'melody'
  return role
}

function planSections(brief: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext, bar: number): PlanSection[] {
  if (job.action === 'full') {
    let beat = ctx.startBeat
    return formOf(brief).map((section) => {
      const plan = { kind: section.kind, name: section.name, startBeat: beat, bars: section.bars, energy: blend(section.energy, brief.energy) }
      beat += section.bars * bar
      return plan
    })
  }
  if (job.action === 'next-section' || (job.action === 'continue' && job.bars === 'section')) {
    const kind = nextKind(ctx.afterKind)
    const bars = sectionBars(kind)
    return [{ kind, name: kind === 'pre' ? 'Pre' : kind === 'breakdown' ? 'Breakdown' : titleCase(kind), startBeat: ctx.startBeat, bars, energy: blend(sectionEnergy(kind), brief.energy) }]
  }
  if (job.action === 'rewrite') {
    return [{ kind: job.kind, name: job.name, startBeat: ctx.startBeat, bars: Math.max(1, job.bars), energy: blend(sectionEnergy(job.kind), brief.energy) }]
  }
  if (job.action === 'part' && ctx.sections?.length) return ctx.sections.map((section) => ({ ...section, energy: blend(section.energy, brief.energy) }))
  const bars = job.action === 'fill' || job.action === 'transition'
    ? 1
    : job.action === 'continue' && job.bars !== 'section'
      ? job.bars
      : job.action === 'vary' || job.action === 'complement'
        ? Math.max(1, ctx.clip?.bars ?? partBars(brief))
        : partBars(brief)
  return [{ kind: 'verse', name: 'Part', startBeat: ctx.startBeat, bars, energy: blend(0.7, brief.energy) }]
}

function trackFor(brief: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext, role: RoleId, plans: PlanSection[], bar: number): DraftTrack {
  const meta = roleById(role)
  const genre = genreById(brief.genre)
  const instrument = role === 'bass' && (genre.id === 'trap' || genre.id === 'drill' || genre.id === 'amapiano') ? '808' : meta.instrument
  const scaleId = ensureScale(brief.scale)
  const clips = plans.map((plan, index) => {
    const notes = notesFor(brief, job, ctx, role, plan, index, bar)
    return {
      name: clipName(role, plan.name, job),
      startBeat: plan.startBeat,
      durationBeats: plan.bars * bar,
      notes,
    }
  }).filter((clip) => clip.notes.length)
  return {
    role,
    name: meta.track,
    color: meta.color,
    instrument,
    pluginId: meta.plugin,
    mix: meta.mix,
    volume: meta.volume,
    pan: meta.pan,
    seed: brief.seed,
    scaler: role === 'chords' ? scalerPatch(brief, scaleId) : undefined,
    clips,
  }
}

function notesFor(brief: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext, role: RoleId, plan: PlanSection, index: number, bar: number): DraftNote[] {
  if (job.action === 'vary' && ctx.clip) return varyNotes(ctx.clip, brief.amount, brief.seed, brief.scale, brief.key)
  if (job.action === 'fill' && role === 'drums') return shape(drumFill(plan.bars * bar, plan.energy), brief, plan, role, index, bar, false)
  if (job.action === 'transition') {
    if (role === 'drums') return shape(drumFill(plan.bars * bar, Math.max(plan.energy, 0.8)), brief, plan, role, index, bar, false)
    return shape(rise(brief, plan.bars * bar), brief, plan, role, index, bar, false)
  }
  const chords = chordsFor(brief, job, ctx, plan, index, bar)
  if (role === 'drums') return shape(colorDrums(generated('drums', brief, plan, index, bar, []).notes, plan), brief, plan, role, index, bar, true)
  if (role === 'chords') return shape(voicedChords(chords, brief), brief, plan, role, index, bar, false)
  if (role === 'pad') return shape(padNotes(chords, plan.energy), brief, plan, role, index, bar, false)
  if (role === 'bass' || role === 'melody' || role === 'arp') return shape(generated(role, brief, plan, index, bar, chords).notes, brief, plan, role, index, bar, false)
  return []
}

function generated(kind: 'drums' | 'bass' | 'melody' | 'arp', brief: UnstuckBrief, plan: PlanSection, index: number, bar: number, chords: GeneratorChord[]) {
  return generate(kind, inputFor(brief, plan, index, bar, chords, kind))
}

function chordsFor(brief: UnstuckBrief, job: UnstuckJob, ctx: ComposeContext, plan: PlanSection, index: number, bar: number): GeneratorChord[] {
  if ((job.action === 'continue' || job.action === 'complement') && ctx.clip && (ctx.clip.role === 'chords' || ctx.clip.role === 'pad')) {
    const heard = chordsFromGroups(ctx.clip.notes, bar)
    if (heard.length) return tileChords(heard, plan.bars, bar)
  }
  if ((job.action === 'complement' && ctx.clip?.role === 'melody') || (job.action === 'continue' && ctx.clip?.role === 'melody')) {
    const under = chordsUnder(brief, ctx.clip, plan.bars, bar, index)
    if (under.length) return under
  }
  return harmonicChords(brief, plan.bars, bar, index)
}

function harmonicChords(brief: UnstuckBrief, bars: number, barBeats: number, rotation: number): GeneratorChord[] {
  const scaleId = ensureScale(brief.scale)
  const list = progressionsFor(scaleId)
  const picked = list[(brief.seed + rotation) % Math.max(1, list.length)]
  // Spelled progressions are 12-tone. Microtonal scales keep their own degrees so quarter tones survive.
  const microtonal = getScale(scaleId).cents.some((cents) => cents % 100 !== 0)
  const pattern = picked && microtonal && picked.spell ? { ...picked, spell: undefined } : picked
  const size = brief.complexity >= 0.66 ? 4 : 3
  const realized = pattern ? realizeProgression(brief.key, scaleId, pattern, barBeats, size as 3 | 4) : []
  if (realized.length) {
    const degree = getScale(scaleId).cents
    const out: GeneratorChord[] = []
    for (let i = 0; i < bars; i++) {
      const chord = realized[(i + rotation) % realized.length]
      const inverted = invertPairs(chord.tones.map((tone) => ({ pitch: tone.midi, fine: tone.cents || 0 })), (rotation + i) % Math.max(1, chord.tones.length))
      const root = pc(brief.key + Math.round((degree[chord.degree] ?? 0) / 100))
      out.push({
        pitches: inverted.map((tone) => tone.pitch),
        ...(inverted.some((tone) => tone.fine) ? { cents: inverted.map((tone) => tone.fine) } : {}),
        beats: barBeats,
        symbol: chord.symbol,
        root,
      })
    }
    return out
  }
  const fallback = generate('chords', inputFor(brief, { kind: 'verse', name: 'Part', startBeat: 0, bars, energy: brief.energy }, rotation, barBeats, [], 'chords'))
  return tileChords(fallback.chords, bars, barBeats)
}

function voicedChords(chords: GeneratorChord[], brief: UnstuckBrief): DraftNote[] {
  const style = styleById(genreById(brief.genre).style)
  const resolved = asResolved(chords)
  if (!resolved.length) return []
  return chordNotes(resolved, style, inputFor(brief, { kind: 'verse', name: 'Part', startBeat: 0, bars: 1, energy: 1 }, 0, 4, [], 'chords')).map(asDraft)
}

function padNotes(chords: GeneratorChord[], energy: number): DraftNote[] {
  if (energy < 0.34 || !chords.length) return []
  let beat = 0
  const notes: DraftNote[] = []
  for (const chord of chords) {
    for (const pitch of unique(chord.pitches)) {
      notes.push({ pitch, startBeat: beat, durationBeats: Math.max(0.5, chord.beats - 0.08), velocity: 0.4, ...(chord.cents ? { fine: chord.cents[chord.pitches.indexOf(pitch)] || undefined } : {}) })
    }
    beat += chord.beats
  }
  return notes
}

function colorDrums(notes: GeneratedNote[], plan: PlanSection): DraftNote[] {
  const out: DraftNote[] = []
  for (const note of notes) {
    const pos = ((note.startBeat % 4) + 4) % 4
    if ((plan.kind === 'intro' || plan.kind === 'outro') && note.pitch === 42 && Math.round(note.startBeat * 4) % 2 === 1) continue
    if ((plan.kind === 'bridge' || plan.kind === 'breakdown') && note.pitch === 36 && pos > 0.2 && Math.abs(pos - 2) > 0.2) continue
    if ((plan.kind === 'bridge' || plan.kind === 'breakdown') && note.pitch === 42 && pos > 2.2) continue
    if (plan.kind === 'chorus' && (note.pitch === 38 || note.pitch === 40) && note.velocity >= 0.55) {
      out.push({ pitch: 39, startBeat: note.startBeat, durationBeats: note.durationBeats, velocity: Math.min(1, note.velocity * 0.85) })
    }
    if (plan.kind === 'pre' && note.pitch === 42 && Math.abs(pos - 3.5) < 0.08) {
      out.push({ pitch: 46, startBeat: note.startBeat, durationBeats: 0.2, velocity: 0.5 })
    }
    out.push(asDraft(note))
  }
  if (plan.kind === 'verse') {
    for (const note of notes) {
      if (note.pitch !== 38) continue
      const at = note.startBeat - 0.25
      if (at < 0) continue
      out.push({ pitch: 38, startBeat: roundBeat(at), durationBeats: 0.08, velocity: 0.26 })
    }
  }
  if (plan.kind === 'chorus') out.push({ pitch: 49, startBeat: 0, durationBeats: 0.45, velocity: 0.58 })
  return out
}

function withFill(notes: DraftNote[], bars: number, bar: number, energy: number) {
  if (bars < 2 || energy < 0.28) return notes
  const start = (bars - 1) * bar + bar / 2
  const end = bars * bar
  const kept = notes.filter((note) => note.startBeat < start - 0.001 || note.pitch === 36)
  const step = energy >= 0.75 ? 0.25 : 0.5
  for (let beat = start; beat < end - 0.04; beat += step) {
    kept.push({ pitch: 38, startBeat: roundBeat(beat), durationBeats: 0.1, velocity: clamp(0.42 + ((beat - start) / Math.max(0.25, end - start)) * 0.45, 0.2, 1) })
  }
  return kept
}

function drumFill(beats: number, energy: number): DraftNote[] {
  const notes: DraftNote[] = [{ pitch: 36, startBeat: 0, durationBeats: 0.2, velocity: 0.9 }]
  const step = energy > 0.65 ? 0.25 : 0.5
  for (let beat = 0; beat < beats - 0.05; beat += step) {
    notes.push({ pitch: beat < beats / 2 ? 42 : 38, startBeat: roundBeat(beat), durationBeats: 0.1, velocity: clamp(0.4 + (beat / beats) * 0.5, 0.2, 1) })
  }
  notes.push({ pitch: 49, startBeat: roundBeat(Math.max(0, beats - 0.25)), durationBeats: 0.35, velocity: 0.72 })
  return notes
}

function rise(brief: UnstuckBrief, beats: number): DraftNote[] {
  const spec = getScale(ensureScale(brief.scale))
  const tonic = 64 + brief.key
  const steps = (spec.cents.length ? spec.cents : [0, 200, 400, 500]).slice(0, 4)
  const start = Math.max(0, beats - 1)
  return steps.map((cents, index) => {
    const semis = Math.round(cents / 100)
    const fine = Math.round(cents - semis * 100)
    return {
      pitch: tonic + semis,
      ...(fine ? { fine } : {}),
      startBeat: roundBeat(start + index * 0.25),
      durationBeats: 0.22,
      velocity: 0.55 + index * 0.08,
    }
  })
}

function shape(notes: DraftNote[], brief: UnstuckBrief, plan: PlanSection, role: RoleId, index: number, bar: number, fill: boolean): DraftNote[] {
  let next = applyFeel(notes, brief.feel, role)
  if (fill) next = withFill(next, plan.bars, bar, plan.energy)
  next = thin(next, brief, role, index)
  next = humanize(next, brief, role, index)
  next = level(next, brief, plan, role)
  return next.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch || (a.fine ?? 0) - (b.fine ?? 0))
}

function applyFeel(notes: DraftNote[], feel: UnstuckBrief['feel'], role: RoleId): DraftNote[] {
  if (feel === 'straight') return notes.map((note) => ({ ...note, startBeat: Math.round(note.startBeat * 4) / 4 }))
  if (feel === 'swing' || feel === 'shuffle') {
    const target = feel === 'shuffle' ? 2 / 3 : 0.58
    return notes.map((note) => {
      const beat = Math.floor(note.startBeat + 1e-6)
      const frac = note.startBeat - beat
      if (frac > 0.4 && frac < 0.72) return { ...note, startBeat: roundBeat(beat + target) }
      return note
    })
  }
  if (feel === 'half-time' && role === 'drums') {
    return notes.filter((note) => (note.pitch !== 38 && note.pitch !== 40) || Math.abs((((note.startBeat % 4) + 4) % 4) - 2) < 0.3)
  }
  if (feel === 'half-time' && role === 'bass') {
    return notes.filter((note) => {
      const pos = ((note.startBeat % 4) + 4) % 4
      return pos < 0.2 || Math.abs(pos - 2) < 0.2
    })
  }
  if (feel === 'double-time' && role === 'drums') {
    const hats = notes.filter((note) => note.pitch === 42).map((note) => ({ ...note, startBeat: roundBeat(note.startBeat + 0.25), velocity: note.velocity * 0.72 }))
    return [...notes, ...hats]
  }
  return notes
}

function thin(notes: DraftNote[], brief: UnstuckBrief, role: RoleId, index: number) {
  if (brief.density >= 0.99) return notes
  const rng = mulberry32(hashSeed(brief.seed, index + 1, SALT[role] + 20))
  const keep = brief.density
  return notes.filter((note) => {
    if (role === 'drums' && note.pitch === 36 && note.velocity >= 0.75) return true
    if (note.velocity >= 0.93) return true
    return rng() < 0.15 + keep * 0.85
  })
}

function humanize(notes: DraftNote[], brief: UnstuckBrief, role: RoleId, index: number) {
  if (brief.humanize <= 0.001) return notes
  const rng = mulberry32(hashSeed(brief.seed, index + 3, SALT[role] + 30))
  const limit = brief.humanize * 0.035
  return notes.map((note) => ({
    ...note,
    startBeat: Math.max(0, roundBeat(note.startBeat + (rng() - 0.5) * 2 * limit)),
    velocity: clamp(note.velocity * (1 + (rng() - 0.5) * 2 * brief.humanize * 0.18), 0.05, 1),
  }))
}

function level(notes: DraftNote[], brief: UnstuckBrief, plan: PlanSection, role: RoleId) {
  const mood = MOOD[brief.mood]
  const gain = (0.62 + plan.energy * 0.4) * mood.vel
  const shift = role === 'melody' || role === 'arp' ? mood.octave : 0
  return notes.map((note) => ({
    ...note,
    pitch: clamp(note.pitch + shift, role === 'bass' ? 28 : 36, role === 'bass' ? 64 : 96),
    velocity: clamp(note.velocity * gain, 0.05, 1),
  }))
}

function inputFor(brief: UnstuckBrief, plan: PlanSection, index: number, bar: number, chords: GeneratorChord[], kind: string): GeneratorInput {
  const genre = genreById(brief.genre)
  const style = styleById(genre.style)
  const scaleId = ensureScale(brief.scale)
  return {
    key: brief.key,
    scaleId,
    scale: [],
    chords,
    tempo: pickTempo(brief),
    bars: plan.bars,
    style: genre.style,
    seed: (brief.seed + index * 97 + (SALT[kind as RoleId] ?? 1)) >>> 0,
    variation: Math.round(brief.complexity * 3) + (brief.mood === 'tense' ? 1 : 0),
    beatsPerBar: bar,
    options: {
      arpPattern: style.arp.pattern,
      rate: style.arp.rate,
      octaves: style.arp.octaves,
      gate: style.arp.gate,
      strum: style.strum,
    },
  }
}

function scalerPatch(brief: UnstuckBrief, scaleId: string) {
  return {
    root: brief.key,
    scale: scaleIsBuiltin(scaleId) ? scaleId : 'ionian' as const,
    library: scaleIsBuiltin(scaleId) ? '' : scaleId,
    group: brief.complexity >= 0.66 ? 'ninth' as const : brief.complexity >= 0.33 ? 'seventh' as const : 'triad' as const,
    voicing: brief.complexity >= 0.55 ? 'drop2' as const : 'close' as const,
    inversion: 0,
    voiceLead: true,
    sound: 'synth' as const,
    rhythm: 'block' as const,
  }
}

function chordsFromGroups(notes: DraftNote[], bar: number): GeneratorChord[] {
  const groups: DraftNote[][] = []
  for (const note of [...notes].sort((a, b) => a.startBeat - b.startBeat)) {
    const last = groups[groups.length - 1]
    if (!last || note.startBeat - last[0].startBeat > 0.12) groups.push([note])
    else last.push(note)
  }
  return groups.map((group, index) => {
    const next = groups[index + 1]
    const beats = next ? Math.max(0.25, next[0].startBeat - group[0].startBeat) : bar
    return {
      pitches: group.map((note) => note.pitch),
      beats,
      root: pc(Math.min(...group.map((note) => note.pitch))),
    }
  })
}

function chordsUnder(brief: UnstuckBrief, clip: NonNullable<ComposeContext['clip']>, bars: number, bar: number, rotation: number) {
  const pool = harmonicChords(brief, Math.max(bars, 4), bar, rotation)
  if (!pool.length) return []
  const out: GeneratorChord[] = []
  for (let i = 0; i < bars; i++) {
    const start = (i % Math.max(1, clip.bars)) * bar
    const pcs = new Set(clip.notes.filter((note) => note.startBeat >= start - 0.01 && note.startBeat < start + bar).map((note) => pc(note.pitch)))
    const hit = pool.find((chord) => [...pcs].some((pitch) => chord.pitches.some((item) => pc(item) === pitch))) ?? pool[i % pool.length]
    out.push({ ...hit, beats: bar })
  }
  return out
}

function tileChords(chords: GeneratorChord[], bars: number, bar: number) {
  if (!chords.length) return []
  const out: GeneratorChord[] = []
  for (let i = 0; i < bars; i++) out.push({ ...chords[i % chords.length], beats: bar })
  return out
}

function asResolved(chords: GeneratorChord[]): ResolvedChord[] {
  let start = 0
  return chords.filter((chord) => chord.pitches.length && chord.beats > 0).map((chord) => {
    const item: ResolvedChord = {
      ...chord,
      pitches: chord.pitches.map((pitch) => Math.round(pitch)),
      start,
      root: chord.root ?? pc(Math.min(...chord.pitches)),
      beats: chord.beats,
    }
    start += chord.beats
    return item
  })
}

function invertPairs(pairs: { pitch: number; fine: number }[], times: number) {
  const voiced = [...pairs].sort((a, b) => a.pitch - b.pitch || a.fine - b.fine)
  const count = voiced.length ? times % voiced.length : 0
  for (let i = 0; i < count; i++) {
    const low = voiced.shift()
    if (!low) break
    voiced.push({ pitch: low.pitch + 12, fine: low.fine })
  }
  return voiced
}

function clipName(role: RoleId, section: string, job: UnstuckJob) {
  const label = roleLabel(role)
  if (job.action === 'fill') return 'Ideas Fill'
  if (job.action === 'transition') return `Ideas Transition · ${label}`
  if (job.action === 'vary') return `Ideas Variation · ${label}`
  if (job.action === 'continue') return `Ideas Continue · ${label}`
  if (section === 'Part') return `Ideas ${label}`
  return `Ideas ${label} · ${section}`
}

function publish(job: UnstuckJob, plans: PlanSection[], bar: number) {
  if (job.action === 'full' || job.action === 'next-section' || (job.action === 'continue' && job.bars === 'section')) {
    return plans.map((plan) => ({
      kind: plan.kind,
      name: plan.name,
      startBeat: plan.startBeat,
      durationBeats: plan.bars * bar,
    }))
  }
  return []
}

function sectionMode(job: UnstuckJob, ctx: ComposeContext): SongDraft['sectionMode'] {
  if (job.action === 'full') return ctx.replace ? 'replace' : 'add'
  if (job.action === 'next-section' || (job.action === 'continue' && job.bars === 'section')) return 'add'
  return 'none'
}

function summary(brief: UnstuckBrief, job: UnstuckJob, plans: PlanSection[], tracks: DraftTrack[]) {
  const genre = genreById(brief.genre).name
  if (!tracks.length) return 'Every part is locked.'
  if (job.action === 'full') return `${genre} full song, ${plans.length} sections.`
  if (job.action === 'part') return `${genre} ${roleLabel(job.role).toLowerCase()}, ${plans.reduce((sum, plan) => sum + plan.bars, 0)} bars.`
  if (job.action === 'fill') return `${genre} fill.`
  if (job.action === 'transition') return `${genre} transition.`
  if (job.action === 'next-section') return `${genre} ${plans[0]?.name ?? 'section'}.`
  if (job.action === 'continue') return `Continue ${roleLabel(tracks[0].role).toLowerCase()}.`
  if (job.action === 'vary') return `Variation of ${roleLabel(tracks[0].role).toLowerCase()}.`
  if (job.action === 'complement') return `Added ${roleLabel(tracks[0].role).toLowerCase()}.`
  if (job.action === 'rewrite') return `Rewrote ${plans[0]?.name ?? 'section'}.`
  return genre
}

function blend(section: number, energy: number) {
  return clamp(section * 0.62 + energy * 0.38, 0.2, 1)
}

function asDraft(note: GeneratedNote): DraftNote {
  return {
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: note.durationBeats,
    velocity: note.velocity,
    ...(note.fine ? { fine: note.fine } : {}),
    ...(note.slide ? { slide: true } : {}),
  }
}

function unique(pitches: number[]) {
  const seen = new Set<number>()
  const out: number[] = []
  for (const pitch of pitches) {
    const rounded = Math.round(pitch)
    if (seen.has(rounded)) continue
    seen.add(rounded)
    out.push(rounded)
  }
  return out
}

function pc(pitch: number) {
  return ((Math.round(pitch) % 12) + 12) % 12
}

function titleCase(kind: string) {
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

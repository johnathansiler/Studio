import { uid } from './types'

/** One sixteenth note, in quarter-note beats. */
export const STEP_BEAT = 0.25

export type DrumKind = 'kick' | 'snare' | 'clap' | 'hat' | 'perc' | 'note'

export interface StepCell {
  on: boolean
  velocity: number
  pan: number
  pitch: number
  fine: number
  gate: number
  /** Beats added to the step, after swing. */
  nudge?: number
}

export interface StepChannel {
  id: string
  name: string
  kind: DrumKind
  note: number
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  /** Mixer track or bus id. Null uses the first instrument track. */
  output: string | null
  sampleId: string | null
  /** Row length. Shorter than the pattern loops as a polymeter. */
  steps: number
  /** Null follows the pattern swing. */
  swing: number | null
  cells: StepCell[]
}

export interface BeatPattern {
  id: string
  name: string
  color: string
  steps: number
  swing: number
  channels: StepChannel[]
}

export interface BeatRack {
  activeId: string
  patterns: BeatPattern[]
}

export interface PatternClip {
  id: string
  patternId: string
  startBeat: number
  lengthBeats: number
  /** Session scene, when placed in a clip slot. */
  scene: number | null
}

export interface RenderedHit {
  channelId: string
  kind: DrumKind
  output: string | null
  sampleId: string | null
  volume: number
  pitch: number
  fine: number
  pan: number
  startBeat: number
  durationBeats: number
  velocity: number
}

export function clampStepCount(value: number): number {
  if (!Number.isFinite(value)) return 16
  return Math.max(1, Math.min(64, Math.round(value)))
}

export function clampSwing(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(0.9, value))
}

export function emptyCell(): StepCell {
  return { on: false, velocity: 0.8, pan: 0, pitch: 0, fine: 0, gate: 0.8 }
}

/** Odd steps are delayed by `swing` times one step. Even steps stay on the grid. */
export function stepStart(index: number, stepBeats = STEP_BEAT, swing = 0): number {
  const step = Math.max(0, index)
  const delay = step % 2 === 1 ? clampSwing(swing) * stepBeats : 0
  return step * stepBeats + delay
}

/** Step sounding at `beat` inside a loop of `count` steps. */
export function stepIndexAt(beat: number, count: number, stepBeats = STEP_BEAT, swing = 0): number {
  const steps = clampStepCount(count)
  const width = stepBeats > 0 ? stepBeats : STEP_BEAT
  const loop = width * steps
  const local = ((beat % loop) + loop) % loop
  let index = Math.min(steps - 1, Math.floor(local / width + 1e-9))
  if (index % 2 === 1 && local + 1e-9 < stepStart(index, width, swing)) index = Math.max(0, index - 1)
  return index
}

/**
 * Step index on the sample clock. `beatSamples` is one quarter note.
 * The rack drum machine calls this instead of keeping its own counter.
 */
export function drumStepIndex(timeSamples: number, beatSamples: number, steps = 16, swing = 0): number {
  const beat = beatSamples > 0 ? timeSamples / beatSamples : 0
  return stepIndexAt(beat, steps, STEP_BEAT, swing)
}

export function channelSteps(channel: StepChannel, patternSteps: number): number {
  return clampStepCount(channel.steps || patternSteps)
}

export function channelSwing(channel: StepChannel, patternSwing: number): number {
  return clampSwing(channel.swing == null ? patternSwing : channel.swing)
}

export function hitsInRange(
  channel: StepChannel,
  patternSteps: number,
  patternSwing: number,
  fromBeat: number,
  toBeat: number,
): RenderedHit[] {
  if (!(toBeat > fromBeat)) return []
  const count = channelSteps(channel, patternSteps)
  const swing = channelSwing(channel, patternSwing)
  const loop = STEP_BEAT * count
  const hits: RenderedHit[] = []
  const first = Math.floor(fromBeat / loop) - 1
  const last = Math.floor((toBeat - 1e-9) / loop) + 1
  for (let cycle = first; cycle <= last; cycle++) {
    for (let step = 0; step < count; step++) {
      const cell = channel.cells[step]
      if (!cell?.on) continue
      const start = cycle * loop + stepStart(step, STEP_BEAT, swing) + (cell.nudge || 0)
      if (start < fromBeat - 1e-9 || start >= toBeat - 1e-9) continue
      const next = cycle * loop + (step + 1 < count ? stepStart(step + 1, STEP_BEAT, swing) : loop)
      const span = Math.max(0.02, next - start)
      const gate = Math.max(0.05, Math.min(1, cell.gate || 0.8))
      hits.push({
        channelId: channel.id,
        kind: channel.kind,
        output: channel.output,
        sampleId: channel.sampleId,
        volume: channel.volume,
        pitch: channel.note + (cell.pitch || 0),
        fine: cell.fine || 0,
        pan: Math.max(-1, Math.min(1, channel.pan + (cell.pan || 0))),
        startBeat: start,
        durationBeats: span * gate,
        velocity: Math.max(0.05, Math.min(1, (cell.velocity || 0.8) * channel.volume)),
      })
    }
  }
  return hits
}

export function renderPattern(pattern: BeatPattern, fromBeat: number, toBeat: number): RenderedHit[] {
  const solo = pattern.channels.some((channel) => channel.solo)
  const hits: RenderedHit[] = []
  for (const channel of pattern.channels) {
    if (channel.mute || (solo && !channel.solo)) continue
    hits.push(...hitsInRange(channel, pattern.steps, pattern.swing, fromBeat, toBeat))
  }
  hits.sort((a, b) => a.startBeat - b.startBeat)
  return hits
}

export function fillEvery(cells: StepCell[], every: number, count: number): StepCell[] {
  const step = Math.max(1, Math.round(every))
  return cells.map((cell, index) => (index < count && index % step === 0 ? { ...cell, on: true } : cell))
}

export function randomizeCells(cells: StepCell[], count: number, rng: () => number = Math.random): StepCell[] {
  return cells.map((cell, index) => {
    if (index >= count) return cell
    return { ...cell, on: rng() > 0.55, velocity: 0.45 + rng() * 0.5 }
  })
}

export function humanizeCells(cells: StepCell[], count: number, amount = 0.4, rng: () => number = Math.random): StepCell[] {
  const depth = Math.max(0, Math.min(1, amount))
  return cells.map((cell, index) => {
    if (index >= count || !cell.on) return cell
    const nudge = (rng() - 0.5) * 2 * depth
    return {
      ...cell,
      velocity: Math.max(0.05, Math.min(1, cell.velocity * (1 + nudge * 0.35))),
      fine: Math.max(-100, Math.min(100, cell.fine + nudge * 12)),
      gate: Math.max(0.05, Math.min(1, cell.gate + nudge * 0.08)),
    }
  })
}

export function shiftCells(cells: StepCell[], count: number, direction: number): StepCell[] {
  const next = cells.map((cell) => ({ ...cell }))
  const width = Math.max(1, Math.min(count, cells.length))
  const head = next.slice(0, width)
  const moved = direction < 0 ? [...head.slice(1), head[0]] : [head[head.length - 1], ...head.slice(0, -1)]
  for (let index = 0; index < width; index++) next[index] = moved[index]
  return next
}

const KIT: { name: string; kind: DrumKind; note: number; color: string; on: number[] }[] = [
  { name: 'Kick', kind: 'kick', note: 36, color: '#ef6b6b', on: [0, 4, 8, 12] },
  { name: 'Snare', kind: 'snare', note: 38, color: '#e0b15a', on: [4, 12] },
  { name: 'Clap', kind: 'clap', note: 39, color: '#f09a6a', on: [4, 12] },
  { name: 'Hat', kind: 'hat', note: 42, color: '#79b8d4', on: [0, 2, 4, 6, 8, 10, 12, 14] },
  { name: 'Perc', kind: 'perc', note: 56, color: '#c58be0', on: [6, 14] },
]

function makeChannel(spec: (typeof KIT)[number], steps: number): StepChannel {
  const cells = Array.from({ length: 64 }, () => emptyCell())
  for (const step of spec.on) {
    if (step < steps) cells[step] = { ...emptyCell(), on: true, velocity: spec.kind === 'hat' ? 0.55 : 0.9 }
  }
  return {
    id: uid('row'),
    name: spec.name,
    kind: spec.kind,
    note: spec.note,
    color: spec.color,
    volume: 0.85,
    pan: spec.kind === 'hat' ? 0.15 : 0,
    mute: false,
    solo: false,
    output: null,
    sampleId: null,
    steps,
    swing: null,
    cells,
  }
}

export function starterPattern(): BeatPattern {
  const steps = 16
  return {
    id: uid('pat'),
    name: 'Pattern 1',
    color: '#73c48f',
    steps,
    swing: 0,
    channels: KIT.map((spec) => makeChannel(spec, steps)),
  }
}

export function clonePattern(pattern: BeatPattern, name: string): BeatPattern {
  return {
    ...pattern,
    id: uid('pat'),
    name,
    channels: pattern.channels.map((channel) => ({
      ...channel,
      id: uid('row'),
      cells: channel.cells.map((cell) => ({ ...cell })),
    })),
  }
}

export function normalizeBeats(beats: BeatRack | undefined, clips: PatternClip[] | undefined): { beats: BeatRack; patternClips: PatternClip[] } {
  if (!beats?.patterns?.length) {
    const pattern = starterPattern()
    return {
      beats: { activeId: pattern.id, patterns: [pattern] },
      patternClips: [{ id: uid('pcl'), patternId: pattern.id, startBeat: 0, lengthBeats: 4, scene: null }],
    }
  }
  for (const pattern of beats.patterns) {
    pattern.steps = clampStepCount(pattern.steps || 16)
    pattern.swing = clampSwing(pattern.swing || 0)
    for (const channel of pattern.channels) {
      channel.steps = clampStepCount(channel.steps || pattern.steps)
      channel.cells = Array.from({ length: 64 }, (_, index) => ({ ...emptyCell(), ...channel.cells?.[index] }))
      channel.swing = channel.swing == null ? null : clampSwing(channel.swing)
    }
  }
  if (!beats.patterns.some((pattern) => pattern.id === beats.activeId)) beats.activeId = beats.patterns[0].id
  return { beats, patternClips: clips ?? [] }
}

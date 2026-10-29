import type { MidiNote } from './types'
import {
  STEP_BEAT,
  channelSteps,
  channelSwing,
  emptyCell,
  stepStart,
  type BeatPattern,
  type StepCell,
  type StepChannel,
} from './steps'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** GM note name. Middle C (MIDI 60) is C4. */
export function midiName(pitch: number): string {
  const wrapped = ((Math.round(pitch) % 12) + 12) % 12
  const octave = Math.floor(Math.round(pitch) / 12) - 1
  return `${NAMES[wrapped]}${octave}`
}

export function laneLabel(channel: Pick<StepChannel, 'name' | 'note'>): string {
  return `${channel.name} · ${midiName(channel.note)}`
}

/**
 * One active step, on the same clock the song MIDI clip and the drum roll use.
 * `startBeat` includes swing and nudge. Raw cell fields round-trip back onto the grid.
 */
export interface LaneNote {
  channelId: string
  step: number
  /** GM pitch the lane sounds: the lane note plus the step's pitch offset. */
  pitch: number
  pitchOffset: number
  startBeat: number
  durationBeats: number
  /** Step velocity, unchanged. */
  velocity: number
  /** Velocity the instrument plays, matching the sequencer hit. */
  soundVelocity: number
  pan: number
  fine: number
  nudge: number
  gate: number
}

function cellOf(channel: StepChannel, step: number): StepCell | undefined {
  return channel.cells[step]
}

/** Sounding span of one step. Matches the hit the sequencer schedules. */
export function stepSpan(step: number, count: number, swing: number, nudge: number): { start: number; span: number } {
  const grid = stepStart(step, STEP_BEAT, swing)
  const start = grid + nudge
  const next = step + 1 < count ? stepStart(step + 1, STEP_BEAT, swing) : STEP_BEAT * count
  return { start, span: Math.max(0.02, next - start) }
}

/** Nearest step for a beat dragged in the roll. The remainder is the nudge. */
export function stepFromBeat(beat: number, count: number, swing: number): { step: number; nudge: number } {
  const steps = Math.max(1, count)
  let step = 0
  let best = Infinity
  for (let index = 0; index < steps; index++) {
    const dist = Math.abs(beat - stepStart(index, STEP_BEAT, swing))
    if (dist < best) {
      best = dist
      step = index
    }
  }
  return { step, nudge: beat - stepStart(step, STEP_BEAT, swing) }
}

export function gateForDuration(step: number, count: number, swing: number, nudge: number, duration: number): number {
  const { span } = stepSpan(step, count, swing, nudge)
  if (!(duration > 0)) return 0.8
  return Math.max(0.05, Math.min(1, duration / span))
}

/** Every active step, including odd lengths and swung off-beats. Muted lanes stay in the pattern. */
export function patternToLaneNotes(pattern: BeatPattern): LaneNote[] {
  const notes: LaneNote[] = []
  for (const channel of pattern.channels) {
    const count = channelSteps(channel, pattern.steps)
    const swing = channelSwing(channel, pattern.swing)
    for (let step = 0; step < count; step++) {
      const cell = cellOf(channel, step)
      if (!cell?.on) continue
      const nudge = cell.nudge || 0
      const gate = Math.max(0.05, Math.min(1, cell.gate || 0.8))
      const { start, span } = stepSpan(step, count, swing, nudge)
      const velocity = cell.velocity
      notes.push({
        channelId: channel.id,
        step,
        pitch: Math.max(0, Math.min(127, Math.round(channel.note + (cell.pitch || 0)))),
        pitchOffset: cell.pitch || 0,
        startBeat: start,
        durationBeats: span * gate,
        velocity,
        soundVelocity: Math.max(0.05, Math.min(1, velocity || 0.8)),
        pan: Math.max(-1, Math.min(1, cell.pan || 0)),
        fine: cell.fine || 0,
        nudge,
        gate,
      })
    }
  }
  notes.sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
  return notes
}

/** MIDI clip notes. Same pitches, times, and velocities as the roll. */
export function patternToMidiNotes(pattern: BeatPattern): Omit<MidiNote, 'id'>[] {
  return patternToLaneNotes(pattern).map((note) => ({
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: Math.max(0.02, note.durationBeats),
    velocity: note.soundVelocity,
    pan: note.pan,
    fine: note.fine || undefined,
  }))
}

/** Write roll notes back onto the step grid. Steps with no note turn off. */
export function applyLaneNotes(pattern: BeatPattern, notes: LaneNote[]): void {
  const grouped = new Map<string, LaneNote[]>()
  for (const note of notes) {
    const list = grouped.get(note.channelId) ?? []
    list.push(note)
    grouped.set(note.channelId, list)
  }
  for (const channel of pattern.channels) {
    const count = channelSteps(channel, pattern.steps)
    while (channel.cells.length < count) channel.cells.push(emptyCell())
    const byStep = new Map<number, LaneNote>()
    for (const note of grouped.get(channel.id) ?? []) {
      if (note.step >= 0 && note.step < count) byStep.set(note.step, note)
    }
    for (let step = 0; step < count; step++) {
      const prev = channel.cells[step] ? { ...channel.cells[step] } : emptyCell()
      const note = byStep.get(step)
      if (!note) {
        prev.on = false
        channel.cells[step] = prev
        continue
      }
      prev.on = true
      prev.velocity = note.velocity
      prev.pan = note.pan
      prev.pitch = note.pitchOffset
      prev.fine = note.fine
      prev.gate = note.gate
      prev.nudge = note.nudge || undefined
      channel.cells[step] = prev
    }
  }
}

/** Fold a song beat into the pattern so the roll playhead matches the step grid. */
export function patternPlayBeat(beat: number, steps: number): number {
  const length = Math.max(STEP_BEAT, steps * STEP_BEAT)
  return ((beat % length) + length) % length
}

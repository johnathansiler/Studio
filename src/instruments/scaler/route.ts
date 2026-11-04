import type { MidiNote, Project, Track } from '../../model/types'
import { applyKeysLock, renderPerformance } from './perform'
import {
  activeScaleId,
  needsScalerSound,
  normalizeScaler,
  routeScaler,
  scalerChords,
  trackHasScaler,
} from './model'
import type { RecordSource, ScalerNote, ScalerState } from './types'

export { needsScalerSound, trackHasScaler }

export interface RoutedNote {
  trackId: string
  pitch: number
  fine?: number
  velocity: number
}

export interface LivePlan {
  /** True when Scaler rewrote this key. */
  shaped: boolean
  output: ScalerState['output']
  play: RoutedNote[]
  record: number[]
}

export interface StepSound {
  trackId: string
  pitch: number
  fine?: number
  velocity: number
  durationBeats: number
  hear: ScalerState['output']
}

/** Which pitches a take should store. Output is what Scaler generated. Input is the key that was played. */
export function recordedPitches(mode: RecordSource, input: number, output: number[]): number[] {
  if (mode === 'input') return [clamp(Math.round(input), 0, 127)]
  const notes = output.length ? output : [input]
  return notes.map((pitch) => clamp(Math.round(pitch), 0, 127))
}

/**
 * One incoming MIDI note through Scaler, then to this track's sound and any MIDI-to tracks.
 * Returns null when Scaler is not on the track.
 */
export function planLive(project: Project, trackId: string, midi: number, velocity = 0.8, pass = 0, span = 2): LivePlan | null {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track || !trackHasScaler(track)) return null
  const state = normalizeScaler(track.scaler)
  const produced = produce(state, midi, span, pass)
  if (produced.hidden) return { shaped: true, output: state.output, play: [], record: [] }
  const notes = state.thru ? withThru(produced.notes, midi, velocity) : produced.notes
  const targets = playTargets(project, track)
  const level = clamp(velocity, 0.05, 1)
  const play = targets.flatMap((id) => notes.map((note) => ({
    trackId: id,
    pitch: note.pitch,
    fine: note.fine,
    velocity: clamp(note.velocity * level / 0.8, 0.05, 1),
  })))
  return {
    shaped: true,
    output: state.output,
    play,
    record: recordedPitches(state.recordSource, midi, notes.map((note) => note.pitch)),
  }
}

/**
 * Clips store either the keys (record input) or the notes Scaler already made (record output).
 * Input is shaped on the way to the instrument. Output is left as written.
 */
export function notesAfterScaler(project: Project, track: Track, notes: MidiNote[], pass = 0): MidiNote[] {
  if (!trackHasScaler(track) || !notes.length) return notes
  const state = normalizeScaler(track.scaler)
  if (state.recordSource === 'output') return notes
  return shapeScalerNotes(project, track, notes, pass)
}

/** Step hits are triggers. Null when this track has no Scaler. */
export function stepNotes(project: Project, track: Track, pitch: number, velocity: number, durationBeats: number, pass = 0): StepSound[] | null {
  const plan = planLive(project, track.id, pitch, velocity, pass, Math.max(0.05, durationBeats))
  if (!plan) return null
  const duration = Math.max(0.05, durationBeats)
  return plan.play.map((note) => ({
    trackId: note.trackId,
    pitch: note.pitch,
    fine: note.fine,
    velocity: note.velocity,
    durationBeats: duration,
    hear: plan.output,
  }))
}

/** MIDI clips and the step sequencer. Each incoming note becomes Scaler's performance or chord. */
export function shapeScalerNotes(_project: Project, track: Track, notes: MidiNote[], pass = 0): MidiNote[] {
  if (!trackHasScaler(track) || !notes.length) return notes
  const state = normalizeScaler(track.scaler)
  const out: MidiNote[] = []
  notes.forEach((note) => {
    const bar = state.evolve === 'bar' ? Math.floor(note.startBeat / 4) : pass
    const produced = produce(state, note.pitch, Math.max(0.25, note.durationBeats), bar)
    if (produced.hidden) return
    const heard = produced.notes
    const list = state.thru ? withThru(heard, note.pitch, note.velocity) : heard
    const source = list.length ? list : [{ pitch: note.pitch, startBeat: 0, durationBeats: note.durationBeats, velocity: note.velocity }]
    source.forEach((item, itemIndex) => {
      out.push({
        ...note,
        id: itemIndex === 0 ? note.id : `${note.id}:s${itemIndex}`,
        pitch: item.pitch,
        fine: item.fine,
        startBeat: note.startBeat + item.startBeat,
        durationBeats: Math.min(item.durationBeats, Math.max(0.05, note.durationBeats - item.startBeat)),
        velocity: clamp(item.velocity * (note.velocity || 0.8), 0.05, 1),
      })
    })
  })
  return out
}

/** Tracks that should hear Scaler, in order. Forward replaces this track. MIDI to adds layers. */
export function playTargets(project: Project, track: Track): string[] {
  const state = normalizeScaler(track.scaler)
  const ids: string[] = []
  const primary = routeScaler(project, track).liveStripId
  ids.push(primary)
  for (const id of state.midiTo) {
    if (id === track.id || ids.includes(id)) continue
    const dest = project.tracks.find((item) => item.id === id && item.type === 'midi')
    if (dest) ids.push(dest.id)
  }
  return ids
}

function produce(state: ScalerState, midi: number, span: number, pass: number): { notes: ScalerNote[]; hidden: boolean } {
  const locked = lockedChord(state, midi)
  if (locked.hidden) return { notes: [], hidden: true }
  if (!locked.notes.length) return { notes: [], hidden: false }
  if (state.performanceId) {
    const rendered = renderPerformance(locked.notes, state.performanceId, Math.max(0.25, span), state.rate, state.swing, {
      seed: state.variationSeed || 1,
      amount: state.variation,
      root: state.root,
      scaleId: activeScaleId(state),
      pass: state.evolve === 'off' ? 0 : pass,
      evolve: state.evolve,
    })
    if (rendered.length) return { notes: rendered, hidden: false }
  }
  return {
    notes: locked.notes.map((tone) => ({
      pitch: tone.midi,
      fine: tone.cents ? Math.round(tone.cents) : undefined,
      startBeat: 0,
      durationBeats: Math.max(0.25, span),
      velocity: 0.84,
    })),
    hidden: false,
  }
}

function lockedChord(state: ScalerState, midi: number): { notes: { midi: number; cents: number }[]; hidden: boolean } {
  const chords = scalerChords(state)
  const current = chords[Math.min(state.chordIndex, Math.max(0, chords.length - 1))]
  const currentTones = (current?.tones ?? []).map((tone) => ({ midi: tone.midi, cents: tone.cents }))
  const locked = applyKeysLock({
    mode: state.keysLock,
    midi,
    root: state.root,
    scale: state.scale,
    library: state.library,
    chordPcs: currentTones.map((tone) => mod12(tone.midi)),
    chords: chords.map((chord) => chord.tones.map((tone) => ({ midi: tone.midi, cents: tone.cents }))),
    current: currentTones,
  })
  if (locked.hidden || !locked.notes?.length) return { notes: [], hidden: locked.hidden || !locked.notes }
  return { notes: locked.notes, hidden: false }
}

function withThru(notes: ScalerNote[], midi: number, velocity: number): ScalerNote[] {
  const pitch = clamp(Math.round(midi), 0, 127)
  if (notes.some((note) => note.pitch === pitch)) return notes
  return [...notes, { pitch, startBeat: 0, durationBeats: notes[0]?.durationBeats ?? 1, velocity: clamp(velocity, 0.05, 1) }]
}

function mod12(midi: number) {
  return ((midi % 12) + 12) % 12
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

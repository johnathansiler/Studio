import type { Project } from '../../model/types'
import { normalizeScaler, scalerChords } from './model'
import { planLive } from './route'
import type { KeysLock, ScalerOutput } from './types'
import { applyKeysLock, type LockedNote } from './perform'

export interface LiveSink {
  /** `shaped` is the sound under Scaler. The engine must not run Scaler again. */
  playThrough(trackId: string, pitch: number, velocity: number, fine?: number, shaped?: boolean): void
  pulseMidi?(notes: { pitch: number; velocity: number; duration: number }[]): void
}

/** Null when this track is not Scaler. An empty list is a hidden key. */
export function scalerLiveNotes(project: Project, trackId: string, midi: number): { notes: LockedNote[]; output: ScalerOutput } | null {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track || track.instrument !== 'scaler') return null
  const state = normalizeScaler(track.scaler)
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
  return { notes: locked.notes ?? [], output: state.output }
}

export function playScalerLive(project: Project, sink: LiveSink, trackId: string, midi: number, velocity: number): LockedNote[] | null {
  const plan = planLive(project, trackId, midi, velocity)
  if (!plan) return null
  if (plan.output !== 'midi') {
    for (const note of plan.play) sink.playThrough(note.trackId, note.pitch, note.velocity, note.fine, true)
  }
  if (plan.output !== 'audio' && plan.play.length && sink.pulseMidi) {
    sink.pulseMidi(plan.play.map((note) => ({ pitch: note.pitch, velocity: note.velocity, duration: 0.6 })))
  }
  return plan.record.map((pitch) => ({ midi: pitch, cents: 0 }))
}

export function hiddenPitchClass(mode: KeysLock, midi: number, scalePcs: Set<number>, chordPcs: Set<number>) {
  const pc = mod12(midi)
  if (mode === 'scale-hide') return !scalePcs.has(pc)
  if (mode === 'chord-notes') return chordPcs.size > 0 && !chordPcs.has(pc)
  if (mode === 'chord') return ![0, 2, 4, 5, 7, 9, 11].includes(pc)
  return false
}

function mod12(midi: number) {
  return ((midi % 12) + 12) % 12
}

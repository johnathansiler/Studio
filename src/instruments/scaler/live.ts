import type { Project } from '../../model/types'
import { planLive } from './route'
import type { LockedNote } from './perform'
import type { NoteSurface } from '../../harbor/surfaces'

export interface LiveSink {
  /** `shaped` is the sound under Scaler. The engine must not run Scaler again. */
  playThrough(trackId: string, pitch: number, velocity: number, fine?: number, shaped?: boolean, surface?: NoteSurface): void
  pulseMidi?(notes: { pitch: number; velocity: number; duration: number }[]): void
}

/** Null when this track is not Scaler. An empty list is a hidden key. */

export function playScalerLive(project: Project, sink: LiveSink, trackId: string, midi: number, velocity: number): LockedNote[] | null {
  const plan = planLive(project, trackId, midi, velocity)
  if (!plan) return null
  if (plan.output !== 'midi') {
    for (const note of plan.play) sink.playThrough(note.trackId, note.pitch, note.velocity, note.fine, true, 'scaler')
  }
  if (plan.output !== 'audio' && plan.play.length && sink.pulseMidi) {
    sink.pulseMidi(plan.play.map((note) => ({ pitch: note.pitch, velocity: note.velocity, duration: 0.6 })))
  }
  return plan.record.map((pitch) => ({ midi: pitch, cents: 0 }))
}

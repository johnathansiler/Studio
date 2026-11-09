/** Every note surface speaks through this one voice. */

export const NOTE_SURFACES = ['keyboard', 'mini', 'pads', 'roll', 'clip', 'arrange', 'record', 'scaler', 'midi'] as const

export type NoteSurface = (typeof NOTE_SURFACES)[number]

export interface SurfaceNote {
  surface: NoteSurface
  trackId: string
  pitch: number
  velocity: number
  down: boolean
  when?: number
}

type Voice = {
  voiceNote(surface: NoteSurface, trackId: string, pitch: number, velocity: number, when?: number): boolean
}

const listeners = new Set<(note: SurfaceNote) => void>()

export function subscribeInstrumentVoice(listener: (note: SurfaceNote) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishInstrumentVoice(note: SurfaceNote) {
  for (const listener of listeners) listener(note)
}

/** The call every keyboard, pad, roll, clip, arrange, record, Scaler, and MIDI input uses. */
export function playInstrument(engine: Voice, surface: NoteSurface, trackId: string, pitch: number, velocity: number, when?: number) {
  return engine.voiceNote(surface, trackId, pitch, velocity, when)
}

export function releaseInstrument(engine: Voice, surface: NoteSurface, trackId: string, pitch: number, when?: number) {
  return engine.voiceNote(surface, trackId, pitch, 0, when)
}
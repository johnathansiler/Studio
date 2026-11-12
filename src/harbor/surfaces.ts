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

const listeners = new Set<(note: SurfaceNote) => void>()

export function subscribeInstrumentVoice(listener: (note: SurfaceNote) => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishInstrumentVoice(note: SurfaceNote) {
  for (const listener of listeners) listener(note)
}

/** The call every keyboard, pad, roll, clip, arrange, record, Scaler, and MIDI input uses. */


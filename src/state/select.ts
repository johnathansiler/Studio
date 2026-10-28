import {
  defaultLiveCapture,
  defaultMidiOut,
  planAudioRoutes,
  planMidiRoutes,
  sanitizeFx,
  sanitizeMaps,
  type AudioRoute,
  type MidiRoute,
} from '../model/midiTools'
import type { LiveCaptureSettings, MidiFx, MidiMapEntry, MidiOutSettings, Project, Track } from '../model/types'

/** Read project MIDI state. Writes go through ProjectStore so the undo journal and every screen stay in step. */

export function selectMidiMaps(project: Project): MidiMapEntry[] {
  return project.midiMaps ?? []
}

export function selectMidiOut(project: Project): MidiOutSettings {
  return { ...defaultMidiOut(), ...(project.midiOut || {}) }
}

export function selectLiveCapture(project: Project): LiveCaptureSettings {
  return { ...defaultLiveCapture(), ...(project.liveCapture || {}) }
}

export function selectTrackFx(track: Track | null | undefined): MidiFx[] {
  return sanitizeFx(track?.midiFx)
}

export function selectAudioRoutes(project: Project): AudioRoute[] {
  return planAudioRoutes(project.tracks)
}

export function selectMidiRoutes(project: Project): MidiRoute[] {
  return planMidiRoutes(project.tracks)
}

export function selectSavedMaps(project: Project): MidiMapEntry[] {
  return sanitizeMaps(project.midiMaps)
}

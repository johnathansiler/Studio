import type { ScalerState } from '../instruments/scaler/types'
import type { SectionKind } from '../model/types'
import type { RoleId } from './brief'

export interface DraftNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
  fine?: number
  slide?: boolean
}

export interface DraftClip {
  name: string
  startBeat: number
  durationBeats: number
  notes: DraftNote[]
}

export interface DraftTrack {
  role: RoleId
  name: string
  color: string
  instrument: 'pads' | 'synth' | 'scaler' | '808'
  pluginId: 'pads' | 'synth' | 'scaler'
  mix?: 'compressor' | 'eq' | 'reverb' | 'delay'
  volume: number
  pan: number
  seed: number
  scaler?: Partial<ScalerState>
  clips: DraftClip[]
}

export interface DraftSection {
  kind: SectionKind
  name: string
  startBeat: number
  durationBeats: number
}

export interface SongDraft {
  summary: string
  seed: number
  tempo?: number
  key?: number
  scaleId?: string
  sections: DraftSection[]
  sectionMode: 'add' | 'replace' | 'none'
  tracks: DraftTrack[]
  /** Unstuck clips of these roles inside the span are replaced. Other clips stay. */
  replace?: { startBeat: number; endBeat: number; roles: RoleId[] }
}

export interface ClipPicture {
  trackId: string
  clipId: string
  name: string
  role: RoleId | 'other'
  startBeat: number
  durationBeats: number
  bars: number
  /** Beats from the clip start. */
  notes: DraftNote[]
  /** Average MIDI pitch. */
  register: number
  /** Notes per beat. */
  density: number
  /** Pitch class that shows up most, or the project key. */
  key: number
}

export interface PlanSection {
  kind: SectionKind
  name: string
  startBeat: number
  bars: number
  energy: number
}

export type UnstuckJob =
  | { action: 'part'; role: RoleId }
  | { action: 'fill' }
  | { action: 'transition' }
  | { action: 'next-section' }
  | { action: 'continue'; bars: 4 | 8 | 'section' }
  | { action: 'vary' }
  | { action: 'complement' }
  | { action: 'full' }
  | { action: 'rewrite'; roles: RoleId[]; kind: SectionKind; name: string; bars: number; startBeat: number }

export interface ComposeContext {
  barBeats: number
  startBeat: number
  replace: boolean
  /** Absolute end of the previous write, so a shorter shuffle still clears it. */
  previousEnd?: number
  /** Section the playhead or clip is leaving. Used by Next section and Continue section. */
  afterKind?: SectionKind
  /** Existing arrangement sections, when a new part should follow them. */
  sections?: PlanSection[]
  clip?: ClipPicture
}

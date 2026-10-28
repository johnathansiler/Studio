import type { MidiClip, Project, Track } from '../../model/types'
import { normalizeScale, patternNotes, scaleById, type ScaleId } from '../../model/scale'
import {
  chordsInScale,
  getScale,
  harmonize,
  isBuiltinScale,
  nearestBuiltin,
  progressionsFor,
  realizeProgression,
  spellScale,
  toneFromCents,
  voiceTones,
  withBass,
  type ChordGroup,
  type Tone,
} from '../../theory'
import { defaultScaler, type ScalerGroup, type ScalerNote, type ScalerSound, type ScalerState } from './types'

export type { ScalerGroup, ScalerNote, ScalerSound, ScalerState } from './types'
export { defaultScaler } from './types'

const GROUPS: ScalerGroup[] = ['triad', 'seventh', 'ninth', 'sus', 'add', 'altered']
const SOUNDS = ['synth', 'sampler', '808', 'drum-machine', 'library', 'forward'] as const
const ARP = ['off', 'up', 'down', 'upDown', 'random'] as const
const RHYTHM = ['block', 'quarter', 'eighth', 'sync', 'strum'] as const

export const SCALER_MIME = 'application/x-cueharbor-scaler'

export function freshScaler(project: Pick<Project, 'scale'>): ScalerState {
  const scale = normalizeScale(project.scale)
  return normalizeScaler({
    ...defaultScaler(),
    root: scale.root,
    scale: scale.scale,
    library: scale.library,
    snap: scale.snap,
    voicing: scale.voicing,
    inversion: scale.inversion,
    voiceLead: scale.voiceLead,
    arp: scale.arp,
    rate: scale.rate,
    gate: scale.gate,
    octaves: scale.octaves,
    rhythm: scale.rhythm,
  })
}

export function normalizeScaler(value: Partial<ScalerState> | undefined | null): ScalerState {
  const base = defaultScaler()
  if (!value) return base
  const scale = scaleById(value.scale).id
  const group = GROUPS.includes(value.group as ScalerGroup) ? (value.group as ScalerGroup) : base.group
  const sound = SOUNDS.includes(value.sound as (typeof SOUNDS)[number]) ? value.sound! : base.sound
  return {
    ...base,
    ...value,
    root: ((value.root ?? base.root) % 12 + 12) % 12,
    scale,
    library: typeof value.library === 'string' ? value.library : '',
    snap: value.snap ?? base.snap,
    group,
    voicing: value.voicing ?? base.voicing,
    inversion: Math.max(0, Math.round(value.inversion ?? 0)),
    voiceLead: value.voiceLead ?? base.voiceLead,
    bassDegree: value.bassDegree == null || !Number.isFinite(value.bassDegree) ? null : Math.max(0, Math.round(value.bassDegree)),
    arp: ARP.includes(value.arp as (typeof ARP)[number]) ? value.arp! : base.arp,
    rate: clamp(value.rate ?? base.rate, 0.125, 2),
    gate: clamp(value.gate ?? base.gate, 0.05, 1),
    octaves: clamp(Math.round(value.octaves ?? 1), 1, 3),
    rhythm: RHYTHM.includes(value.rhythm as (typeof RHYTHM)[number]) ? value.rhythm! : base.rhythm,
    sound: sound as ScalerState['sound'],
    forwardTrackId: typeof value.forwardTrackId === 'string' ? value.forwardTrackId : '',
    lastVoicing: Array.isArray(value.lastVoicing) ? value.lastVoicing.filter((n) => Number.isFinite(n)) : [],
    lastCents: Array.isArray(value.lastCents) ? value.lastCents.filter((n): n is number => Number.isFinite(n)) : [],
  }
}

export function normalizeTrackScaler(track: Track) {
  if (track.instrument === 'scaler' || track.scaler) track.scaler = normalizeScaler(track.scaler)
}

export function activeScaleId(state: ScalerState) {
  return state.library || state.scale
}

export function scalerChords(state: ScalerState) {
  const id = activeScaleId(state)
  if (state.group === 'triad' || state.group === 'seventh' || state.group === 'ninth') {
    const size = state.group === 'triad' ? 3 : state.group === 'seventh' ? 4 : 5
    return harmonize(state.root, id, size).map((chord) => ({ symbol: chord.symbol, roman: chord.roman, tones: chord.tones }))
  }
  const group = state.group as ChordGroup
  return chordsInScale(state.root, id, [group]).slice(0, 16).map((chord) => ({ symbol: chord.symbol, roman: chord.roman, tones: chord.tones }))
}

export function voiceScaler(state: ScalerState, tones: Tone[]): Tone[] {
  const previous = state.lastVoicing.map((midi, index) => ({ midi, cents: state.lastCents[index] ?? 0 }))
  let base = tones
  if (state.bassDegree != null) {
    const degrees = spellScale(state.root, activeScaleId(state), 3)
    const bass = degrees[state.bassDegree]
    if (bass) base = placeBass(tones, bass)
  }
  return voiceTones(base, {
    inversion: state.inversion,
    voicing: state.voicing,
    voiceLead: state.voiceLead && previous.length > 0,
    previous,
  })
}

export function notesFromTones(state: ScalerState, tones: Tone[], spanBeats: number): { notes: ScalerNote[]; voiced: Tone[] } {
  const voiced = voiceScaler(state, tones)
  const played = patternNotes(voiced.map((tone) => tone.midi), {
    arp: state.arp,
    rate: state.rate,
    gate: state.gate,
    octaves: state.octaves,
    rhythm: state.rhythm,
    timing: 0,
    velocity: 0,
    spanBeats: Math.max(0.25, spanBeats),
    rng: () => 0.5,
  })
  const notes = played.map((note) => {
    const tone = voiced.find((item) => item.midi === note.pitch)
      ?? voiced.find((item) => ((item.midi % 12) + 12) % 12 === ((note.pitch % 12) + 12) % 12)
    const fine = tone && tone.cents ? Math.round(tone.cents) : undefined
    return {
      pitch: note.pitch,
      fine,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
    }
  })
  return { notes, voiced }
}

export function padPerformance(state: ScalerState, index: number, spanBeats: number) {
  const chords = scalerChords(state)
  const chord = chords[index]
  if (!chord) return null
  const played = notesFromTones(state, chord.tones, spanBeats)
  return { ...played, symbol: chord.symbol, roman: chord.roman }
}

export function progressionPerformance(state: ScalerState, progressionId: string, barBeats: number) {
  const id = activeScaleId(state)
  const pattern = progressionsFor(id).find((item) => item.id === progressionId) ?? progressionsFor(id)[0]
  if (!pattern) return null
  const size = state.group === 'seventh' || state.group === 'ninth' ? 4 : 3
  const chords = realizeProgression(state.root, id, pattern, Math.max(1, barBeats), size as 3 | 4)
  let current = state
  const notes: ScalerNote[] = []
  let beat = 0
  let voiced: Tone[] = []
  for (const chord of chords) {
    const played = notesFromTones(current, chord.tones, chord.beats)
    voiced = played.voiced
    for (const note of played.notes) notes.push({ ...note, startBeat: beat + note.startBeat })
    beat += chord.beats
    current = {
      ...current,
      lastVoicing: voiced.map((tone) => tone.midi),
      lastCents: voiced.map((tone) => tone.cents),
    }
  }
  return { notes, voiced, name: pattern.name, symbols: chords.map((chord) => chord.symbol) }
}

export function applyDetected(state: ScalerState, found: { root: number; scale: ScaleId; library: string }): ScalerState {
  return normalizeScaler({ ...state, root: found.root, scale: found.scale, library: found.library, snap: true, lastVoicing: [], lastCents: [] })
}

export function chooseScale(id: string): { scale: ScaleId; library: string } {
  if (isBuiltinScale(id)) return { scale: id, library: '' }
  return { scale: nearestBuiltin(getScale(id).cents), library: id }
}

/** Where a Scaler track's notes should sound. One hop only, so two forwards cannot loop. */
export function routeScaler(project: Project, track: Track): { voice: Track; liveStripId: string } {
  if (track.instrument !== 'scaler') return { voice: track, liveStripId: track.id }
  const state = normalizeScaler(track.scaler)
  if (state.sound === 'forward') {
    const dest = project.tracks.find((item) => item.id === state.forwardTrackId && item.id !== track.id && item.type === 'midi')
    if (dest) return { voice: localVoice(dest), liveStripId: dest.id }
    return { voice: soundVoice(track, 'synth'), liveStripId: track.id }
  }
  return { voice: soundVoice(track, state.sound), liveStripId: track.id }
}

export interface HeardMidi {
  voice: Track
  owner: Track
  clips: MidiClip[]
}

/** Clips that should sound on this track, after Scaler forward is applied once. */
export function performancesOn(project: Project, track: Track): HeardMidi[] {
  const out: HeardMidi[] = []
  if (!forwardsAway(project, track)) out.push({ voice: localVoice(track), owner: track, clips: track.midiClips })
  for (const other of project.tracks) {
    if (other.id === track.id || other.instrument !== 'scaler') continue
    const state = normalizeScaler(other.scaler)
    if (state.sound === 'forward' && state.forwardTrackId === track.id) out.push({ voice: localVoice(track), owner: other, clips: other.midiClips })
  }
  return out
}

function forwardsAway(project: Project, track: Track) {
  if (track.instrument !== 'scaler') return false
  const state = normalizeScaler(track.scaler)
  if (state.sound !== 'forward') return false
  return project.tracks.some((item) => item.id === state.forwardTrackId && item.id !== track.id && item.type === 'midi')
}

function localVoice(track: Track): Track {
  if (track.instrument !== 'scaler') return track
  const state = normalizeScaler(track.scaler)
  if (state.sound === 'forward') return soundVoice(track, 'synth')
  return soundVoice(track, state.sound)
}

function soundVoice(track: Track, sound: ScalerSound): Track {
  if (sound === 'library') return track.library ? { ...track, instrument: 'library' } : { ...track, instrument: 'synth' }
  if (sound === 'synth' || sound === 'sampler' || sound === '808' || sound === 'drum-machine') return { ...track, instrument: sound }
  return { ...track, instrument: 'synth' }
}

export function wantsLibrary(track: { instrument?: string; scaler?: ScalerState }): boolean {
  if (track.instrument === 'library') return true
  if (track.instrument !== 'scaler') return false
  return normalizeScaler(track.scaler).sound === 'library'
}

export interface ScalerDrag {
  trackId: string
  name: string
  notes: ScalerNote[]
}

export function encodeScalerDrag(payload: ScalerDrag) {
  return JSON.stringify(payload)
}

export function parseScalerDrag(raw: string): ScalerDrag | null {
  try {
    const parsed = JSON.parse(raw) as ScalerDrag
    if (!parsed || typeof parsed.trackId !== 'string' || typeof parsed.name !== 'string' || !Array.isArray(parsed.notes)) return null
    const notes = parsed.notes.filter((note) => Number.isFinite(note.pitch) && Number.isFinite(note.startBeat) && Number.isFinite(note.durationBeats))
    if (!notes.length) return null
    return { trackId: parsed.trackId, name: parsed.name, notes }
  } catch {
    return null
  }
}

function placeBass(tones: Tone[], bass: Tone): Tone[] {
  const voiced = withBass(tones, ((bass.midi % 12) + 12) % 12)
  if (!bass.cents) return voiced
  const lowest = Math.min(...voiced.map((tone) => tone.midi * 100 + tone.cents))
  let abs = bass.midi * 100 + bass.cents
  while (abs > lowest) abs -= 1200
  const placed = toneFromCents(abs)
  if (placed.midi < 0 || placed.midi > 127) return voiced
  return [placed, ...voiced.filter((tone) => tone.midi !== placed.midi || tone.cents !== placed.cents)]
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

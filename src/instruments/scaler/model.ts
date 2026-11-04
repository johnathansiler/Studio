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
import { applyVoiceGroup, renderPerformance } from './perform'
import { defaultScaler, type EvolveMode, type KeysLock, type RecordSource, type ScalerGroup, type ScalerInput, type ScalerNote, type ScalerOutput, type ScalerSound, type ScalerState, type VariationAmount, type VoiceGroup } from './types'

export type { ScalerGroup, ScalerNote, ScalerSound, ScalerState } from './types'
export { defaultScaler } from './types'

const GROUPS: ScalerGroup[] = ['triad', 'seventh', 'ninth', 'sus', 'add', 'altered']
const SOUNDS = ['synth', 'sampler', '808', 'drum-machine', 'library', 'forward'] as const
const ARP = ['off', 'up', 'down', 'upDown', 'random'] as const
const RHYTHM = ['block', 'quarter', 'eighth', 'sync', 'strum'] as const
const LOCKS: KeysLock[] = ['off', 'scale-snap', 'scale-hide', 'chord', 'chord-notes', 'one-finger']
const GROUPS_VOICE: VoiceGroup[] = ['all', 'bass', 'upper', 'dynamic']
const OUTPUTS: ScalerOutput[] = ['audio', 'midi', 'both']
const INPUTS: ScalerInput[] = ['midi', 'audio']
const AMOUNTS: VariationAmount[] = ['subtle', 'medium', 'major']
const EVOLVE: EvolveMode[] = ['off', 'bar', 'loop']
const RECORDS: RecordSource[] = ['input', 'output']

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
    keysLock: LOCKS.includes(value.keysLock as KeysLock) ? value.keysLock! : base.keysLock,
    performanceId: typeof value.performanceId === 'string' ? value.performanceId.slice(0, 80) : '',
    swing: clamp(value.swing ?? 0, 0, 0.7),
    voiceGroup: GROUPS_VOICE.includes(value.voiceGroup as VoiceGroup) ? value.voiceGroup! : base.voiceGroup,
    output: OUTPUTS.includes(value.output as ScalerOutput) ? value.output! : base.output,
    input: INPUTS.includes(value.input as ScalerInput) ? value.input! : base.input,
    chordIndex: clamp(Math.round(value.chordIndex ?? 0), 0, 32),
    variation: AMOUNTS.includes(value.variation as VariationAmount) ? value.variation! : base.variation,
    variationSeed: clamp(Math.round(value.variationSeed ?? base.variationSeed), 1, 0x7fffffff),
    variationLock: value.variationLock === true,
    variationTakes: takeSeeds(value.variationTakes),
    variationTake: clamp(Math.round(value.variationTake ?? 0), 0, 7),
    evolve: EVOLVE.includes(value.evolve as EvolveMode) ? value.evolve! : base.evolve,
    favorites: idList(value.favorites, 64),
    thru: value.thru === true,
    recordSource: RECORDS.includes(value.recordSource as RecordSource) ? value.recordSource! : base.recordSource,
    midiTo: idList(value.midiTo, 8),
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
  const voiced = voiceTones(base, {
    inversion: state.inversion,
    voicing: state.voicing,
    voiceLead: (state.voiceLead || state.voiceGroup === 'dynamic') && previous.length > 0,
    previous,
  })
  return applyVoiceGroup(voiced, state.voiceGroup)
}

export function notesFromTones(state: ScalerState, tones: Tone[], spanBeats: number, pass = 0): { notes: ScalerNote[]; voiced: Tone[] } {
  const voiced = voiceScaler(state, tones)
  if (state.performanceId) {
    const performed = renderPerformance(voiced, state.performanceId, Math.max(0.25, spanBeats), state.rate, state.swing, {
      seed: state.variationSeed || 1,
      amount: state.variation,
      root: state.root,
      scaleId: activeScaleId(state),
      pass: state.evolve === 'off' ? 0 : pass,
      evolve: state.evolve,
    })
    if (performed.length) return { notes: performed, voiced }
  }
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

export function padPerformance(state: ScalerState, index: number, spanBeats: number, pass = 0) {
  const chords = scalerChords(state)
  const chord = chords[index]
  if (!chord) return null
  const played = notesFromTones(state, chord.tones, spanBeats, pass)
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
  chords.forEach((chord, index) => {
    const played = notesFromTones(current, chord.tones, chord.beats, state.evolve === 'bar' ? index : 0)
    voiced = played.voiced
    for (const note of played.notes) notes.push({ ...note, startBeat: beat + note.startBeat })
    beat += chord.beats
    current = {
      ...current,
      lastVoicing: voiced.map((tone) => tone.midi),
      lastCents: voiced.map((tone) => tone.cents),
    }
  })
  return { notes, voiced, name: pattern.name, symbols: chords.map((chord) => chord.symbol) }
}

export function applyDetected(state: ScalerState, found: { root: number; scale: ScaleId; library: string }): ScalerState {
  return normalizeScaler({ ...state, root: found.root, scale: found.scale, library: found.library, snap: true, lastVoicing: [], lastCents: [] })
}

export function chooseScale(id: string): { scale: ScaleId; library: string } {
  if (isBuiltinScale(id)) return { scale: id, library: '' }
  return { scale: nearestBuiltin(getScale(id).cents), library: id }
}

/** True when Scaler is the instrument or a MIDI effect in front of one. */
export function trackHasScaler(track: { instrument?: string; plugins?: { pluginId: string; enabled?: boolean }[]; scaler?: ScalerState }) {
  if (track.instrument === 'scaler') return true
  return (track.plugins ?? []).some((plugin) => plugin.pluginId === 'scaler' && plugin.enabled !== false)
}

/** Scaler is playing its built-in preview because the track has no synth, sampler, or beat machine yet. */
export function needsScalerSound(track: Track) {
  if (!trackHasScaler(track)) return false
  if (track.plugins?.some((plugin) => plugin.pluginId === 'synth' || plugin.pluginId === 'sampler' || plugin.pluginId === 'pads')) return false
  return track.instrument === 'scaler' || !track.instrument || track.instrument === 'none'
}

/** Where a Scaler track's notes should sound. One hop only, so two forwards cannot loop. */
export function routeScaler(project: Project, track: Track): { voice: Track; liveStripId: string } {
  if (!trackHasScaler(track)) return { voice: track, liveStripId: track.id }
  const state = normalizeScaler(track.scaler)
  if (state.sound === 'forward') {
    const dest = project.tracks.find((item) => item.id === state.forwardTrackId && item.id !== track.id && item.type === 'midi')
    if (dest) return { voice: localVoice(dest), liveStripId: dest.id }
    return { voice: soundVoice(track, 'synth'), liveStripId: track.id }
  }
  if (track.instrument !== 'scaler') return { voice: track, liveStripId: track.id }
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
    if (other.id === track.id || !trackHasScaler(other)) continue
    const state = normalizeScaler(other.scaler)
    const forwarded = state.sound === 'forward' && state.forwardTrackId === track.id
    const layered = state.midiTo.includes(track.id)
    if (forwarded || layered) out.push({ voice: localVoice(track), owner: other, clips: other.midiClips })
  }
  return out
}

function forwardsAway(project: Project, track: Track) {
  if (!trackHasScaler(track)) return false
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

function takeSeeds(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => Number.isFinite(item)).map((item) => clamp(Math.round(item), 1, 0x7fffffff)).slice(-8)
}

function idList(value: unknown, limit: number) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).map((item) => item.slice(0, 80)).slice(0, limit)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

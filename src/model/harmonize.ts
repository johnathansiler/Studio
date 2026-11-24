/**
 * Move every harmonic clip onto one key.
 * Drums, percussion, Beat Machine, and effects stay put.
 * The short way around the clock is used, and a tritone goes down (−6..+5).
 * A minor into C major shares the notes, so that pair does not move.
 */

import { fitToProject, parseMusicalKey, type MusicalKey } from './keyFit'
import { NOTE_NAMES, detectKey as detectMidiKey, normalizeScale } from './scale'
import type { AudioClip, MidiClip, MidiNote, Project } from './types'

export interface HarmonizeInput {
  trackId: string
  clipId: string
  name: string
  kind: 'audio' | 'midi' | 'pattern'
  trackName: string
  trackKind?: string
  instrument?: string
  pluginIds?: string[]
  /** Sampler flagged as a drum kit. */
  drumMachine?: boolean
  soundType?: string
  soundCategory?: string
  soundRole?: string
  soundTags?: string[]
  soundKey?: string
  loopKey?: string
  hearingKey?: string
  /** False means Detect already stored "No clear key". Missing means Detect has not run. */
  hearingClear?: boolean | null
  /** Semitones already on the audio file. MIDI notes are already the sounding pitches. */
  existingSemitones?: number
  notes?: { pitch: number; durationBeats?: number }[]
}

export interface ScopedClip {
  trackId: string
  clipId: string
  name: string
  kind: 'audio' | 'midi' | 'pattern'
  disposition: 'skip' | 'vocal' | 'harmonic'
  reason: string
  /** File key for audio. Sounding key for MIDI. */
  key: MusicalKey | null
  needsDetect: boolean
  existingSemitones: number
}

export interface HarmonizeRow {
  trackId: string
  clipId: string
  name: string
  kind: 'audio' | 'midi' | 'pattern'
  action: 'shift' | 'skip'
  reason: string
  from?: string
  to?: string
  semitones?: number
  tonicOnly?: boolean
  vocal?: boolean
}

export interface HarmonizeMove {
  trackId: string
  clipId: string
  kind: 'audio' | 'midi'
  /** Semitones to add to the current pitch. */
  semitones: number
  from: string
  to: string
  tonicOnly: boolean
}

const DRUM_CATEGORIES = new Set([
  'kick', 'drums', 'drum', 'percussion', 'perc', 'snare', 'hat', 'hat-closed', 'hat-open', 'hi-hat', 'hihat',
  'clap', 'tom', 'cymbal', 'crash', 'ride', 'rim', 'rimshot', 'shaker', 'cowbell', 'tambourine',
])

const MINOR_SCALES = new Set([
  'aeolian', 'dorian', 'phrygian', 'locrian', 'harmonicMinor', 'melodicMinor', 'minorPentatonic', 'blues',
  'phrygianDominant', 'hungarianMinor',
])

/** Smallest move onto the target tonic, in −6..+5. A tritone goes down. */
export function harmonizeSemitones(from: number, to: number) {
  let delta = (((Math.round(to) - Math.round(from)) % 12) + 12) % 12
  if (delta > 5) delta -= 12
  return delta
}

export function majorMinorKey(root: number, minor: boolean): MusicalKey {
  const pc = ((Math.round(root) % 12) + 12) % 12
  const name = NOTE_NAMES[pc]
  return {
    root: pc,
    minor,
    label: `${name} ${minor ? 'minor' : 'major'}`,
    scaleId: minor ? 'aeolian' : 'ionian',
  }
}

/** Relative major and minor stay put. Anything else uses the short −6..+5 move. */
export function fitHarmonize(loop: MusicalKey, target: MusicalKey) {
  const fit = fitToProject(loop, target)
  if (fit.semitones === 6) return { ...fit, semitones: -6 }
  return fit
}

export function semitoneLabel(semitones: number) {
  if (semitones > 0) return `+${semitones}`
  return String(semitones)
}

export function scopeClip(input: HarmonizeInput): ScopedClip {
  const base = {
    trackId: input.trackId,
    clipId: input.clipId,
    name: input.name || 'Clip',
    kind: input.kind,
    existingSemitones: input.kind === 'audio' ? Math.round(input.existingSemitones ?? 0) : 0,
  }
  const beat = beatReason(input)
  if (beat) return { ...base, disposition: 'skip', reason: beat, key: null, needsDetect: false }
  if (input.kind === 'midi') return scopeMidi(input, base)
  if (input.kind === 'pattern') return { ...base, disposition: 'skip', reason: 'Beat pattern', key: null, needsDetect: false }
  return scopeAudio(input, base)
}

export function withDetectedKey(clip: ScopedClip, key: MusicalKey | null): ScopedClip {
  if (clip.disposition === 'skip' || !clip.needsDetect) return clip
  if (key) return { ...clip, key: majorMinorKey(key.root, key.minor), needsDetect: false }
  return { ...clip, disposition: 'skip', reason: 'No clear key', key: null, needsDetect: false }
}

export function planRows(clips: ScopedClip[], target: MusicalKey, includeVocals: boolean): HarmonizeRow[] {
  const to = majorMinorKey(target.root, target.minor)
  return clips.map((clip) => {
    if (clip.disposition === 'skip') return skipRow(clip, clip.reason)
    if (clip.disposition === 'vocal' && !includeVocals) return skipRow(clip, 'Vocal track. Sung as recorded.', true)
    if (!clip.key) return skipRow(clip, 'No clear key', clip.disposition === 'vocal')
    const sounding = clip.kind === 'midi' ? clip.key : transposeMusical(clip.key, clip.existingSemitones)
    const fit = fitHarmonize(sounding, to)
    return {
      trackId: clip.trackId,
      clipId: clip.clipId,
      name: clip.name,
      kind: clip.kind,
      action: 'shift',
      reason: clip.reason,
      from: fit.from,
      to: fit.to,
      semitones: fit.semitones,
      tonicOnly: fit.modesDiffer,
      vocal: clip.disposition === 'vocal',
    }
  })
}

export function harmonizeMoves(rows: readonly HarmonizeRow[], unticked: ReadonlySet<string> = new Set()): HarmonizeMove[] {
  const moves: HarmonizeMove[] = []
  for (const row of rows) {
    if (row.action !== 'shift' || unticked.has(row.clipId)) continue
    if (row.kind === 'pattern') continue
    if (!row.semitones) continue
    moves.push({
      trackId: row.trackId,
      clipId: row.clipId,
      kind: row.kind,
      semitones: row.semitones,
      from: row.from || '',
      to: row.to || '',
      tonicOnly: row.tonicOnly === true,
    })
  }
  return moves
}

/** Song key when the musician has set one. Otherwise the key most of the harmonic clips already share. */
export function defaultHarmonizeKey(song: MusicalKey | null, clips: readonly ScopedClip[]): MusicalKey | null {
  if (song) return majorMinorKey(song.root, song.minor)
  const keys: MusicalKey[] = []
  for (const clip of clips) {
    if (clip.disposition === 'skip' || !clip.key) continue
    const sounding = clip.kind === 'midi' ? clip.key : transposeMusical(clip.key, clip.existingSemitones)
    keys.push(majorMinorKey(sounding.root, sounding.minor))
  }
  return mostCommonKey(keys)
}

export function mostCommonKey(keys: readonly MusicalKey[]): MusicalKey | null {
  if (!keys.length) return null
  const buckets = new Map<string, { key: MusicalKey; count: number }>()
  for (const key of keys) {
    const id = `${key.root}:${key.minor ? 'm' : 'M'}`
    const row = buckets.get(id)
    if (row) row.count += 1
    else buckets.set(id, { key: majorMinorKey(key.root, key.minor), count: 1 })
  }
  const cost = (candidate: MusicalKey) => keys.reduce((sum, key) => sum + Math.abs(fitHarmonize(key, candidate).semitones), 0)
  const ranked = [...buckets.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count
    const diff = cost(a.key) - cost(b.key)
    if (diff !== 0) return diff
    if (a.key.minor !== b.key.minor) return a.key.minor ? 1 : -1
    return a.key.root - b.key.root
  })
  return ranked[0]?.key ?? null
}

export function nothingToHarmonizeMessage(rows: readonly HarmonizeRow[]) {
  if (!rows.length) return 'Nothing to harmonize. Add a melodic loop, an instrument, or a MIDI clip first.'
  const reasons = rows.filter((row) => row.action === 'skip').map((row) => row.reason)
  if (reasons.length && reasons.every((reason) => reason.startsWith('Vocal'))) {
    return 'Nothing else to harmonize. Vocal tracks stay as sung unless you include them.'
  }
  if (reasons.length && reasons.every((reason) => reason === 'No clear key')) {
    return 'Nothing to harmonize. Those clips have no clear key.'
  }
  return 'Nothing to harmonize. Drums, percussion, and effects stay put, and clips with no clear key are left alone.'
}

export function shiftableCount(rows: readonly HarmonizeRow[]) {
  return rows.filter((row) => row.action === 'shift').length
}

/** One project write: song key, audio semitones, and MIDI pitches. */
export function applyHarmonizeToProject(project: Project, input: { root: number; minor: boolean; moves: readonly HarmonizeMove[] }) {
  const current = project.scale
  project.scale = normalizeScale({
    ...current,
    root: input.root,
    scale: input.minor ? 'aeolian' : 'ionian',
    library: '',
    keySet: true,
  })
  for (const move of input.moves) {
    if (!move.semitones) continue
    const track = project.tracks.find((item) => item.id === move.trackId)
    if (!track) continue
    if (move.kind === 'audio') applyAudioMove(track.clips, move)
    else applyMidiMove(track.midiClips, move)
  }
}

export function transposeMidiClip(clip: MidiClip, semitones: number) {
  if (!semitones) return
  clip.notes = clip.notes.map((note) => shiftNote(note, semitones))
  if (clip.takes) {
    clip.takes = clip.takes.map((take) => ({ ...take, notes: take.notes.map((note) => shiftNote(note, semitones)) }))
  }
}

function applyAudioMove(clips: AudioClip[], move: HarmonizeMove) {
  const clip = clips.find((item) => item.id === move.clipId)
  if (!clip) return
  const base = clip.stretch ?? {
    sourceSamples: Math.max(1, clip.durationSamples),
    semitones: 0,
    cents: 0,
    mode: 'pro' as const,
    followTempo: false,
    sourceBpm: null,
    markers: [],
  }
  const total = Math.round((base.semitones || 0) + move.semitones)
  const formantBefore = base.formant === true
  const mode = base.mode === 'tonal' ? 'tonal' : 'pro'
  const playbackBefore = clip.playback === 'recorded' ? 'recorded' as const : undefined
  if (playbackBefore) delete clip.playback
  clip.stretch = { ...base, semitones: total, cents: 0, formant: true, mode, markers: base.markers }
  clip.keyShift = {
    semitones: total,
    from: move.from,
    to: move.to,
    tonicOnly: move.tonicOnly,
    formantBefore,
    playbackBefore,
  }
}

function applyMidiMove(clips: MidiClip[], move: HarmonizeMove) {
  const clip = clips.find((item) => item.id === move.clipId)
  if (!clip) return
  const total = Math.round((clip.keyShift?.semitones ?? 0) + move.semitones)
  transposeMidiClip(clip, move.semitones)
  clip.keyShift = {
    semitones: total,
    from: move.from,
    to: move.to,
    tonicOnly: move.tonicOnly,
  }
}

function shiftNote(note: MidiNote, semitones: number): MidiNote {
  return { ...note, pitch: Math.max(0, Math.min(127, Math.round(note.pitch) + semitones)) }
}

function skipRow(clip: ScopedClip, reason: string, vocal = false): HarmonizeRow {
  return {
    trackId: clip.trackId,
    clipId: clip.clipId,
    name: clip.name,
    kind: clip.kind,
    action: 'skip',
    reason,
    vocal,
  }
}

function beatReason(input: HarmonizeInput) {
  if (input.kind === 'pattern') return 'Beat pattern'
  if (input.drumMachine || input.instrument === 'pads' || hasPlugin(input, 'pads') || hasPlugin(input, 'drums')) return 'Beat Machine'
  if (input.instrument === 'drum-machine' || hasPlugin(input, 'drum-machine')) return 'Drum kit'
  if (hasPlugin(input, 'steps')) return 'Drum pattern'
  const track = input.trackName.toLowerCase()
  if (/\bbeat machine\b/.test(track)) return 'Beat Machine'
  if (/\bdrum ?kits?\b/.test(track)) return 'Drum kit'
  return ''
}

function hasPlugin(input: HarmonizeInput, id: string) {
  return (input.pluginIds ?? []).includes(id)
}

function scopeMidi(input: HarmonizeInput, base: Omit<ScopedClip, 'disposition' | 'reason' | 'key' | 'needsDetect'>): ScopedClip {
  const named = `${input.name} ${input.trackName}`
  if (drumName(named) && !bassNote(named, '', input.soundTags)) {
    return { ...base, disposition: 'skip', reason: 'Drum MIDI', key: null, needsDetect: false }
  }
  const notes = input.notes ?? []
  if (!notes.length) return { ...base, disposition: 'skip', reason: 'No notes', key: null, needsDetect: false }
  const found = detectMidiKey(notes.map((note) => ({ pitch: note.pitch, weight: note.durationBeats ?? 1 })))
  if (!notes.length || !Number.isFinite(found.score) || found.score <= 0) {
    return { ...base, disposition: 'skip', reason: 'No clear key', key: null, needsDetect: false }
  }
  const minor = MINOR_SCALES.has(found.scale)
  return { ...base, disposition: 'harmonic', reason: 'MIDI', key: majorMinorKey(found.root, minor), needsDetect: false }
}

function scopeAudio(input: HarmonizeInput, base: Omit<ScopedClip, 'disposition' | 'reason' | 'key' | 'needsDetect'>): ScopedClip {
  const type = clean(input.soundType)
  const category = clean(input.soundCategory)
  const role = clean(input.soundRole)
  const tags = input.soundTags ?? []
  const named = `${input.name} ${(tags).join(' ')}`
  const effect = type === 'sfx' || type === 'fx' || category === 'fx' || category === 'sfx' || category === 'noise' || /\b(sfx|noise|foley|whoosh|riser)\b/.test(named.toLowerCase())
  if (effect && !harmonicCategory(category)) {
    return { ...base, disposition: 'skip', reason: 'Effect', key: null, needsDetect: false }
  }
  if (role === 'drum_one_shot' || role === 'drum-one-shot') {
    return { ...base, disposition: 'skip', reason: 'Drum one-shot', key: null, needsDetect: false }
  }
  if (type === 'drum-loop' || type === 'drum loop' || type === 'drum-kit' || type === 'drum kit' || type === 'kit') {
    return { ...base, disposition: 'skip', reason: type.includes('kit') ? 'Drum kit' : 'Drum loop', key: null, needsDetect: false }
  }
  if (DRUM_CATEGORIES.has(category) && !bassNote(input.name, category, tags)) {
    const reason = category === 'percussion' || category === 'perc' ? 'Percussion' : type === 'one-shot' || type === 'oneshot' ? 'Drum one-shot' : 'Drum loop'
    return { ...base, disposition: 'skip', reason, key: null, needsDetect: false }
  }
  if (drumName(named) && !bassNote(input.name, category, tags)) {
    const reason = type === 'one-shot' || type === 'oneshot' ? 'Drum one-shot' : category === 'percussion' || category === 'perc' ? 'Percussion' : 'Drum loop'
    return { ...base, disposition: 'skip', reason, key: null, needsDetect: false }
  }
  const key = knownKey(input)
  const vocal = input.trackKind === 'vocal'
  const reason = audioReason(type, category)
  if (key) {
    return { ...base, disposition: vocal ? 'vocal' : 'harmonic', reason: vocal ? 'Vocal' : reason, key, needsDetect: false }
  }
  if (input.hearingClear === false) {
    return { ...base, disposition: 'skip', reason: 'No clear key', key: null, needsDetect: false }
  }
  return { ...base, disposition: vocal ? 'vocal' : 'harmonic', reason: vocal ? 'Vocal' : reason, key: null, needsDetect: true }
}

function audioReason(type: string, category: string) {
  if (type === 'one-shot' || type === 'oneshot' || type === 'one shot') return 'Harmonic one-shot'
  if (type === 'instrument') return 'Instrument'
  if (harmonicCategory(category) && (type === 'one-shot' || category === 'stab' || category === 'stabs')) return 'Harmonic one-shot'
  return 'Harmonic loop'
}

function knownKey(input: HarmonizeInput): MusicalKey | null {
  const tagged = [input.soundKey, input.loopKey, input.hearingClear ? input.hearingKey : '']
  for (const value of tagged) {
    const parsed = value ? parseMusicalKey(value) : null
    if (parsed) return majorMinorKey(parsed.root, parsed.minor)
  }
  const fromName = parseMusicalKey(keyFromLooseText(input.name) || '')
  if (fromName) return majorMinorKey(fromName.root, fromName.minor)
  for (const tag of input.soundTags ?? []) {
    const parsed = parseMusicalKey(keyFromLooseText(tag) || tag)
    if (parsed && /minor|major|maj|min|m/i.test(tag)) return majorMinorKey(parsed.root, parsed.minor)
  }
  return null
}

/** "riff_F#m_100" and "A minor loop" carry a key. A bare "C" does not. */
function keyFromLooseText(value: string) {
  const tokens = value.replace(/[()[\]{}]/g, ' ').split(/[\s_\-./]+/).filter(Boolean)
  for (let i = 0; i < tokens.length; i++) {
    const direct = parseMusicalKey(tokens[i])
    if (direct && /minor|major|maj|min|m/i.test(tokens[i])) return direct.label
    const next = tokens[i + 1]
    if (next && /^(major|minor|maj|min)$/i.test(next)) {
      const pair = parseMusicalKey(`${tokens[i]} ${next}`)
      if (pair) return pair.label
    }
  }
  return ''
}

function harmonicCategory(category: string) {
  return /^(bass|sub|keys|piano|synth|guitar|strings|string|pad|pads|lead|chord|chords|stab|stabs|brass|melody|arp|pluck|organ|mallet|flute|choir|vocal|vox|bell|violin|cello)$/.test(category)
}

function bassNote(name: string, category: string, tags?: string[]) {
  const hay = `${name} ${category} ${(tags ?? []).join(' ')}`.toLowerCase()
  if (!/\b(bass|sub)\b/.test(hay)) return false
  if (/\b(kicks?|snares?|hats?|claps?|percs?|percussion|cymbals?|shakers?)\b/.test(hay)) return false
  return true
}

function drumName(value: string) {
  return /\b(drums?|kicks?|snares?|hats?|percussion|percs?|claps?|shakers?|cymbals?|tambourines?)\b/i.test(value)
}

function clean(value: string | undefined) {
  return (value ?? '').trim().toLowerCase()
}

function transposeMusical(key: MusicalKey, semitones: number): MusicalKey {
  if (!semitones) return majorMinorKey(key.root, key.minor)
  return majorMinorKey(key.root + semitones, key.minor)
}

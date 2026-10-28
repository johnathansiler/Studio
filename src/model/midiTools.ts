import { noteForPlayback } from './padMachine'
import { SCALES, snapPitch, type ScaleId } from './scale'
import type { LiveCaptureSettings, MidiClip, MidiFx, MidiFxKind, MidiMapEntry, MidiNote, MidiOutSettings, Project, Track } from './types'

export interface ChainContext {
  root: number
  scale: ScaleId
  seed: number
}

export interface LearnSlot {
  target: string
  label: string
  min: number
  max: number
  toggle: boolean
}

export interface ParsedMidi {
  kind: 'note-on' | 'note-off' | 'cc'
  channel: number
  number: number
  value: number
}

export interface LearnNode {
  midi?: string
  midiLabel?: string
  midiMin?: number
  midiMax?: number
  midiToggle?: boolean
  trackId?: string
  className?: string
  text?: string
  aria?: string
  inMaster?: boolean
  range?: boolean
}

export interface CaptureHit {
  trackId: string
  pitch: number
  onBeat: number
  offBeat: number | null
  velocity: number
}

export interface CapturedClip {
  startBeat: number
  durationBeats: number
  notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[]
}

export interface AudioRoute {
  trackId: string
  input: string
  channel: number | null
  deviceId: string | null
  peerId: string | null
}

export interface MidiRoute {
  trackId: string
  /** Null listens to every port that no other armed track claimed. */
  portId: string | null
}

export type ControlWrite =
  | { kind: 'track'; id: string; key: 'volume' | 'pan' | 'mute' | 'solo' | 'armed'; value: number }
  | { kind: 'master'; volume: number }
  | { kind: 'tempo'; tempo: number }
  | { kind: 'flag'; flag: 'loopEnabled' | 'metronomeEnabled'; value: boolean }
  | { kind: 'fx'; trackId: string; fxId: string; param: string; value: number }

const CHORDS: number[][] = [
  [0, 4, 7],
  [0, 3, 7],
  [0, 2, 7],
  [0, 5, 7],
  [0, 4, 7, 10],
  [0, 3, 7, 10],
  [0, 3, 6],
  [0, 4, 8],
]

export const FX_LABEL: Record<MidiFxKind, string> = {
  arp: 'Arp',
  chord: 'Chord',
  scale: 'Scale',
  repeat: 'Repeat',
  humanize: 'Human',
  velocity: 'Curve',
}

export const FX_HINT: Record<MidiFxKind, string> = {
  arp: 'Walks held notes up, down, or at random',
  chord: 'Stacks a chord on each note',
  scale: 'Locks notes to the key',
  repeat: 'Retriggers a held note',
  humanize: 'Nudges timing and velocity',
  velocity: 'Reshapes how hard notes hit',
}

export const FX_RATES = [
  { beats: 1, label: '1/4' },
  { beats: 0.5, label: '1/8' },
  { beats: 1 / 3, label: '1/8T' },
  { beats: 0.25, label: '1/16' },
  { beats: 1 / 6, label: '1/16T' },
  { beats: 0.125, label: '1/32' },
]

const DEFAULT_PARAMS: Record<MidiFxKind, Record<string, number>> = {
  arp: { rate: 0.25, direction: 0, octaves: 1, gate: 0.8 },
  chord: { type: 0, inversion: 0 },
  scale: { follow: 1, root: 0, scale: 0 },
  repeat: { rate: 0.25, gate: 0.5 },
  humanize: { time: 0.02, vel: 0.08 },
  velocity: { curve: 0, amount: 1, floor: 0, ceiling: 1 },
}

export function defaultMidiOut(): MidiOutSettings {
  return { enabled: false, port: '', channel: 0, clock: false }
}

export function defaultLiveCapture(): LiveCaptureSettings {
  return { enabled: true, bars: 4 }
}

export function defaultFx(kind: MidiFxKind, id: string): MidiFx {
  return { id, kind, enabled: true, params: { ...DEFAULT_PARAMS[kind] } }
}

export function hidesHardwareMidi(userAgent: string): boolean {
  return /iPhone|iPod/i.test(userAgent)
}

export function chainContext(project: Project, seedKey: string): ChainContext {
  let seed = 1
  for (let i = 0; i < seedKey.length; i++) seed = (Math.imul(seed, 33) + seedKey.charCodeAt(i)) >>> 0
  return {
    root: project.scale?.root ?? 0,
    scale: project.scale?.scale ?? 'ionian',
    seed: seed || 1,
  }
}

export function normalizeMidiProject(project: Project): Project {
  project.midiMaps = sanitizeMaps(project.midiMaps)
  project.midiOut = { ...defaultMidiOut(), ...(isRecord(project.midiOut) ? project.midiOut : {}) }
  project.liveCapture = {
    ...defaultLiveCapture(),
    ...(isRecord(project.liveCapture) ? project.liveCapture : {}),
  }
  project.liveCapture.bars = clamp(Math.round(project.liveCapture.bars || 4), 1, 32)
  project.liveCapture.enabled = project.liveCapture.enabled !== false
  project.midiOut.channel = clamp(Math.round(project.midiOut.channel || 0), 0, 15)
  project.midiOut.port = typeof project.midiOut.port === 'string' ? project.midiOut.port : ''
  for (const track of project.tracks) track.midiFx = sanitizeFx(track.midiFx)
  return project
}

export function sanitizeFx(list: MidiFx[] | undefined): MidiFx[] {
  if (!Array.isArray(list)) return []
  const out: MidiFx[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    if (!isKind(item.kind) || typeof item.id !== 'string') continue
    const base = defaultFx(item.kind, item.id)
    out.push({
      id: item.id,
      kind: item.kind,
      enabled: item.enabled !== false,
      params: { ...base.params, ...(isRecord(item.params) ? numbers(item.params) : {}) },
    })
  }
  return out
}

export function sanitizeMaps(list: MidiMapEntry[] | undefined): MidiMapEntry[] {
  if (!Array.isArray(list)) return []
  const out: MidiMapEntry[] = []
  for (const item of list) {
    if (!item || typeof item.id !== 'string' || typeof item.target !== 'string') continue
    if (item.source !== 'cc' && item.source !== 'note') continue
    out.push({
      id: item.id,
      target: item.target,
      label: typeof item.label === 'string' && item.label ? item.label : item.target,
      source: item.source,
      channel: clamp(Math.round(item.channel ?? -1), -1, 15),
      number: clamp(Math.round(item.number ?? 0), 0, 127),
      min: finite(item.min, 0),
      max: finite(item.max, 1),
      mode: item.mode === 'toggle' ? 'toggle' : 'absolute',
    })
  }
  return out
}

export function prepareClipNotes(project: Project, track: Track, clip: MidiClip): MidiNote[] {
  const barBeats = Math.max(1, project.timeSignature?.numerator || 4)
  const audible: MidiNote[] = []
  for (const note of clip.notes) {
    const next = noteForPlayback(note, {
      stepBeats: 0.25,
      seed: project.padKit?.seed ?? 1,
      bar: Math.floor((clip.startBeat + note.startBeat) / barBeats),
      fill: Boolean(project.padKit?.fill),
    })
    if (next) audible.push(next)
  }
  return applyMidiChain(audible, track.midiFx, chainContext(project, clip.id))
}

/** Notes that reach the instrument. The clip itself is left untouched. */
export function applyMidiChain(notes: MidiNote[], fx: MidiFx[] | undefined, ctx: ChainContext): MidiNote[] {
  let current = notes.filter((note) => !note.muted).map((note) => cloneNote(note))
  for (const step of sanitizeFx(fx)) {
    if (!step.enabled) continue
    current = runStep(step, current, ctx)
  }
  return current
}

export function enabledFx(fx: MidiFx[] | undefined): MidiFx[] {
  return sanitizeFx(fx).filter((item) => item.enabled)
}

function runStep(step: MidiFx, notes: MidiNote[], ctx: ChainContext): MidiNote[] {
  if (step.kind === 'scale') return notes.map((note) => scaleNote(note, step.params, ctx))
  if (step.kind === 'chord') return notes.flatMap((note) => chordNotes(note, step.params))
  if (step.kind === 'arp') return arpNotes(notes, step.params, ctx)
  if (step.kind === 'repeat') return repeatNotes(notes, step.params)
  if (step.kind === 'humanize') return notes.map((note, index) => humanizeNote(note, step.params, ctx, index))
  return notes.map((note) => velocityNote(note, step.params))
}

function scaleNote(note: MidiNote, params: Record<string, number>, ctx: ChainContext): MidiNote {
  const follow = (params.follow ?? 1) >= 0.5
  const root = follow ? ctx.root : clamp(Math.round(params.root || 0), 0, 11)
  const scale = follow ? ctx.scale : scaleAt(params.scale)
  return { ...note, pitch: snapPitch(note.pitch, root, scale) }
}

function chordNotes(note: MidiNote, params: Record<string, number>): MidiNote[] {
  const type = clamp(Math.round(params.type || 0), 0, CHORDS.length - 1)
  const intervals = CHORDS[type]
  const inversion = clamp(Math.round(params.inversion || 0), 0, Math.max(0, intervals.length - 1))
  const tones = intervals.map((interval) => note.pitch + interval)
  for (let i = 0; i < inversion; i++) {
    const bass = tones.shift()
    if (bass == null) break
    tones.push(bass + 12)
  }
  return tones.map((pitch, index) => ({
    ...note,
    id: index === 0 ? note.id : `${note.id}:c${index}`,
    pitch: clamp(Math.round(pitch), 0, 127),
  }))
}

function arpNotes(notes: MidiNote[], params: Record<string, number>, ctx: ChainContext): MidiNote[] {
  if (!notes.length) return []
  const rate = Math.max(0.03125, params.rate || 0.25)
  const gate = clamp(params.gate ?? 0.8, 0.05, 1)
  const direction = clamp(Math.round(params.direction || 0), 0, 3)
  const octaves = clamp(Math.round(params.octaves || 1), 1, 4)
  const start = Math.min(...notes.map((note) => note.startBeat))
  const end = Math.max(...notes.map((note) => note.startBeat + note.durationBeats))
  const steps = Math.min(4096, Math.max(1, Math.ceil((end - start) / rate)))
  const out: MidiNote[] = []
  let pattern = 0
  for (let i = 0; i < steps; i++) {
    const t = start + i * rate
    if (t >= end - 1e-6) break
    const held = notes.filter((note) => note.startBeat <= t + 1e-6 && note.startBeat + note.durationBeats > t + 1e-6)
    if (!held.length) continue
    const expanded = expandPitches(held, octaves)
    if (!expanded.length) continue
    const index = arpIndex(direction, pattern, expanded.length, ctx.seed)
    const pitch = expanded[index]
    const source = held.find((note) => note.pitch === pitch) || held.find((note) => note.pitch % 12 === pitch % 12) || held[0]
    out.push({
      ...source,
      id: `${source.id}:a${pattern}`,
      pitch,
      startBeat: t,
      durationBeats: Math.min(rate * gate, end - t),
      velocity: unitVel(source.velocity),
    })
    pattern += 1
  }
  return out
}

function expandPitches(held: MidiNote[], octaves: number): number[] {
  const base = [...new Set(held.map((note) => clamp(Math.round(note.pitch), 0, 127)))].sort((a, b) => a - b)
  const expanded: number[] = []
  for (let octave = 0; octave < octaves; octave++) {
    for (const pitch of base) {
      const next = pitch + octave * 12
      if (next <= 127) expanded.push(next)
    }
  }
  return expanded
}

function arpIndex(direction: number, step: number, length: number, seed: number): number {
  if (length <= 1) return 0
  if (direction === 1) return length - 1 - (step % length)
  if (direction === 2) {
    const cycle = (length - 1) * 2
    const pos = step % cycle
    return pos < length ? pos : cycle - pos
  }
  if (direction === 3) return hash(seed, step + 1) % length
  return step % length
}

function repeatNotes(notes: MidiNote[], params: Record<string, number>): MidiNote[] {
  const step = Math.max(0.03125, params.rate || 0.25)
  const length = Math.max(0.02, step * clamp(params.gate ?? 0.5, 0.05, 1))
  const out: MidiNote[] = []
  for (const note of notes) {
    const end = note.startBeat + Math.max(0.02, note.durationBeats)
    let index = 0
    for (let t = note.startBeat; t < end - 1e-6 && index < 512; t += step, index++) {
      out.push({
        ...note,
        id: `${note.id}:r${index}`,
        startBeat: t,
        durationBeats: Math.min(length, end - t),
        velocity: unitVel(note.velocity),
      })
    }
  }
  return out
}

function humanizeNote(note: MidiNote, params: Record<string, number>, ctx: ChainContext, index: number): MidiNote {
  const time = Math.max(0, params.time || 0)
  const vel = Math.max(0, params.vel || 0)
  const shift = (unit(hash(ctx.seed, index + 1)) * 2 - 1) * time
  const delta = (unit(hash(ctx.seed, index + 99)) * 2 - 1) * vel
  return {
    ...note,
    startBeat: Math.max(0, note.startBeat + shift),
    velocity: clamp(unitVel(note.velocity) + delta, 0.01, 1),
  }
}

function velocityNote(note: MidiNote, params: Record<string, number>): MidiNote {
  const dry = unitVel(note.velocity)
  const curve = clamp(Math.round(params.curve || 0), 0, 3)
  const amount = clamp(params.amount ?? 1, 0, 1)
  let shaped = dry
  if (curve === 1) shaped = Math.sqrt(dry)
  else if (curve === 2) shaped = dry * dry
  else if (curve === 3) shaped = 0.85
  const mixed = dry + (shaped - dry) * amount
  const floor = clamp(params.floor ?? 0, 0, 1)
  const ceiling = clamp(params.ceiling ?? 1, floor, 1)
  return { ...note, velocity: clamp(mixed, floor, ceiling) }
}

export function parseMidi(data: ArrayLike<number> | null | undefined): ParsedMidi | null {
  if (!data || data.length < 3) return null
  const status = data[0] & 0xf0
  const channel = data[0] & 0x0f
  const number = data[1] & 0x7f
  const value = data[2] & 0x7f
  if (status === 0xb0) return { kind: 'cc', channel, number, value }
  if (status === 0x90 && value > 0) return { kind: 'note-on', channel, number, value }
  if (status === 0x80 || (status === 0x90 && value === 0)) return { kind: 'note-off', channel, number, value: 0 }
  return null
}

export function mapMatches(entry: MidiMapEntry, message: ParsedMidi): boolean {
  if (entry.channel >= 0 && entry.channel !== message.channel) return false
  if (entry.number !== message.number) return false
  if (entry.source === 'cc') return message.kind === 'cc'
  return message.kind === 'note-on' || message.kind === 'note-off'
}

export function bindingFromMessage(slot: LearnSlot, message: ParsedMidi, id: string): MidiMapEntry {
  const source = message.kind === 'cc' ? 'cc' : 'note'
  return {
    id,
    target: slot.target,
    label: slot.label,
    source,
    channel: message.channel,
    number: message.number,
    min: slot.min,
    max: slot.max,
    mode: slot.toggle || source === 'note' ? 'toggle' : 'absolute',
  }
}

export function upsertMap(list: MidiMapEntry[], entry: MidiMapEntry): MidiMapEntry[] {
  const rest = list.filter((item) => item.target !== entry.target && item.id !== entry.id)
  return [...rest, entry]
}

export function clearMap(list: MidiMapEntry[], id: string): MidiMapEntry[] {
  return list.filter((item) => item.id !== id)
}

export function describeMap(entry: MidiMapEntry): string {
  const channel = entry.channel < 0 ? 'any ch' : `ch ${entry.channel + 1}`
  const name = entry.source === 'cc' ? `CC ${entry.number}` : `note ${entry.number}`
  return `${name} · ${channel}`
}

/** Absolute maps scale 0–127. Toggle notes flip; toggle CCs are on from 64. Note-off does not flip. */
export function applyMapped(entry: MidiMapEntry, message: ParsedMidi, current: number): number | null {
  if (!mapMatches(entry, message)) return null
  if (entry.mode === 'toggle') {
    if (entry.source === 'note') {
      if (message.kind !== 'note-on') return null
      return current >= 0.5 ? 0 : 1
    }
    return message.value >= 64 ? 1 : 0
  }
  if (message.kind === 'note-off') return null
  const span = entry.max - entry.min
  return entry.min + (message.value / 127) * span
}

export function describeWrite(target: string, value: number): ControlWrite | null {
  if (target === 'master:volume') return { kind: 'master', volume: value }
  if (target === 'transport:tempo') return { kind: 'tempo', tempo: value }
  if (target === 'transport:loop') return { kind: 'flag', flag: 'loopEnabled', value: value >= 0.5 }
  if (target === 'transport:click') return { kind: 'flag', flag: 'metronomeEnabled', value: value >= 0.5 }
  const track = /^track:([^:]+):(volume|pan|mute|solo|arm)$/.exec(target)
  if (track) {
    const key = track[2] === 'arm' ? 'armed' : (track[2] as 'volume' | 'pan' | 'mute' | 'solo')
    return { kind: 'track', id: track[1], key, value }
  }
  const fx = /^fx:([^:]+):([^:]+):([^:]+)$/.exec(target)
  if (fx) return { kind: 'fx', trackId: fx[1], fxId: fx[2], param: fx[3], value }
  return null
}

export function currentControl(project: Project, target: string): number {
  if (target === 'master:volume') return project.masterVolume
  if (target === 'transport:tempo') return project.tempo
  if (target === 'transport:loop') return project.loopEnabled ? 1 : 0
  if (target === 'transport:click') return project.metronomeEnabled ? 1 : 0
  const track = /^track:([^:]+):(volume|pan|mute|solo|arm)$/.exec(target)
  if (track) {
    const found = project.tracks.find((item) => item.id === track[1])
    if (!found) return 0
    if (track[2] === 'volume') return found.volume
    if (track[2] === 'pan') return found.pan
    if (track[2] === 'mute') return found.mute ? 1 : 0
    if (track[2] === 'solo') return found.solo ? 1 : 0
    return found.armed ? 1 : 0
  }
  const fx = /^fx:([^:]+):([^:]+):([^:]+)$/.exec(target)
  if (fx) {
    const found = project.tracks.find((item) => item.id === fx[1])
    const effect = found?.midiFx?.find((item) => item.id === fx[2])
    return effect?.params[fx[3]] ?? 0
  }
  return 0
}

export function slotFromNode(node: LearnNode | null): LearnSlot | null {
  if (!node) return null
  if (node.midi) {
    return {
      target: node.midi,
      label: node.midiLabel || node.aria || 'Control',
      min: node.midiMin ?? 0,
      max: node.midiMax ?? 1,
      toggle: Boolean(node.midiToggle),
    }
  }
  if (node.trackId) {
    const text = (node.text || '').trim()
    if (text === 'M') return toggleSlot(`track:${node.trackId}:mute`, 'Mute')
    if (text === 'S') return toggleSlot(`track:${node.trackId}:solo`, 'Solo')
    if (text === 'R') return toggleSlot(`track:${node.trackId}:arm`, 'Arm')
    if (node.range && (node.className || '').includes('pan')) {
      return { target: `track:${node.trackId}:pan`, label: 'Pan', min: -1, max: 1, toggle: false }
    }
    if (node.range) return { target: `track:${node.trackId}:volume`, label: 'Volume', min: 0, max: 1.25, toggle: false }
  }
  if (node.inMaster && node.range) return { target: 'master:volume', label: 'Master', min: 0, max: 1.25, toggle: false }
  if (node.aria === 'BPM' || node.aria === 'Tap tempo') {
    return { target: 'transport:tempo', label: 'Tempo', min: 30, max: 300, toggle: false }
  }
  if (node.aria === 'Loop') return toggleSlot('transport:loop', 'Loop')
  if (node.text === 'Click' || node.aria === 'Click') return toggleSlot('transport:click', 'Click')
  return null
}

function toggleSlot(target: string, label: string): LearnSlot {
  return { target, label, min: 0, max: 1, toggle: true }
}

export function noteBytes(on: boolean, channel: number, pitch: number, velocity: number): number[] {
  return [(on ? 0x90 : 0x80) | (channel & 0x0f), clamp(Math.round(pitch), 0, 127), clamp(Math.round(velocity), 0, 127)]
}

export function midiVelocityByte(velocity: number): number {
  const scaled = velocity <= 1 ? velocity * 127 : velocity
  return clamp(Math.round(scaled), 0, 127)
}

export function midiClockBytes(kind: 'start' | 'stop' | 'pulse'): number[] {
  if (kind === 'start') return [0xfa]
  if (kind === 'stop') return [0xfc]
  return [0xf8]
}

export function clockIntervalMs(tempo: number): number {
  return 60000 / Math.max(1, tempo) / 24
}

export class LiveCaptureBuffer {
  private hits: CaptureHit[] = []

  add(trackId: string, notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[]) {
    for (const note of notes) {
      this.hits.push({
        trackId,
        pitch: note.pitch,
        onBeat: note.startBeat,
        offBeat: note.startBeat + note.durationBeats,
        velocity: unitVel(note.velocity),
      })
    }
    this.trim()
  }

  noteOn(trackId: string, pitch: number, beat: number, velocity: number) {
    const open = this.hits.find((hit) => hit.trackId === trackId && hit.pitch === pitch && hit.offBeat == null)
    if (open) open.offBeat = Math.max(open.onBeat, beat)
    this.hits.push({ trackId, pitch, onBeat: beat, offBeat: null, velocity: unitVel(velocity) })
    this.trim()
  }

  noteOff(trackId: string, pitch: number, beat: number) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const hit = this.hits[i]
      if (hit.trackId === trackId && hit.pitch === pitch && hit.offBeat == null) {
        hit.offBeat = Math.max(hit.onBeat, beat)
        return
      }
    }
  }

  clip(trackId: string | null, nowBeat: number, windowBeats: number): CapturedClip | null {
    const from = nowBeat - Math.max(0.25, windowBeats)
    const kept = this.hits.filter((hit) => {
      if (trackId && hit.trackId !== trackId) return false
      const end = hit.offBeat ?? nowBeat
      return end > from && hit.onBeat < nowBeat
    })
    if (!kept.length) return null
    const start = Math.min(...kept.map((hit) => Math.max(hit.onBeat, from)))
    const end = Math.max(...kept.map((hit) => Math.min(hit.offBeat ?? nowBeat, nowBeat)))
    const notes = kept
      .map((hit) => {
        const on = Math.max(hit.onBeat, from)
        const off = Math.min(hit.offBeat ?? nowBeat, nowBeat)
        return {
          pitch: hit.pitch,
          startBeat: on - start,
          durationBeats: Math.max(0.05, off - on),
          velocity: hit.velocity,
        }
      })
      .filter((note) => note.durationBeats > 0)
      .sort((a, b) => a.startBeat - b.startBeat || a.pitch - b.pitch)
    if (!notes.length) return null
    return { startBeat: Math.max(0, start), durationBeats: Math.max(0.25, end - start), notes }
  }

  clear(trackId?: string) {
    this.hits = trackId ? this.hits.filter((hit) => hit.trackId !== trackId) : []
  }

  latest(trackId: string | null): number {
    let end = 0
    for (const hit of this.hits) {
      if (trackId && hit.trackId !== trackId) continue
      end = Math.max(end, hit.offBeat ?? hit.onBeat)
    }
    return end
  }

  private trim() {
    if (this.hits.length > 2048) this.hits.splice(0, this.hits.length - 2048)
  }
}

export function inputMatchesPort(input: string, portId: string): boolean {
  if (input === 'midi' || input === 'midi:all') return true
  return input === `midi:${portId}`
}

/** Armed MIDI tracks for this port. A named port wins over a track set to all inputs. */
export function tracksForPort(tracks: Track[], portId: string): Track[] {
  const armed = tracks.filter((track) => track.type === 'midi' && track.armed)
  const specific = armed.filter((track) => track.input === `midi:${portId}`)
  if (specific.length) return specific
  return armed.filter((track) => track.input === 'midi' || track.input === 'midi:all')
}

export function midiDestinations(tracks: Track[], portId: string, selectedId: string | null, recording: boolean): { play: string[]; record: string[] } {
  const matched = tracksForPort(tracks, portId)
  if (matched.length) {
    const ids = matched.map((track) => track.id)
    return { play: ids, record: recording ? ids : [] }
  }
  const selected = tracks.find((track) => track.id === selectedId && track.type === 'midi')
  const fallback = selected || tracks.find((track) => track.type === 'midi')
  return { play: fallback ? [fallback.id] : [], record: [] }
}

export function planAudioRoutes(tracks: Track[]): AudioRoute[] {
  const routes: AudioRoute[] = []
  for (const track of tracks) {
    if (track.type !== 'audio' || !track.armed) continue
    const parsed = parseAudioInput(track.input)
    if (!parsed) continue
    routes.push({ trackId: track.id, input: track.input, ...parsed })
  }
  return routes
}

export function planMidiRoutes(tracks: Track[]): MidiRoute[] {
  return tracks
    .filter((track) => track.type === 'midi' && track.armed && (track.input === 'midi' || track.input === 'midi:all' || track.input.startsWith('midi:')))
    .map((track) => ({
      trackId: track.id,
      portId: track.input === 'midi' || track.input === 'midi:all' ? null : track.input.slice('midi:'.length),
    }))
}

export function parseAudioInput(input: string): Omit<AudioRoute, 'trackId' | 'input'> | null {
  if (input === 'none' || input.startsWith('midi')) return null
  if (input.startsWith('remote:')) {
    return { channel: null, deviceId: null, peerId: input.slice('remote:'.length) }
  }
  const device = /^dev:([^:]+)(?::(\d+))?$/.exec(input)
  if (device) {
    return { channel: device[2] == null ? null : Number(device[2]), deviceId: device[1], peerId: null }
  }
  if (input === 'mic' || input === 'line' || /^mic:\d+$/.test(input)) {
    const channel = /^mic:(\d+)$/.exec(input)
    return { channel: channel ? Number(channel[1]) : null, deviceId: null, peerId: null }
  }
  return null
}

export interface RoutingChoice {
  id: string
  label: string
  kind: 'audio' | 'midi'
  channels?: number
}

/** Assigns each free input to an existing track of the same kind. */
export function suggestRouting(tracks: Track[], choices: RoutingChoice[]): { trackId: string; input: string; armed: boolean }[] {
  const audioTracks = tracks.filter((track) => track.type === 'audio')
  const midiTracks = tracks.filter((track) => track.type === 'midi')
  const routes: { trackId: string; input: string; armed: boolean }[] = []
  let audioIndex = 0
  let midiIndex = 0
  const takeAudio = () => {
    const track = audioTracks[audioIndex]
    if (!track) return null
    audioIndex += 1
    return track
  }
  for (const choice of choices) {
    if (choice.kind === 'audio') {
      const channels = Math.max(1, choice.channels || 1)
      if (choice.id === 'default') {
        for (let channel = 0; channel < channels; channel++) {
          const track = takeAudio()
          if (!track) break
          routes.push({ trackId: track.id, input: channels > 1 ? `mic:${channel}` : 'mic', armed: true })
        }
      } else if (channels > 1) {
        for (let channel = 0; channel < channels; channel++) {
          const track = takeAudio()
          if (!track) break
          routes.push({ trackId: track.id, input: `dev:${choice.id}:${channel}`, armed: true })
        }
      } else {
        const track = takeAudio()
        if (track) routes.push({ trackId: track.id, input: `dev:${choice.id}`, armed: true })
      }
    } else {
      const track = midiTracks[midiIndex]
      if (!track) continue
      midiIndex += 1
      routes.push({ trackId: track.id, input: `midi:${choice.id}`, armed: true })
    }
  }
  return routes
}

export interface LiveSink {
  on: (pitch: number, velocity: number) => void
  off: (pitch: number) => void
}

/** Plays the same chain the clip renderer uses, one held chord at a time. */
export class LiveMidiChain {
  private held = new Map<number, number>()
  private active = new Map<number, number>()
  private origin = 0
  private cancel: (() => void) | null = null
  private fxOf: () => MidiFx[] | undefined = () => []
  private ctxOf: () => ChainContext = () => ({ root: 0, scale: 'ionian', seed: 1 })
  private tempoOf: () => number = () => 120

  constructor(
    private schedule: (ms: number, fn: () => void) => () => void,
    private now: () => number,
    private sink: LiveSink,
  ) {}

  configure(fxOf: () => MidiFx[] | undefined, ctxOf: () => ChainContext, tempoOf: () => number) {
    this.fxOf = fxOf
    this.ctxOf = ctxOf
    this.tempoOf = tempoOf
    if (this.held.size && this.timed() && !this.cancel) this.arm()
  }

  holds(pitch: number): boolean {
    return this.held.has(pitch)
  }

  noteOn(pitch: number, velocity: number) {
    const wasEmpty = this.held.size === 0
    this.held.set(clamp(Math.round(pitch), 0, 127), unitVel(velocity))
    if (wasEmpty) this.origin = this.now()
    this.sync()
    this.arm()
  }

  noteOff(pitch: number) {
    this.held.delete(clamp(Math.round(pitch), 0, 127))
    if (!this.held.size) {
      this.disarm()
      this.origin = this.now()
    }
    this.sync()
  }

  panic() {
    this.held.clear()
    this.disarm()
    this.sync()
  }

  private sync() {
    const fx = enabledFx(this.fxOf())
    const beat = this.held.size ? Math.max(0, ((this.now() - this.origin) / 1000) * (this.tempoOf() / 60)) : 0
    const instant = !fx.some((item) => item.kind === 'arp' || item.kind === 'repeat')
    const rendered = this.held.size
      ? applyMidiChain(
          [...this.held.entries()].map(([pitch, velocity]) => ({
            id: `live_${pitch}`,
            pitch,
            startBeat: 0,
            durationBeats: instant ? 1000 : 256,
            velocity,
          })),
          fx,
          this.ctxOf(),
        )
      : []
    const next = new Map<number, number>()
    for (const note of rendered) {
      const sounding = instant || (note.startBeat <= beat + 1e-3 && note.startBeat + note.durationBeats > beat + 1e-3)
      if (sounding) next.set(note.pitch, note.velocity)
    }
    for (const [pitch, velocity] of next) {
      if (!this.active.has(pitch)) this.sink.on(pitch, velocity)
    }
    for (const pitch of this.active.keys()) {
      if (!next.has(pitch)) this.sink.off(pitch)
    }
    this.active = next
  }

  private timed() {
    return enabledFx(this.fxOf()).some((item) => item.kind === 'arp' || item.kind === 'repeat')
  }

  private arm() {
    if (!this.timed() || this.cancel) return
    const tick = () => {
      this.sync()
      if (this.held.size) this.cancel = this.schedule(15, tick)
      else this.cancel = null
    }
    this.cancel = this.schedule(15, tick)
  }

  private disarm() {
    this.cancel?.()
    this.cancel = null
  }
}

function scaleAt(index: number | undefined): ScaleId {
  const found = SCALES[clamp(Math.round(index || 0), 0, SCALES.length - 1)]
  return found?.id ?? 'ionian'
}

function cloneNote(note: MidiNote): MidiNote {
  return {
    ...note,
    velocity: unitVel(note.velocity),
    locks: note.locks ? { ...note.locks } : undefined,
  }
}

function unitVel(value: number): number {
  if (!Number.isFinite(value)) return 0.8
  return value <= 1 ? clamp(value, 0, 1) : clamp(value / 127, 0, 1)
}

function hash(seed: number, index: number): number {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index + 1, 0xc2b2ae35)
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  return x >>> 0
}

function unit(value: number): number {
  return (value >>> 0) / 4294967295
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function numbers(record: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(record)) if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  return out
}

function isKind(value: unknown): value is MidiFxKind {
  return value === 'arp' || value === 'chord' || value === 'scale' || value === 'repeat' || value === 'humanize' || value === 'velocity'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

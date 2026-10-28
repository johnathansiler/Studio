/**
 * Kontakt / Omnisphere-style multi-sample program.
 * Audio bytes stay outside this object so a project can store the map
 * and stream samples later. Layered patches should wrap this, not replace it.
 */

export type SampleLicense = 'CC0-1.0' | 'Unlicense' | 'public-domain'
export type ZoneTrigger = 'attack' | 'release'
export type LoopMode = 'none' | 'one-shot' | 'loop' | 'sustain'
export type SampleFormat = 'wav' | 'pcm-s16le' | 'pcm-s24le' | 'float32'

export interface Ampeg {
  /** Seconds. */
  attack: number
  hold: number
  decay: number
  /** Linear 0–1. */
  sustain: number
  release: number
}

export interface MicPosition {
  id: string
  name: string
  /** Linear mix, 0–1. */
  gain: number
  /** -1 left, 1 right. */
  pan: number
  mute: boolean
}

export interface Keyswitch {
  key: number
  label: string
  articulation: string
}

/** Where a sample's PCM lives. Empty `url` means a local asset or a pack. */
export interface SampleRef {
  id: string
  url: string
  format: SampleFormat
  sampleRate: number
  channels: number
  /** First source frame inside a packed PCM blob. */
  frameOffset: number
  /** 0 reads the whole decoded file. */
  frameCount: number
  packId?: string
  /** Project audio asset filled in when the user imported the file. */
  bufferId?: string
  /** Byte range for an HTTPS partial fetch of raw PCM. */
  byteOffset?: number
  byteLength?: number
}

export interface SampleZone {
  id: string
  sampleId: string
  lokey: number
  hikey: number
  /** MIDI velocity, inclusive. 1–127. */
  lovel: number
  hivel: number
  root: number
  tuneCents: number
  /** 1 is equal temperament. SF2 scaleTuning / 100. */
  keytrack: number
  /** 1-based index inside a round-robin group. */
  seq: number
  seqLength: number
  /** cycle steps through seq. random picks a seq from the counter. */
  rrMode: 'cycle' | 'random'
  /** Zones that share a positive id alternate together. 0 alternates alone. */
  rrGroup: number
  /** Latched key that must match. Null plays under every articulation. */
  swLast: number | null
  swLo: number | null
  swHi: number | null
  trigger: ZoneTrigger
  /** Source frames. */
  offset: number
  /** 0 plays through the decoded buffer. */
  end: number
  loopMode: LoopMode
  loopStart: number
  loopEnd: number
  gainDb: number
  pan: number
  mic: string
  /** Non-zero choke class. A new voice in the class releases the others. */
  exclusive: number
  /** Released when a voice whose `exclusive` equals this starts. */
  offBy: number
  ampeg: Ampeg
}

export interface SamplerProgram {
  id: string
  name: string
  author: string
  license: SampleLicense
  defaultSwitch: number | null
  keyswitches: Keyswitch[]
  mics: MicPosition[]
  zones: SampleZone[]
  samples: SampleRef[]
  gainDb: number
  /** Polyphony cap. */
  voices: number
  /** Live overrides for the instrument panel. Absent keeps each zone's own envelope. */
  play?: InstrumentPlay
}

/** Knobs on a sampled instrument. Times are seconds. `tune` is semitones. `tone` is a lowpass in Hz. */
export interface InstrumentPlay {
  tune: number
  attack: number
  decay: number
  sustain: number
  release: number
  tone: number
}

export interface DecodedSample {
  sampleRate: number
  channels: Float32Array[]
}

/** SF2 (or any packed PCM) held so zones can decode one sample at a time. */
export interface SamplePack {
  id: string
  /** Little-endian 16-bit frames, or the high 16 bits when `sm24` is set. */
  pcm: ArrayBuffer
  /** Low 8 bits of 24-bit frames, one byte per frame per channel. */
  sm24?: ArrayBuffer
  channels: number
}

export interface MappedLayer {
  zone: SampleZone
  sample: SampleRef
  mic: MicPosition
  /** Musical ratio before sample-rate conversion. */
  tuneRatio: number
}

export interface MapQuery {
  note: number
  /** MIDI velocity 1–127. */
  velocity: number
  keyswitch: number | null
  /** Round-robin counters keyed by rr group. Not mutated. */
  roundRobin: Readonly<Record<number, number>>
  trigger: ZoneTrigger
}

export interface MapResult {
  layers: MappedLayer[]
  /** Round-robin groups that fired and should advance after a note-on. */
  advance: number[]
}

const DEFAULT_AMP: Ampeg = { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.03 }

let ids = 0

export function samplerId(prefix: string) {
  ids += 1
  return `${prefix}_${ids.toString(36)}`
}

export function clampMidi(note: number) {
  if (!Number.isFinite(note)) return 60
  return Math.max(0, Math.min(127, Math.round(note)))
}

/** DAW velocities are 0–1. Values above 1 are already MIDI. */
export function midiVelocity(velocity: number) {
  if (!(velocity > 0)) return 0
  if (velocity > 1) return Math.max(1, Math.min(127, Math.round(velocity)))
  return Math.max(1, Math.min(127, Math.round(velocity * 127)))
}

export function dbToAmp(db: number) {
  if (!Number.isFinite(db)) return 1
  return 10 ** (db / 20)
}

export function emptyAmpeg(): Ampeg {
  return { ...DEFAULT_AMP }
}

export function makeZone(partial: Partial<SampleZone> & Pick<SampleZone, 'id' | 'sampleId'>): SampleZone {
  return {
    lokey: 0,
    hikey: 127,
    lovel: 1,
    hivel: 127,
    root: 60,
    tuneCents: 0,
    keytrack: 1,
    seq: 1,
    seqLength: 1,
    rrGroup: 0,
    swLast: null,
    swLo: null,
    swHi: null,
    trigger: 'attack',
    offset: 0,
    end: 0,
    loopMode: 'none',
    loopStart: 0,
    loopEnd: 0,
    gainDb: 0,
    pan: 0,
    mic: 'main',
    exclusive: 0,
    offBy: 0,
    ...partial,
    rrMode: partial.rrMode === 'random' ? 'random' : 'cycle',
    ampeg: { ...DEFAULT_AMP, ...partial.ampeg },
  }
}

export function makeSample(partial: Partial<SampleRef> & Pick<SampleRef, 'id'>): SampleRef {
  return {
    url: '',
    format: 'wav',
    sampleRate: 0,
    channels: 1,
    frameOffset: 0,
    frameCount: 0,
    ...partial,
  }
}

export function mainMic(): MicPosition {
  return { id: 'main', name: 'Main', gain: 1, pan: 0, mute: false }
}

export function makeProgram(partial: Partial<SamplerProgram> & Pick<SamplerProgram, 'name'>): SamplerProgram {
  return {
    id: partial.id ?? samplerId('prg'),
    name: partial.name,
    author: partial.author ?? '',
    license: partial.license ?? 'CC0-1.0',
    defaultSwitch: partial.defaultSwitch ?? null,
    keyswitches: partial.keyswitches ?? [],
    mics: partial.mics?.length ? partial.mics : [mainMic()],
    zones: partial.zones ?? [],
    samples: partial.samples ?? [],
    gainDb: partial.gainDb ?? 0,
    voices: partial.voices ?? 32,
  }
}

export function emptyProgram(name = 'Empty library'): SamplerProgram {
  return makeProgram({ name, license: 'CC0-1.0' })
}

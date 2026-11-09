/** Map a Beat Machine pad onto the sample pool. The same calls run in Rust and TypeScript. */

import { padRegion, swingDelay, type PadVoice } from '../../model/padMachine'
import { scaleVintage, type ChopSetup, type ScaledVintage, type VintageState } from '../../model/padChop'
import type { PitchMode, VintageStage } from './engine'

export const PAD_FADE = 64

export interface BufferRef {
  id: string
  samples: Float32Array
  sampleRate: number
}

export interface PoolPad {
  setRegion(sampleId: number, start: number, end: number): void
  setFade(fadeIn: number, fadeOut: number): void
  setPitch(semis: number, cents: number, mode: PitchMode): void
  setVintage(stage: VintageStage): void
  setFilter(highpass: number, lowpass: number): void
  setChokeGroup(group: number): void
  setReverse(on: boolean): void
  setHold(on: boolean): void
  setSwing(samples: number): void
  setLevel(level: number, pan: number): void
}

export interface PoolLike {
  load(id: number, data: Float32Array, fileRate?: number): void
  pad(index: number): PoolPad
  note(offset: number, pad: number, velocity: number): void
  process(left: Float32Array, right: Float32Array): void
}

export interface SlotPlan {
  slot: number
  pitch: number
  sampleId: number
  start: number
  end: number
  semis: number
  cents: number
  mode: PitchMode
  chopSemi: number
  voiceTune: number
  filterAmount: number
  highpass: number
  lowpass: number
  choke: number
  reverse: boolean
  hold: boolean
  swing: number
  level: number
  pan: number
  loop: boolean
  busId: string
  fadeIn: number
  vintage: Required<VintageStage>
}

export interface PadPlan {
  samples: { id: number; key: string; samples: Float32Array; sampleRate: number }[]
  slots: SlotPlan[]
}

/**
 * Bit depth and sample rate for the Vintage knobs.
 * SP-1200's factory amounts (bits 0.85, rate 0.8) stay on the same steps the
 * voice already used: about 13-bit, and a hold of two at 48 kHz. The top of
 * each knob goes further, so the control is audible across its travel.
 */
export function vintageBitDepth(amount: number): number {
  const bits = unit(amount)
  if (bits <= 0.0001) return 0
  if (bits <= 0.85) return Math.max(4, Math.round(16 - (bits / 0.85) * 3))
  return Math.max(4, Math.round(13 - ((bits - 0.85) / 0.15) * 9))
}

export function vintageRateHz(amount: number): number {
  const rate = unit(amount)
  if (rate <= 0.0001) return 0
  if (rate <= 0.8) return 24000
  return Math.round(24000 - ((rate - 0.8) / 0.2) * (24000 - 4000))
}

export function vintageStage(scaled: ScaledVintage): Required<VintageStage> {
  const bits = unit(scaled.bits)
  const rate = unit(scaled.rate)
  const low = unit(scaled.lowpass)
  const wow = unit(scaled.wow)
  const crackle = unit(scaled.crackle)
  return {
    bitDepth: vintageBitDepth(bits),
    sampleRate: vintageRateHz(rate),
    wow,
    flutter: wow * 0.35,
    noise: crackle * 0.2,
    crackle,
    lowpass: low <= 0.0001 ? 0 : Math.round(18000 - low * 14000),
  }
}

export function filterHz(highpass: number, lowpass: number) {
  const hp = unit(highpass)
  const lp = unit(lowpass)
  return {
    highpass: hp <= 0.0001 ? 0 : Math.round(40 * 50 ** hp),
    lowpass: lp >= 0.98 ? 0 : Math.round(80 + lp * 16000),
  }
}

/** 50 is straight. Above that, delay this pad by the same fraction a 16th-note swing uses. */
export function swingSamples(percent: number | undefined, sampleRate: number, tempo: number) {
  if (percent == null || !(percent > 50)) return 0
  const grid = (sampleRate * 60) / Math.max(1, tempo) / 4
  return Math.max(0, Math.round(swingDelay(percent) * grid))
}

export function resolvePitch(pad: PadVoice, chop: ChopSetup | undefined) {
  const layer = pad.layers.find((item) => item.bufferId) ?? pad.layers[0]
  const layerTune = layer?.tune ?? 0
  const bufferId = layer?.bufferId
  const uses = Boolean(chop && bufferId && bufferId === chop.bufferId)
  const mode: PitchMode = uses && chop
    ? (chop.pitchMode === 'stretch' ? 'stretch' : 'vinyl')
    : (pad.pitchMode === 'stretch' ? 'stretch' : 'vinyl')
  const padTune = pad.tune || 0
  const padCents = pad.tuneCents ?? 0
  if (uses && chop) {
    const copied = Math.abs(padTune - chop.semitones) <= 0.001 && Math.abs(padCents - chop.cents) <= 0.001
    const extraSemi = copied ? 0 : padTune
    const extraCents = copied ? 0 : padCents
    return {
      semis: chop.semitones + extraSemi + layerTune,
      cents: chop.cents + extraCents,
      mode,
      chopSemi: chop.semitones,
      voiceTune: extraSemi + layerTune,
    }
  }
  return { semis: padTune + layerTune, cents: padCents, mode, chopSemi: 0, voiceTune: padTune + layerTune }
}

export function resolveHighpass(pad: PadVoice, chop: ChopSetup | undefined) {
  const bufferId = (pad.layers.find((item) => item.bufferId) ?? pad.layers[0])?.bufferId
  const uses = Boolean(chop && bufferId && bufferId === chop.bufferId)
  const own = pad.highpass ?? 0
  if (!uses || !chop) return own
  if (chop.highpass > 0 && Math.abs(own - chop.highpass) <= 0.001) return chop.highpass
  return Math.min(1, chop.highpass + own)
}

/** Decay shortens the window. Loop repeats that window. Attack lengthens the fade-in. */
export function playedWindow(
  data: Float32Array,
  region: { start: number; end: number; loop?: boolean },
  decay: number,
  attack: number,
  sampleRate: number,
) {
  const window = regionSamples(data.length, region.start, region.end)
  const span = Math.max(2, window.end - window.start)
  const length = Math.max(2, Math.round(span * clamp(decay, 0.05, 1)))
  const end = Math.min(data.length, window.start + length)
  const fadeIn = attack > 0.001
    ? Math.max(PAD_FADE, Math.round(clamp(attack, 0, 1) * 0.3 * Math.max(1, sampleRate)))
    : PAD_FADE
  if (!region.loop || end - window.start < 2) {
    return { samples: data, key: '', start: window.start, end, fadeIn }
  }
  const slice = data.subarray(window.start, end)
  const copies = Math.max(2, Math.min(8, Math.ceil((Math.max(1, sampleRate) * 1.5) / slice.length)))
  const looped = new Float32Array(slice.length * copies)
  for (let i = 0; i < copies; i++) looped.set(slice, i * slice.length)
  return { samples: looped, key: `loop:${window.start}:${end}:${copies}`, start: 0, end: looped.length, fadeIn }
}

export function regionSamples(length: number, startFraction: number, endFraction: number) {
  const n = Math.max(0, length | 0)
  if (n < 2) return { start: 0, end: n }
  const start = Math.floor(Math.min(1, Math.max(0, startFraction)) * n)
  const end = Math.min(n, Math.max(start + 2, Math.ceil(Math.max(startFraction, endFraction) * n)))
  return { start, end }
}

export function planPads(input: {
  pads: PadVoice[]
  buffers: BufferRef[]
  vintage?: VintageState
  chop?: ChopSetup
  sampleRate: number
  tempo: number
  resident?: { pitch: number; samples: Float32Array; sampleRate: number }[]
  pitches?: number[]
}): PadPlan {
  const byId = new Map(input.buffers.map((item) => [item.id, item]))
  const resident = new Map((input.resident ?? []).map((item) => [item.pitch, item]))
  const vintage = vintageStage(scaleVintage(input.vintage?.macro ?? 0, input.vintage?.table ?? {
    wow: { amount: 0, curve: 'linear' },
    crackle: { amount: 0, curve: 'linear' },
    lowpass: { amount: 0, curve: 'linear' },
    bits: { amount: 0, curve: 'linear' },
    rate: { amount: 0, curve: 'linear' },
  }))
  const ids = new Map<string, number>()
  const samples: PadPlan['samples'] = []
  const take = (key: string, data: Float32Array, sampleRate: number) => {
    const existing = ids.get(key)
    if (existing) return existing
    if (samples.length >= 32) return 0
    const id = samples.length + 1
    ids.set(key, id)
    samples.push({ id, key, samples: data, sampleRate })
    return id
  }
  const wanted = input.pitches
  const slots: SlotPlan[] = []
  const source = wanted
    ? wanted.map((pitch) => input.pads.find((pad) => pad.pitch === pitch)).filter((pad): pad is PadVoice => !!pad)
    : input.pads
  for (const pad of source) {
    if (slots.length >= 16 || pad.muted) continue
    const layer = pad.layers.find((item) => item.bufferId) ?? pad.layers[0]
    const asset = layer?.bufferId ? byId.get(layer.bufferId) : undefined
    const drum = !asset ? resident.get(pad.pitch) : undefined
    const data = asset?.samples ?? drum?.samples
    if (!data || data.length < 2) continue
    const key = asset ? asset.id : `resident:${pad.pitch}`
    const region = padRegion(pad)
    const opened = playedWindow(data, region, pad.decay ?? 1, pad.attack ?? 0, input.sampleRate)
    const sampleId = take(opened.key ? `${key}:${opened.key}` : key, opened.samples, asset?.sampleRate || drum?.sampleRate || input.sampleRate)
    if (!sampleId) continue
    const window = { start: opened.start, end: opened.end }
    const pitch = resolvePitch(pad, input.chop)
    const high = resolveHighpass(pad, input.chop)
    const hz = filterHz(high, pad.filter ?? 1)
    slots.push({
      slot: slots.length,
      pitch: pad.pitch,
      sampleId,
      start: window.start,
      end: window.end,
      semis: pitch.semis,
      cents: pitch.cents,
      mode: pitch.mode,
      chopSemi: pitch.chopSemi,
      voiceTune: pitch.voiceTune,
      filterAmount: pad.filter ?? 1,
      highpass: hz.highpass,
      lowpass: hz.lowpass,
      choke: pad.choke || 0,
      reverse: region.reverse,
      hold: pad.gate === 'hold',
      swing: swingSamples(pad.swing, input.sampleRate, input.tempo),
      level: pad.level ?? 1,
      pan: pad.pan ?? 0,
      loop: region.loop,
      busId: pad.busId || '',
      fadeIn: opened.fadeIn,
      vintage,
    })
  }
  return { samples, slots }
}

export function loadPlan(pool: PoolLike, plan: PadPlan) {
  for (const sample of plan.samples) pool.load(sample.id, sample.samples, sample.sampleRate)
}

export function applySlots(pool: PoolLike, plan: PadPlan) {
  for (const slot of plan.slots) {
    const pad = pool.pad(slot.slot)
    pad.setRegion(slot.sampleId, slot.start, slot.end)
    pad.setFade(slot.fadeIn || PAD_FADE, PAD_FADE)
    pad.setPitch(slot.semis, slot.cents, slot.mode)
    pad.setVintage(slot.vintage)
    pad.setFilter(slot.highpass, slot.lowpass)
    pad.setChokeGroup(slot.choke)
    pad.setReverse(slot.reverse)
    pad.setHold(slot.hold)
    pad.setSwing(slot.swing)
    pad.setLevel(slot.level, slot.pan)
  }
}

export function applyPlan(pool: PoolLike, plan: PadPlan) {
  loadPlan(pool, plan)
  applySlots(pool, plan)
}

export function hitVoice(slot: SlotPlan, color?: { tune?: number; filter?: number }) {
  const tune = color?.tune
  const semis = tune != null && Math.abs(tune - slot.voiceTune) > 0.001 ? slot.chopSemi + tune : slot.semis
  const filter = color?.filter
  const lowpass = filter != null && Math.abs(filter - slot.filterAmount) > 0.001
    ? filterHz(0, filter).lowpass
    : slot.lowpass
  return { semis, cents: slot.cents, mode: slot.mode, highpass: slot.highpass, lowpass }
}

function unit(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

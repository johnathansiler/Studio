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
  vintage: Required<VintageStage>
}

export interface PadPlan {
  samples: { id: number; key: string; samples: Float32Array; sampleRate: number }[]
  slots: SlotPlan[]
}

export function vintageStage(scaled: ScaledVintage): Required<VintageStage> {
  const bits = unit(scaled.bits)
  const rate = unit(scaled.rate)
  const low = unit(scaled.lowpass)
  const wow = unit(scaled.wow)
  const crackle = unit(scaled.crackle)
  return {
    bitDepth: bits <= 0.0001 ? 0 : Math.max(4, Math.round(16 - bits * 4)),
    sampleRate: rate <= 0.0001 ? 0 : Math.round(48000 - rate * (48000 - 26040)),
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
    const sampleId = take(key, data, asset?.sampleRate || drum?.sampleRate || input.sampleRate)
    if (!sampleId) continue
    const region = padRegion(pad)
    const window = regionSamples(data.length, region.start, region.end)
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
    pad.setFade(PAD_FADE, PAD_FADE)
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

/** Offline pad render. Voices come from the shared sample pool. */

import { createSamplePool } from '../../audio/voices/engine'
import { padRegion, type MpcOutput, type PadRegion, type PadVoice } from '../../model/padMachine'
import { samplesPerQuarter } from '../../model/time'
import { hearsAudio } from './model'

export interface PadBuffer {
  sampleRate: number
  samples: Float32Array
}

export interface MpcNote {
  pitch: number
  startBeat: number
  durationBeats: number
  velocity: number
}

/** The audible window. A full, forward region returns the same array. */
export function preparePadPcm(pcm: Float32Array, region: PadRegion): Float32Array {
  const length = pcm.length
  if (length < 2) return pcm
  const start = clamp(region.start, 0, 1)
  const end = Math.max(start, clamp(region.end, 0, 1))
  if (start <= 0.0001 && end >= 0.9999 && !region.reverse) return pcm
  let from = Math.floor(start * length)
  let to = Math.ceil(end * length)
  if (to - from < 2) {
    from = 0
    to = length
  }
  to = Math.min(length, Math.max(from + 2, to))
  const slice = pcm.subarray(from, to)
  if (!region.reverse) return Float32Array.from(slice)
  const reversed = new Float32Array(slice.length)
  for (let i = 0; i < slice.length; i++) reversed[i] = slice[slice.length - 1 - i] || 0
  return reversed
}

export function renderMpcAudio(opts: {
  sampleRate: number
  tempo: number
  notes: MpcNote[]
  pads: PadVoice[]
  buffers: Map<string, PadBuffer>
  output: MpcOutput
  /** When set, only pads routed to this bus are printed. */
  busId?: string
}): { left: Float32Array; right: Float32Array } {
  if (!hearsAudio(opts.output)) return { left: new Float32Array(0), right: new Float32Array(0) }
  const rate = Math.max(8000, opts.sampleRate)
  const tempo = Math.max(1, opts.tempo)
  const quarter = samplesPerQuarter(rate, tempo)
  let frames = Math.round(rate * 0.05)
  for (const note of opts.notes) {
    const at = Math.round(Math.max(0, note.startBeat) * quarter)
    const dur = Math.max(1, Math.round(Math.max(0.05, note.durationBeats) * quarter))
    frames = Math.max(frames, at + dur + Math.round(rate * 0.35))
  }
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const pool = createSamplePool(rate)
  const ids = new Map<string, number>()
  let nextId = 1
  for (const [key, buffer] of opts.buffers) {
    if (nextId > 32) break
    ids.set(key, nextId)
    pool.load(nextId, buffer.samples, buffer.sampleRate)
    nextId += 1
  }
  const padSlot = new Map<number, number>()
  let slot = 0
  const byPitch = new Map(opts.pads.map((pad) => [pad.pitch, pad]))
  for (const note of opts.notes) {
    const pad = byPitch.get(note.pitch)
    if (pad?.muted) continue
    if (opts.busId && (pad?.busId || '') !== opts.busId) continue
    if (padSlot.has(note.pitch) || slot >= 16) continue
    const layer = pad?.layers.find((item) => item.bufferId) ?? pad?.layers[0]
    const id = layer?.bufferId ? ids.get(layer.bufferId) ?? 0 : 0
    const asset = layer?.bufferId ? opts.buffers.get(layer.bufferId) : undefined
    if (!id || !asset) continue
    const region = padRegion(pad)
    const length = asset.samples.length
    const start = Math.floor(Math.max(0, Math.min(1, region.start)) * length)
    const end = Math.min(length, Math.max(start + 2, Math.ceil(Math.max(region.start, region.end) * length)))
    const voice = pool.pad(slot)
    voice.setRegion(id, start, end)
    voice.setPitch((pad?.tune ?? 0) + (layer?.tune ?? 0), 0, 'vinyl')
    voice.setReverse(region.reverse)
    voice.setHold(false)
    voice.setChokeGroup(pad?.choke ?? 0)
    voice.setLevel(pad?.level ?? 1, pad?.pan ?? 0)
    const filter = pad?.filter ?? 1
    if (filter < 0.98) voice.setFilter(0, 80 + Math.max(0, Math.min(1, filter)) * 16000)
    const swing = (pad as { swing?: number } | undefined)?.swing
    if (swing) voice.setSwing(swing)
    padSlot.set(note.pitch, slot)
    slot += 1
  }
  const events = opts.notes.flatMap((note) => {
    const at = padSlot.get(note.pitch)
    if (at == null) return []
    return [{ sample: Math.round(Math.max(0, note.startBeat) * quarter), pad: at, velocity: note.velocity }]
  })
  const block = 128
  for (let offset = 0; offset < frames; offset += block) {
    const count = Math.min(block, frames - offset)
    for (const event of events) {
      if (event.sample >= offset && event.sample < offset + count) pool.note(event.sample - offset, event.pad, event.velocity)
    }
    pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
  }
  return { left, right }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

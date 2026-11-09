/** Offline pad render. Voices come from the shared sample pool. */

import { createSamplePool } from '../../audio/voices/engine'
import { applyPlan, planPads } from '../../audio/voices/program'
import type { MpcOutput, PadRegion, PadVoice } from '../../model/padMachine'
import type { ChopSetup, VintageState } from '../../model/padChop'
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
  vintage?: VintageState
  chop?: ChopSetup
  resident?: { pitch: number; samples: Float32Array; sampleRate: number }[]
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
  const byPitch = new Map(opts.pads.map((pad) => [pad.pitch, pad]))
  const pitches: number[] = []
  for (const note of opts.notes) {
    const pad = byPitch.get(note.pitch)
    if (!pad || pad.muted) continue
    if (opts.busId && (pad.busId || '') !== opts.busId) continue
    if (!pitches.includes(note.pitch)) pitches.push(note.pitch)
  }
  const plan = planPads({
    pads: opts.pads,
    buffers: [...opts.buffers].map(([id, buffer]) => ({ id, samples: buffer.samples, sampleRate: buffer.sampleRate })),
    vintage: opts.vintage,
    chop: opts.chop,
    sampleRate: rate,
    tempo,
    pitches,
    resident: opts.resident,
  })
  applyPlan(pool, plan)
  const padSlot = new Map(plan.slots.map((slot) => [slot.pitch, slot.slot]))
  const held = new Set(plan.slots.filter((slot) => slot.hold).map((slot) => slot.slot))
  const events = opts.notes.flatMap((note) => {
    const at = padSlot.get(note.pitch)
    if (at == null) return []
    const sample = Math.round(Math.max(0, note.startBeat) * quarter)
    const hit = [{ sample, pad: at, velocity: note.velocity }]
    if (held.has(at)) {
      const dur = Math.max(1, Math.round(Math.max(0.05, note.durationBeats) * quarter))
      hit.push({ sample: sample + dur, pad: at, velocity: 0 })
    }
    return hit
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

/** One pad, baked through the same pool the live voice uses. Trailing silence is trimmed. */
export function renderPadVoice(opts: {
  sampleRate: number
  tempo: number
  pad: PadVoice
  buffers: Map<string, PadBuffer>
  vintage?: VintageState
  chop?: ChopSetup
  velocity?: number
  resident?: { pitch: number; samples: Float32Array; sampleRate: number }[]
}): { left: Float32Array; right: Float32Array } {
  const pad = { ...opts.pad, level: 1, pan: 0 }
  const rendered = renderMpcAudio({
    sampleRate: opts.sampleRate,
    tempo: opts.tempo,
    notes: [{ pitch: pad.pitch, startBeat: 0, durationBeats: 4, velocity: opts.velocity ?? 1 }],
    pads: [pad],
    buffers: opts.buffers,
    output: 'audio',
    vintage: opts.vintage,
    chop: opts.chop,
    resident: opts.resident,
  })
  return trimTail(rendered.left, rendered.right)
}

/** How much of a pad is added to a track send. Zero send or a disabled bus contributes nothing. */
export function padSendGain(padSend: number, busGain: number, enabled = true): number {
  if (!enabled) return 0
  const pad = Number.isFinite(padSend) ? Math.min(1, Math.max(0, padSend)) : 0
  const bus = Number.isFinite(busGain) ? Math.max(0, busGain) : 0
  return pad * bus
}

function trimTail(left: Float32Array, right: Float32Array) {
  let end = Math.min(left.length, right.length)
  while (end > 8 && Math.abs(left[end - 1] || 0) < 1e-4 && Math.abs(right[end - 1] || 0) < 1e-4) end -= 1
  end = Math.min(left.length, end + 8)
  if (end === left.length && end === right.length) return { left, right }
  return { left: left.slice(0, end), right: right.slice(0, end) }
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

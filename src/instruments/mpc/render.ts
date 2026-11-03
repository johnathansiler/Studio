/** Offline pad render. Playback uses the band-limited reader, then a soft ceiling. */

import { readPlayed, softClip } from '../../audio/sample/pitch'
import { padRegion, type MpcOutput, type PadRegion, type PadVoice } from '../../model/padMachine'
import { samplesPerQuarter } from '../../model/time'
import { hearsAudio, windowOf } from './model'

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
  const byPitch = new Map(opts.pads.map((pad) => [pad.pitch, pad]))
  for (const note of opts.notes) {
    const pad = byPitch.get(note.pitch)
    if (pad?.muted) continue
    if (opts.busId && (pad?.busId || '') !== opts.busId) continue
    mixPad(left, right, pad, note, rate, tempo, opts.buffers)
  }
  for (let i = 0; i < frames; i++) {
    left[i] = softClip(left[i] || 0)
    right[i] = softClip(right[i] || 0)
  }
  return { left, right }
}

function mixPad(
  left: Float32Array,
  right: Float32Array,
  pad: PadVoice | undefined,
  note: MpcNote,
  sampleRate: number,
  tempo: number,
  buffers: Map<string, PadBuffer>,
) {
  const region = padRegion(pad)
  const layer = pad?.layers.find((item) => item.bufferId) ?? pad?.layers[0]
  const asset = layer?.bufferId ? buffers.get(layer.bufferId) : undefined
  const source = asset?.samples
  if (!source?.length) return
  const pcm = preparePadPcm(source, region)
  if (pcm.length < 2) return
  const fileRate = asset?.sampleRate && asset.sampleRate > 0 ? asset.sampleRate : sampleRate
  const tune = (pad?.tune ?? 0) + (layer?.tune ?? 0)
  const speed = (fileRate / sampleRate) * 2 ** (tune / 12)
  const at = Math.round(Math.max(0, note.startBeat) * samplesPerQuarter(sampleRate, tempo))
  const dur = Math.max(1, Math.round(Math.max(0.05, note.durationBeats) * samplesPerQuarter(sampleRate, tempo)))
  const attack = Math.max(1, Math.round(((pad?.attack ?? 0) > 0 ? pad!.attack * 0.2 : 0.003) * sampleRate))
  const sustain = clamp(pad?.sustain ?? 1, 0, 1)
  const decay = Math.max(attack + 1, Math.round(dur * clamp(pad?.decay ?? 1, 0.05, 1)))
  const release = Math.max(1, Math.round(clamp(pad?.release ?? 0.1, 0, 2) * 0.25 * sampleRate))
  const loop = region.loop ? windowOf(region) : null
  const loopFrom = loop ? loop.start * (pcm.length - 1) : null
  const loopTo = loop ? Math.max((loopFrom ?? 0) + 2, loop.end * (pcm.length - 1)) : null
  const cutoff = 80 + clamp(pad?.filter ?? 1, 0, 1) * 16000
  const open = (pad?.filter ?? 1) >= 0.98
  const coeff = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)
  const angle = (clamp(pad?.pan ?? 0, -1, 1) + 1) * Math.PI * 0.25
  const gain = clamp(note.velocity, 0, 1) * clamp(pad?.level ?? 1, 0, 1)
  const leftGain = Math.cos(angle) * gain
  const rightGain = Math.sin(angle) * gain
  let low = 0
  let cursor = 0
  const end = Math.min(left.length, at + decay + release)
  for (let i = at; i < end; i++) {
    const env = envelope(i - at, attack, decay, sustain, release)
    let sample = readPlayed(pcm, cursor, speed, loopFrom, loopTo) * env
    cursor += speed
    if (!loop && cursor >= pcm.length - 1) break
    if (!open) {
      low += coeff * (sample - low)
      sample = low
    }
    left[i] += sample * leftGain
    right[i] += sample * rightGain
  }
}

function envelope(index: number, attack: number, decay: number, sustain: number, release: number) {
  if (index < attack) return index / attack
  if (index < decay) {
    const t = (index - attack) / Math.max(1, decay - attack)
    return 1 + (sustain - 1) * t
  }
  const t = (index - decay) / release
  return Math.max(0, sustain * (1 - t))
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

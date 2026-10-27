/** Local mastering analysis and genre chains. No network and no model API. */

import { createPlugin } from '../plugins/catalog'
import { dbToGain, designBiquad, tickBiquad } from '../plugins/dsp'
import type { PluginInstance } from '../../model/types'
import { measureProgram } from './meter'

export const MASTERING_IDS = ['meq', 'deq', 'mbcomp', 'glue', 'brick', 'maxim', 'mtape', 'image', 'msbox', 'clip', 'dither'] as const

export const GENRES = ['Pop', 'Hip-hop', 'Rock', 'EDM', 'Acoustic', 'Jazz', 'Classical', 'Club'] as const

export interface LoudnessTarget {
  id: string
  name: string
  lufs: number
  truePeak: number
}

export const LOUDNESS_TARGETS: LoudnessTarget[] = [
  { id: 'spotify', name: 'Spotify', lufs: -14, truePeak: -1 },
  { id: 'apple', name: 'Apple Music', lufs: -16, truePeak: -1 },
  { id: 'youtube', name: 'YouTube', lufs: -14, truePeak: -1 },
  { id: 'soundcloud', name: 'SoundCloud', lufs: -14, truePeak: -1 },
  { id: 'cd', name: 'CD', lufs: -9, truePeak: -0.1 },
  { id: 'club', name: 'Club', lufs: -6, truePeak: -0.3 },
]

export function targetById(id: string) {
  return LOUDNESS_TARGETS.find((target) => target.id === id) ?? LOUDNESS_TARGETS[0]
}

/** Pass when integrated loudness is within 1 LU and true peak is at or under the ceiling. */
export function targetVerdict(integrated: number, truePeak: number, target: LoudnessTarget) {
  if (!Number.isFinite(integrated) || integrated <= -60) return 'wait' as const
  const loudness = Math.abs(integrated - target.lufs) <= 1
  const peak = truePeak <= target.truePeak + 0.05
  return loudness && peak ? 'pass' as const : 'fail' as const
}

export function loudnessMatch(fromLufs: number, toLufs: number) {
  if (fromLufs <= -60 || toLufs <= -60) return 1
  return dbToGain(toLufs - fromLufs)
}

const CENTERS = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 12000]

const CURVES: Record<string, number[]> = {
  Pop: [0.5, 1, 0.4, 0, 0.2, 0.6, 1, 1.4, 1],
  'Hip-hop': [2.2, 2, 1, 0, -0.4, 0.2, 0.8, 1, 0.4],
  Rock: [0.6, 1.2, 0.6, 0, 0.4, 1, 0.8, 1.1, 0.5],
  EDM: [2, 1.6, 0.2, -0.4, 0.2, 1, 1.6, 2, 1.4],
  Acoustic: [0, 0.2, 0.4, 0.3, 0, 0.2, 0.4, 0.5, 0.2],
  Jazz: [0, 0.2, 0.2, 0, 0.1, 0.4, 0.2, 0.4, 0],
  Classical: [-0.4, 0, 0.2, 0.2, 0, 0, 0.2, 0.4, 0.2],
  Club: [2.4, 2.2, 1, 0, 0, 0.8, 1.8, 2, 1],
}

export interface MixReport {
  integrated: number
  shortTerm: number
  momentary: number
  lra: number
  truePeak: number
  rms: number
  crest: number
  correlation: number
  bands: number[]
  notes: string[]
}

function mean(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

export function octaveBands(channel: Float32Array, sampleRate: number) {
  const filters = CENTERS.map((freq) => designBiquad('bandpass', sampleRate, freq, 1.4))
  const energy = new Float32Array(CENTERS.length)
  const n = Math.min(channel.length, Math.round(sampleRate * 20))
  for (let i = 0; i < n; i++) {
    const sample = channel[i] || 0
    for (let band = 0; band < filters.length; band++) {
      const y = tickBiquad(filters[band], sample)
      energy[band] += y * y
    }
  }
  return Array.from(energy, (value) => (value > 1e-12 ? 10 * Math.log10(value / Math.max(1, n)) : -70))
}

export function analyzeMix(left: Float32Array, right: Float32Array | null, sampleRate: number, genre: string, target: LoudnessTarget): MixReport {
  const program = measureProgram(left, right, sampleRate)
  const bands = octaveBands(left, sampleRate)
  const curve = CURVES[genre] ?? CURVES.Pop
  const rel = bands.map((band) => band - mean(bands))
  const genreRel = curve.map((band) => band - mean(curve))
  const low = mean(genreRel.slice(0, 3)) - mean(rel.slice(0, 3))
  const high = mean(genreRel.slice(6)) - mean(rel.slice(6))
  const notes: string[] = []
  if (program.integrated > -60 && program.integrated < target.lufs - 1) notes.push('Quiet')
  if (program.integrated > target.lufs + 1) notes.push('Loud')
  if (program.truePeak > target.truePeak) notes.push('Peak')
  if (program.correlation > 0.9) notes.push('Narrow')
  if (program.correlation < 0.2) notes.push('Wide')
  if (low > 1.5) notes.push('Dark')
  if (high > 1.5) notes.push('Dull')
  if (!notes.length) notes.push('Balanced')
  return { ...program, bands, notes }
}

function clampGain(value: number) {
  return Math.max(-6, Math.min(6, value))
}

export function matchEq(mix: Float32Array, reference: Float32Array, sampleRate: number) {
  const a = octaveBands(mix, sampleRate)
  const b = octaveBands(reference, sampleRate)
  const ar = a.map((band) => band - mean(a))
  const br = b.map((band) => band - mean(b))
  return {
    lowG: clampGain(mean(br.slice(0, 3)) - mean(ar.slice(0, 3))),
    midG: clampGain(mean(br.slice(3, 6)) - mean(ar.slice(3, 6))),
    highG: clampGain(mean(br.slice(6)) - mean(ar.slice(6))),
    midF: 1200,
  }
}

function withParams(pluginId: string, params: Record<string, number>): PluginInstance {
  const plugin = createPlugin(pluginId)
  plugin.params = { ...plugin.params, ...params }
  return plugin
}

/** EQ, glue, tape, imager, maximizer, then the true-peak limiter. */
export function buildChain(report: MixReport | null, genre: string, intensity: number, target: LoudnessTarget): PluginInstance[] {
  const amount = Math.max(0, Math.min(1, intensity))
  const curve = CURVES[genre] ?? CURVES.Pop
  const bands = report?.bands ?? curve.map(() => -40)
  const rel = bands.map((band) => band - mean(bands))
  const genreRel = curve.map((band) => band - mean(curve))
  const scale = 0.35 + amount * 0.65
  const lowG = clampGain((mean(genreRel.slice(0, 3)) - mean(rel.slice(0, 3))) * scale)
  const midG = clampGain((mean(genreRel.slice(3, 6)) - mean(rel.slice(3, 6))) * scale)
  const highG = clampGain((mean(genreRel.slice(6)) - mean(rel.slice(6))) * scale)
  const crest = report?.crest ?? 12
  const correlation = report?.correlation ?? 0.8
  const ratio = 1.4 + amount * (crest > 12 ? 2.4 : 1.2)
  const threshold = Math.max(-28, Math.min(-8, (report?.rms ?? -18) - 4 - amount * 4))
  let width = 1
  if (correlation > 0.85) width = 1 + 0.4 * amount
  if (correlation < 0.2) width = 1 - 0.3 * amount
  const bass = genre === 'Classical' || genre === 'Jazz' || genre === 'Acoustic' ? 80 : 120
  return [
    withParams('meq', { phase: 1, ms: 0, lowG, midG, highG, midF: 1400, hp: bass === 80 ? 30 : 35 }),
    withParams('glue', { threshold, ratio, attack: 10, release: 120, releaseMode: 1, makeup: amount * 2, mix: 0.8 }),
    withParams('mtape', { drive: 0.12 + amount * 0.35, color: genre === 'Rock' || genre === 'Jazz' ? 1 : 0, mix: 0.45 + amount * 0.25 }),
    withParams('image', { width, bass, low: 0.85, high: width }),
    withParams('maxim', { target: target.lufs, ceiling: target.truePeak }),
    withParams('brick', { ceiling: target.truePeak, release: 80, lookahead: 5, releaseMode: 1 }),
    withParams('dither', { bits: 24, shape: 1 }),
  ]
}

export function presetChain(genre: string, intensity: number, target: LoudnessTarget) {
  return buildChain(null, genre, intensity, target)
}

export function chainOrder(plugins: PluginInstance[]) {
  return plugins.map((plugin) => plugin.pluginId)
}

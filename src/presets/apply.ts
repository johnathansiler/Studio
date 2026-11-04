import type { PadProgram } from '../model/padMachine'
import type { BeatPattern, StepCell } from '../model/steps'
import { emptyCell } from '../model/steps'
import type { ScalerState } from '../instruments/scaler/types'
import { defaultScaler } from '../instruments/scaler/types'

const SCALES = new Set(['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'harmonicMinor', 'melodicMinor', 'majorPentatonic', 'minorPentatonic', 'blues'])
const GROUPS = new Set(['triad', 'seventh', 'ninth', 'sus', 'add', 'altered'])
const VOICINGS = new Set(['close', 'drop2', 'drop3', 'spread', 'shell', 'rootless'])
const SOUNDS = new Set(['synth', 'sampler', '808', 'drum-machine', 'library', 'forward'])
const ARPS = new Set(['off', 'up', 'down', 'upDown', 'random'])

export function scalerPatch(params: Record<string, number>, text: Record<string, string> | undefined): Partial<ScalerState> {
  const base = defaultScaler()
  const scale = text?.scale && SCALES.has(text.scale) ? text.scale : base.scale
  const group = text?.group && GROUPS.has(text.group) ? text.group : base.group
  const voicing = text?.voicing && VOICINGS.has(text.voicing) ? text.voicing : base.voicing
  const sound = text?.sound && SOUNDS.has(text.sound) ? text.sound : base.sound
  const arp = text?.arp && ARPS.has(text.arp) ? text.arp : base.arp
  return {
    root: Math.round(params.root ?? base.root),
    inversion: Math.round(params.inversion ?? base.inversion),
    gate: params.gate ?? base.gate,
    rate: params.rate ?? base.rate,
    swing: params.swing ?? base.swing,
    octaves: Math.round(params.octaves ?? base.octaves),
    snap: (params.snap ?? 0) >= 0.5,
    voiceLead: (params.voiceLead ?? 1) >= 0.5,
    scale: scale as ScalerState['scale'],
    group: group as ScalerState['group'],
    voicing: voicing as ScalerState['voicing'],
    sound: sound as ScalerState['sound'],
    arp: arp as ScalerState['arp'],
    rhythm: 'block',
    library: '',
    performanceId: '',
  }
}

function paint(cells: StepCell[], steps: number[]): StepCell[] {
  const next = cells.map((cell) => ({ ...emptyCell(), ...cell, on: false }))
  for (const step of steps) {
    if (step >= 0 && step < next.length) next[step] = { ...emptyCell(), on: true, velocity: 0.9, gate: 0.8 }
  }
  return next
}

export function readGroove(pattern: BeatPattern): Record<string, number> {
  const params: Record<string, number> = { swing: pattern.swing }
  const kick = pattern.channels.find((channel) => channel.kind === 'kick')
  const snare = pattern.channels.find((channel) => channel.kind === 'snare')
  const hat = pattern.channels.find((channel) => channel.kind === 'hat')
  for (let step = 0; step < 16; step += 1) {
    params[`k${step}`] = kick?.cells[step]?.on ? 1 : 0
    params[`s${step}`] = snare?.cells[step]?.on ? 1 : 0
    params[`h${step}`] = hat?.cells[step]?.on ? 1 : 0
  }
  return params
}

export function applyGroove(pattern: BeatPattern, params: Record<string, number>): BeatPattern {
  const kicks: number[] = []
  const snares: number[] = []
  const hats: number[] = []
  for (let step = 0; step < 16; step += 1) {
    if ((params[`k${step}`] ?? 0) >= 0.5) kicks.push(step)
    if ((params[`s${step}`] ?? 0) >= 0.5) snares.push(step)
    if ((params[`h${step}`] ?? 0) >= 0.5) hats.push(step)
  }
  return {
    ...pattern,
    swing: params.swing ?? pattern.swing,
    channels: pattern.channels.map((channel) => {
      if (channel.kind === 'kick') return { ...channel, cells: paint(channel.cells, kicks) }
      if (channel.kind === 'snare') return { ...channel, cells: paint(channel.cells, snares) }
      if (channel.kind === 'hat') return { ...channel, cells: paint(channel.cells, hats) }
      return channel
    }),
  }
}

export function readKit(kit: PadProgram): Record<string, number> {
  const pad = kit.banks[0]?.[0]
  return {
    tune: pad?.tune ?? 0,
    decay: pad?.decay ?? 1,
    attack: pad?.attack ?? 0,
    swing: kit.swing ?? 50,
    humanize: kit.humanizeTime ?? 0,
    level: pad?.level ?? 0.8,
  }
}

export function applyKit(kit: PadProgram, params: Record<string, number>): PadProgram {
  const tune = params.tune ?? 0
  const decay = params.decay ?? 1
  const attack = params.attack ?? 0
  const level = params.level ?? 0.8
  return {
    ...kit,
    swing: params.swing ?? kit.swing,
    humanizeTime: params.humanize ?? kit.humanizeTime,
    banks: kit.banks.map((row, bank) => bank === 0
      ? row.map((pad) => ({ ...pad, tune, decay, attack, level }))
      : row.map((pad) => ({ ...pad }))),
  }
}

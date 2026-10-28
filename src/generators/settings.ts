import { clamp } from './rng'
import { styleById, STYLES } from './styles'
import type { ArpPattern, GeneratorChord, GeneratorKind, GeneratorSettings, StrumPattern } from './types'

const KINDS: GeneratorKind[] = ['chords', 'bass', 'melody', 'arp', 'rhythm', 'drums']
const ARPS: ArpPattern[] = ['up', 'down', 'upDown', 'downUp', 'inside', 'outside', 'broken', 'random']
const STRUMS: StrumPattern[] = ['block', 'down', 'folk', 'skank', 'funk', 'disco', 'jazz', 'tresillo', 'rock', 'afro', 'gospel', 'montuno']

export function defaultGenerator(): GeneratorSettings {
  const pop = styleById('pop')
  return {
    kind: 'chords',
    style: 'pop',
    bars: 4,
    seed: 1,
    variation: 0,
    arpPattern: pop.arp.pattern,
    rate: pop.arp.rate,
    octaves: pop.arp.octaves,
    gate: pop.arp.gate,
    strum: pop.strum,
    chords: [],
  }
}

export function normalizeGenerator(value: Partial<GeneratorSettings> | undefined): GeneratorSettings {
  const base = defaultGenerator()
  if (!value) return base
  const style = STYLES.some((item) => item.id === value.style) ? (value.style as string) : base.style
  const preset = styleById(style)
  return {
    kind: KINDS.includes(value.kind as GeneratorKind) ? (value.kind as GeneratorKind) : base.kind,
    style,
    bars: clamp(Math.round(value.bars ?? base.bars), 1, 32),
    seed: Number.isFinite(value.seed) ? (value.seed as number) >>> 0 : base.seed,
    variation: Math.max(0, Math.round(value.variation ?? 0)),
    arpPattern: ARPS.includes(value.arpPattern as ArpPattern) ? (value.arpPattern as ArpPattern) : preset.arp.pattern,
    rate: clamp(value.rate ?? preset.arp.rate, 0.125, 1),
    octaves: clamp(Math.round(value.octaves ?? preset.arp.octaves), 1, 3),
    gate: clamp(value.gate ?? preset.arp.gate, 0.1, 1),
    strum: STRUMS.includes(value.strum as StrumPattern) ? (value.strum as StrumPattern) : preset.strum,
    chords: sanitizeChords(value.chords),
  }
}

function sanitizeChords(chords: GeneratorChord[] | undefined): GeneratorChord[] {
  if (!Array.isArray(chords)) return []
  return chords
    .filter((chord) => chord && Array.isArray(chord.pitches) && chord.pitches.length && Number.isFinite(chord.beats))
    .slice(0, 64)
    .map((chord) => ({
      pitches: chord.pitches.filter((pitch) => Number.isFinite(pitch)).map((pitch) => Math.round(pitch)).slice(0, 8),
      ...(Array.isArray(chord.cents) ? { cents: chord.cents.filter((cent) => Number.isFinite(cent)).slice(0, 8) } : {}),
      beats: clamp(chord.beats, 0.25, 64),
      ...(typeof chord.symbol === 'string' ? { symbol: chord.symbol.slice(0, 24) } : {}),
      ...(Number.isFinite(chord.root) ? { root: ((Math.round(chord.root as number) % 12) + 12) % 12 } : {}),
    }))
    .filter((chord) => chord.pitches.length > 0)
}

import { clamp } from '../generators/rng'
import { STYLES } from '../generators/styles'
import type { PlayerSettings } from './types'

export function defaultPlayers(): PlayerSettings {
  return {
    style: 'pop',
    complexity: 0.5,
    loudness: 0.75,
    fills: 0.55,
    startBar: 0,
    endBar: 8,
    followSections: true,
    drummer: true,
    bass: true,
    keys: true,
    seed: 1,
  }
}

export function normalizePlayer(value: Partial<PlayerSettings> | undefined): PlayerSettings {
  const base = defaultPlayers()
  if (!value) return base
  const style = STYLES.some((item) => item.id === value.style) ? (value.style as string) : base.style
  const startBar = clamp(Math.round(value.startBar ?? base.startBar), 0, 256)
  const length = clamp(Math.round((value.endBar ?? startBar + 8) - startBar), 1, 64)
  return {
    style,
    complexity: clamp(value.complexity ?? base.complexity, 0, 1),
    loudness: clamp(value.loudness ?? base.loudness, 0, 1),
    fills: clamp(value.fills ?? base.fills, 0, 1),
    startBar,
    endBar: startBar + length,
    followSections: value.followSections !== false,
    drummer: value.drummer !== false,
    bass: value.bass !== false,
    keys: value.keys !== false,
    seed: Number.isFinite(value.seed) ? (value.seed as number) >>> 0 : base.seed,
  }
}

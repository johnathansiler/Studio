import { clamp } from '../generators/rng'
import { STYLES } from '../generators/styles'
import type { PlayerSettings } from './types'

/** Built-in bass fade-in. Same length as `ATTACK_SEC` in the live stage (4 ms). */
export const BASS_PLAYER_ATTACK_MS = 4

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
    bassAttack: BASS_PLAYER_ATTACK_MS,
    seed: 1,
  }
}

/** Attack time for a Bass track or a clip named like the bass player. Null for every other track. */
export function bassPlayerAttackMs(project: { players?: Partial<PlayerSettings> }, track: { name: string; midiClips?: { name: string }[] }): number | null {
  const named = track.name === 'Bass' || !!track.midiClips?.some((clip) => clip.name.endsWith('bass player'))
  if (!named) return null
  const raw = project.players?.bassAttack
  const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : BASS_PLAYER_ATTACK_MS
  return clamp(ms, 0, 2000)
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
    bassAttack: clamp(value.bassAttack ?? base.bassAttack, 0, 2000),
    seed: Number.isFinite(value.seed) ? (value.seed as number) >>> 0 : base.seed,
  }
}

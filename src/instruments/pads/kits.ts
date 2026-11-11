/** Curated Beat Machine kits built from the pinned SoundScout catalog. */

import { BEAT_KITS, type BeatKit, type KitVoice } from './kitData'

export type { BeatKit, KitVoice }
export { BEAT_KITS }

export interface ResolvedVoice extends KitVoice {
  id: string
  name: string
  path: string
}

const ROLE_WORD: Record<string, RegExp> = {
  kick: /\b(kick|808|909)\b/i,
  snare: /\bsnare\b/i,
  rim: /\brim\b/i,
  clap: /\bclaps?\b/i,
  hat: /\b(hi-?hat|closed hat|hat)\b/i,
  open: /\b(open hat|openhat|open)\b/i,
  tom: /\btoms?\b/i,
  crash: /\b(crash|cymbal)\b/i,
  ride: /\bride\b/i,
  tamb: /\btamb/i,
  cow: /\bcow/i,
  conga: /\bconga\b/i,
  clave: /\bclave\b/i,
}

export function beatKitByPreset(name: string): BeatKit | null {
  if (name === 'Init' || name === '808') return BEAT_KITS.find((kit) => kit.id === '808') ?? null
  return BEAT_KITS.find((kit) => kit.preset === name) ?? null
}

export function resolveBeatKit(kit: BeatKit, entries: { id: string; name: string; path: string }[]): ResolvedVoice[] | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const voices: ResolvedVoice[] = []
  for (const voice of kit.voices) {
    const entry = byId.get(voice.soundId)
    if (!entry) return null
    voices.push({ ...voice, id: entry.id, name: entry.name, path: entry.path })
  }
  return voices
}

/** The 808 kit, when every sample id is in the catalog passed in. */
export function defaultKitPicks(entries: { id: string; name: string; path: string }[]): ResolvedVoice[] | null {
  const kit = beatKitByPreset('Init')
  if (!kit) return null
  return resolveBeatKit(kit, entries)
}

/** Pad level after the preset level. Kick scale is 1, so the preset readout stays put. */
export function voiceLevel(baseLevel: number, levelScale: number) {
  const level = (Number.isFinite(baseLevel) ? baseLevel : 0.8) * (Number.isFinite(levelScale) ? levelScale : 1)
  return Math.min(1, Math.max(0, level))
}

/**
 * Pad decay after the preset decay.
 * A long kit (decay near 1) uses the role scale so hats stay short.
 * A tight preset is already short, so the role scale only nudges it.
 */
export function voiceDecay(baseDecay: number, decayScale: number) {
  const base = Math.min(1, Math.max(0.05, Number.isFinite(baseDecay) ? baseDecay : 1))
  const scale = Math.min(1, Math.max(0.05, Number.isFinite(decayScale) ? decayScale : 1))
  const mixed = base > 0.7 ? scale : 0.65 + 0.35 * scale
  return Math.min(1, Math.max(0.05, base * mixed))
}

export function soundHay(entry: { name: string; tags?: string[]; category?: string }) {
  return `${entry.name} ${(entry.tags ?? []).join(' ')} ${entry.category ?? ''}`
}

/** One-shots short enough to be a pad hit whose name, tags, or category name this role. */
export function dedicatedRoleEntries<T extends { name: string; tags?: string[]; category?: string; type?: string; durationSec?: number }>(
  entries: T[],
  role: string,
) {
  const pattern = ROLE_WORD[role]
  if (!pattern) return []
  return entries.filter((entry) => {
    if (entry.type && entry.type !== 'one-shot') return false
    if (entry.durationSec != null && entry.durationSec > 2.5) return false
    const name = entry.name ?? ''
    const tags = (entry.tags ?? []).join(' ')
    const category = entry.category ?? ''
    if (role !== 'kick' && category === 'kick' && !pattern.test(name)) return false
    return pattern.test(`${name} ${tags} ${category}`)
  })
}

/** True when this catalog row is an acceptable sample for the pad role. */
export function voiceMatchesRole(role: string, entry: { name: string; tags?: string[]; category?: string; type?: string }, dedicated: { id?: string }[]) {
  const hay = soundHay(entry)
  if (role === 'kick') return ROLE_WORD.kick.test(hay)
  if (role === 'rim') return ROLE_WORD.rim.test(hay)
  if (dedicated.length > 0) return ROLE_WORD[role]?.test(hay) ?? false
  if (entry.type && entry.type !== 'one-shot') return false
  if (entry.category && entry.category !== 'kick') return false
  return ROLE_WORD.kick.test(hay)
}

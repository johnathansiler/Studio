/** Curated Beat Machine kits built from the pinned SoundScout catalog. */

import { BEAT_KITS, type BeatKit, type KitVoice } from './kitData'

export type { BeatKit, KitVoice }
export { BEAT_KITS }

/** Preset a new Beat Machine loads. Init stays the classic 808 preset and keeps its stored place. */
export const DEFAULT_BEAT_PRESET = 'Boom Bap Trap'

/**
 * Catalog categories that satisfy a pad role.
 * The drum one-shot folder uses these names. Percussion pads share `perc` and still need distinct sample ids.
 */
export const ROLE_CATEGORY: Record<string, readonly string[]> = {
  kick: ['kick'],
  snare: ['snare'],
  rim: ['rim'],
  clap: ['clap'],
  hat: ['hat-closed'],
  open: ['hat-open'],
  tom: ['tom'],
  crash: ['crash'],
  ride: ['ride'],
  tamb: ['perc'],
  cow: ['perc'],
  conga: ['perc'],
  clave: ['perc'],
}

export function categoryMatchesRole(role: string, category: string | undefined): boolean {
  if (!category) return false
  return ROLE_CATEGORY[role]?.includes(category) ?? false
}

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
  return BEAT_KITS.find((kit) => kit.preset === name) ?? null
}

function roleKey(role: string) {
  return role.trim().toLowerCase().replace(/_/g, '-')
}

/** True when the pad role is the catalog drumRole, or the category is that role. */
export function roleMatchesSample(role: string, entry: { drumRole?: string; category?: string }) {
  const wanted = roleKey(role)
  if (entry.drumRole && roleKey(entry.drumRole) === wanted) return true
  return categoryMatchesRole(wanted, entry.category)
}

export function resolveBeatKit(kit: BeatKit, entries: { id: string; name: string; path: string }[]): ResolvedVoice[] | null {
  const inspected = inspectBeatKit(kit, entries)
  if (inspected.some((voice) => voice.missing)) return null
  return inspected
}

export interface InspectedVoice extends ResolvedVoice {
  /** True when this pad's catalog id is empty or not in the catalog that was passed in. */
  missing: boolean
}

/** One row per pad. A missing id stays in the list so the loader can show an error. */
export function inspectBeatKit(kit: BeatKit, entries: { id: string; name: string; path: string }[]): InspectedVoice[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  return kit.voices.map((voice) => {
    const entry = voice.soundId ? byId.get(voice.soundId) : undefined
    return {
      ...voice,
      id: entry?.id ?? voice.soundId,
      name: entry?.name ?? '',
      path: entry?.path ?? '',
      missing: !entry,
    }
  })
}

export interface FactorySampleEntry {
  id: string
  sha256?: string
  category?: string
  type?: string
  drumRole?: string
}

/** Reasons a factory kit is not yet a set of distinct catalog drums. Empty when the data swap is done. */
export function factoryKitSampleIssues(kits: BeatKit[], entries: FactorySampleEntry[]): string[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const issues: string[] = []
  for (const kit of kits) {
    const ids = new Set<string>()
    const hashes = new Set<string>()
    for (const voice of kit.voices) {
      const where = `${kit.preset} pad ${voice.index} (${voice.role})`
      if (!voice.soundId) {
        issues.push(`${where} has no catalog id`)
        continue
      }
      if (ids.has(voice.soundId)) issues.push(`${where} reuses ${voice.soundId}`)
      ids.add(voice.soundId)
      const entry = byId.get(voice.soundId)
      if (!entry) {
        issues.push(`${where} id ${voice.soundId} is not in the catalog`)
        continue
      }
      if (entry.type && entry.type !== 'one-shot') issues.push(`${where} is ${entry.type}, not a one-shot`)
      if (entry.sha256) {
        if (hashes.has(entry.sha256)) issues.push(`${where} reuses the same audio as another pad`)
        hashes.add(entry.sha256)
      }
      if (!roleMatchesSample(voice.role, entry)) issues.push(`${where} does not match drum role ${entry.drumRole ?? '(none)'} or category ${entry.category ?? '(none)'}`)
    }
  }
  return issues
}

/** The default kit, when every sample id is in the catalog passed in. */
export function defaultKitPicks(entries: { id: string; name: string; path: string }[]): ResolvedVoice[] | null {
  const kit = beatKitByPreset(DEFAULT_BEAT_PRESET)
  if (!kit) return null
  return resolveBeatKit(kit, entries)
}

/**
 * Pad level scale from catalog loudness.
 * Pad 0 passes a reference equal to itself, so its scale stays 1.
 * A quieter pad is raised only as far as its peak headroom allows, so the file is not rewritten.
 */
export function evenLevelScale(rmsDb: number | undefined, peakDb: number | undefined, referenceRms: number | undefined) {
  if (rmsDb == null || referenceRms == null || !Number.isFinite(rmsDb) || !Number.isFinite(referenceRms)) return 1
  let db = referenceRms - rmsDb
  const headroom = peakDb == null || !Number.isFinite(peakDb) ? 6 : Math.max(0, -peakDb)
  if (db > 0) db = Math.min(db, headroom)
  db = Math.max(-12, Math.min(12, db))
  return Math.min(4, Math.max(0.2, 10 ** (db / 20)))
}

/** Fraction of the file to skip so an unaltered hit starts at the transient. */
export function leadStartFraction(leadSilenceMs: number | undefined, durationSec: number | undefined) {
  if (!(leadSilenceMs && leadSilenceMs > 0) || !(durationSec && durationSec > 0)) return 0
  return Math.min(0.25, (leadSilenceMs / 1000) / durationSec)
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

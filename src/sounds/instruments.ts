import { selectLayers } from '../audio/multisample/map'
import { fetchCatalog, fetchInstrument, STARTER_CATALOG, type LibraryEntry } from '../audio/multisample/library'
import { libraryBaseUrl } from '../audio/multisample/source'
import type { SamplePack, SamplerProgram } from '../audio/multisample/types'
import { midiVelocity } from '../audio/multisample/types'
import type { SoundQuery } from './types'

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>

type PitchZone = { trigger?: string; root: number; lokey: number; hikey: number; lovel?: number; hivel?: number }
type PitchProgram = {
  zones: PitchZone[]
  samples?: SamplerProgram['samples']
  keyswitches?: { key: number }[]
  defaultSwitch?: number | null
}

/** A note inside the first playable zone. Middle C is silent on instruments that start higher. */
function geometricPitch(program: { zones: PitchZone[] }) {
  const zone = program.zones.find((item) => item.trigger !== 'release' && item.hikey >= item.lokey) ?? program.zones[0]
  if (!zone) return 60
  if (zone.root >= zone.lokey && zone.root <= zone.hikey) return zone.root
  return Math.min(zone.hikey, Math.max(zone.lokey, 60))
}

export function playablePitch(program: PitchProgram) {
  return playableAudition(program).pitch
}

/**
 * A pitch and velocity the preset can sound.
 * High velocity is preferred so the audition uses the full layer, not a quiet one that would be silent at a normal touch.
 */
export function playableAudition(program: PitchProgram): { pitch: number; velocity: number } {
  const geometric = geometricPitch(program)
  if (!program.samples?.length) return { pitch: geometric, velocity: 0.9 }
  const full = program as SamplerProgram
  const switches = new Set((full.keyswitches ?? []).map((item) => item.key))
  const sounds = (pitch: number, velocity: number) => {
    if (switches.has(Math.round(pitch))) return false
    return selectLayers(full, {
      note: pitch,
      velocity,
      keyswitch: full.defaultSwitch ?? null,
      roundRobin: {},
      trigger: 'attack',
    }).layers.length > 0
  }
  const candidates: number[] = []
  const push = (pitch: number) => {
    const note = Math.round(pitch)
    if (!Number.isFinite(note) || switches.has(note) || candidates.includes(note)) return
    candidates.push(note)
  }
  for (const zone of full.zones) {
    if (zone.trigger === 'release' || zone.hikey < zone.lokey) continue
    if (zone.root >= zone.lokey && zone.root <= zone.hikey) push(zone.root)
    else push(Math.min(zone.hikey, Math.max(zone.lokey, 60)))
  }
  for (const pitch of candidates) {
    if (sounds(pitch, midiVelocity(0.9))) return { pitch, velocity: 0.9 }
  }
  for (const zone of full.zones) {
    if (zone.trigger === 'release' || zone.hikey < zone.lokey) continue
    const pitch = zone.root >= zone.lokey && zone.root <= zone.hikey ? zone.root : Math.min(zone.hikey, Math.max(zone.lokey, 60))
    if (switches.has(Math.round(pitch))) continue
    const midi = Math.max(1, Math.min(zone.hivel || 127, Math.max(zone.lovel || 1, 64)))
    if (sounds(pitch, midi)) return { pitch, velocity: Math.max(0.05, Math.min(1, midi / 127)) }
  }
  return { pitch: candidates[0] ?? geometric, velocity: 0.9 }
}

let catalogRequest: Promise<LibraryEntry[]> | null = null

function sameAsBuiltin(entries: LibraryEntry[]) {
  const builtin = STARTER_CATALOG.map((entry) => entry.id).join('\n')
  return entries.map((entry) => entry.id).join('\n') === builtin
}

/** One shared catalog fetch. A fallback to the four built-in names is not cached, so the next open tries again. */
export function starterCatalog() {
  if (!catalogRequest) {
    catalogRequest = fetchCatalog(libraryBaseUrl()).then((entries) => {
      if (sameAsBuiltin(entries)) catalogRequest = null
      return entries
    })
  }
  return catalogRequest
}

export function refreshStarterCatalog() {
  catalogRequest = null
  return starterCatalog()
}

/** Starter instruments ignore tempo and key. Those filters describe loops. */
export function filterStarters(entries: LibraryEntry[], query: Pick<SoundQuery, 'text' | 'type' | 'favoritesOnly' | 'favorites'>) {
  if (query.type !== 'all' && query.type !== 'instrument') return []
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return entries
    .filter((entry) => {
      if (query.favoritesOnly && !query.favorites.includes(entry.id)) return false
      if (!tokens.length) return true
      const hay = `${entry.name} ${entry.description} ${entry.category ?? ''} ${(entry.tags ?? []).join(' ')} ${entry.id}`.toLowerCase()
      return tokens.every((token) => hay.includes(token))
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

export interface StarterHost {
  setLibrary(trackId: string, program: SamplerProgram | null): void
  holdLibraryPack?(trackId: string, pack: SamplePack): void
  auditionLibrary?(trackId: string, pitch?: number, velocity?: number): Promise<void>
}

/**
 * Keep engine methods on the engine.
 * Passing `engine.auditionLibrary` bare makes `this` the host object, so `this.unlock` throws.
 */
export function boundLibraryHost(
  engine: Pick<StarterHost, 'holdLibraryPack' | 'auditionLibrary'>,
  setLibrary: StarterHost['setLibrary'],
  audition = true,
): StarterHost {
  return {
    setLibrary,
    holdLibraryPack: engine.holdLibraryPack
      ? (trackId, pack) => engine.holdLibraryPack!(trackId, pack)
      : undefined,
    auditionLibrary: audition && engine.auditionLibrary
      ? (trackId, pitch, velocity) => engine.auditionLibrary!(trackId, pitch, velocity)
      : undefined,
  }
}

/** Names the track header still uses before a real instrument is chosen. */
const PLACEHOLDER_TRACK = /^(keys|sampler|library|synth|drums?|808|inst|audio)( \d+)?$/i

export function placeholderInstrumentName(name: string, previous?: string) {
  const trimmed = name.trim()
  if (!trimmed) return true
  if (previous && trimmed === previous.trim()) return true
  return PLACEHOLDER_TRACK.test(trimmed)
}

/** Download one starter preset and install it on an instrument track. Samples stay on Hugging Face. */
export async function loadStarterOnto(
  entry: LibraryEntry,
  trackId: string,
  host: StarterHost,
  options?: { audition?: boolean; pitch?: number; velocity?: number; fetchImpl?: FetchLike },
) {
  const imported = await fetchInstrument(libraryBaseUrl(), entry, options?.fetchImpl)
  if (imported.pack && host.holdLibraryPack) host.holdLibraryPack(trackId, imported.pack)
  host.setLibrary(trackId, imported.program)
  if (options?.audition !== false && host.auditionLibrary) {
    const choice = options?.pitch != null
      ? { pitch: options.pitch, velocity: options.velocity ?? 0.9 }
      : playableAudition(imported.program)
    await host.auditionLibrary(trackId, choice.pitch, choice.velocity)
  }
  return imported
}

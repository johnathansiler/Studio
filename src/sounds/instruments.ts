import { fetchInstrument, type LibraryEntry } from '../audio/multisample/library'
import type { SamplePack, SamplerProgram } from '../audio/multisample/types'
import { libraryBaseUrl } from '../audio/multisample/source'
import type { SoundQuery } from './types'

type FetchLike = (input: string, init?: { headers?: Record<string, string> }) => Promise<Response>

/** A note the preset can actually sound. Middle C is silent on instruments that start higher. */
export function playablePitch(program: { zones: { trigger?: string; root: number; lokey: number; hikey: number }[] }) {
  const zone = program.zones.find((item) => item.trigger !== 'release' && item.hikey >= item.lokey) ?? program.zones[0]
  if (!zone) return 60
  if (zone.root >= zone.lokey && zone.root <= zone.hikey) return zone.root
  return Math.min(zone.hikey, Math.max(zone.lokey, 60))
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
  auditionLibrary?(trackId: string, pitch?: number): Promise<void>
}

/** Download one starter preset and install it on an instrument track. Samples stay on Hugging Face. */
export async function loadStarterOnto(
  entry: LibraryEntry,
  trackId: string,
  host: StarterHost,
  options?: { audition?: boolean; pitch?: number; fetchImpl?: FetchLike },
) {
  const imported = await fetchInstrument(libraryBaseUrl(), entry, options?.fetchImpl)
  if (imported.pack && host.holdLibraryPack) host.holdLibraryPack(trackId, imported.pack)
  host.setLibrary(trackId, imported.program)
  if (options?.audition !== false && host.auditionLibrary) {
    await host.auditionLibrary(trackId, options?.pitch ?? playablePitch(imported.program))
  }
  return imported
}

/** Load the default CC0 drum kit from the CueHarbor library on Hugging Face. */

import { fetchSoundBytes, soundCache } from '../../sounds/cache'
import { loadSoundCatalog } from '../../sounds/catalog'
import { decodeSoundBytes } from '../../sounds/place'
import { soundFileUrl } from '../../sounds/source'
import type { ProjectStore } from '../../state/store'
import { pickDefaultKit } from './record'

const loading = new Set<string>()

/** Fills empty bank A pads. A pad that already has a sample is left alone. */
export async function ensureDefaultKit(store: ProjectStore, trackId: string): Promise<void> {
  if (loading.has(trackId)) return
  const kit = store.trackKit(trackId)
  if (kit.banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  loading.add(trackId)
  try {
    const catalog = await loadSoundCatalog(fetch, soundCache())
    const picks = pickDefaultKit(catalog.entries)
    for (const pick of picks) {
      try {
        const bytes = await fetchSoundBytes(soundFileUrl(pick.path))
        const decoded = await decodeSoundBytes(bytes)
        const samples = decoded.channels[0]
        if (!samples?.length) continue
        const current = store.trackKit(trackId).banks[0]?.[pick.index]
        if (current?.layers.some((layer) => layer.bufferId)) continue
        store.assignTrackPad(trackId, 0, pick.index, {
          name: pick.name,
          samples,
          sampleRate: decoded.sampleRate,
        })
      } catch {
        /* This pad keeps its resident drum until a sample is dropped on it. */
      }
    }
  } catch {
    /* The library can be offline. Resident drums still play. */
  } finally {
    loading.delete(trackId)
  }
}

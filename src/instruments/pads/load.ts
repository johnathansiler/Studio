/** Fill an empty Beat Machine from the curated kit. A saved kit is left alone. */

import { soundCache } from '../../sounds/cache'
import { fetchCatalogSound, loadSoundCatalog } from '../../sounds/catalog'
import { decodeSoundBytes } from '../../sounds/place'
import type { ProjectStore } from '../../state/store'
import { beatKitByPreset, resolveBeatKit, voiceDecay, voiceLevel, type ResolvedVoice } from './kits'

const loading = new Set<string>()
const generation = new Map<string, number>()

function nextGeneration(trackId: string) {
  const token = (generation.get(trackId) ?? 0) + 1
  generation.set(trackId, token)
  return token
}

function liveToken(trackId: string, token: number) {
  return generation.get(trackId) === token
}

/** Fills empty bank A pads. A pad that already has a sample is left alone. */
export async function ensureDefaultKit(store: ProjectStore, trackId: string): Promise<void> {
  if (loading.has(trackId)) return
  const kit = store.trackKit(trackId)
  if (kit.banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  const token = nextGeneration(trackId)
  loading.add(trackId)
  try {
    await loadKitSamples(store, trackId, 'Init', token, false)
  } catch {
    /* The library can be offline. Resident drums still play. */
  } finally {
    loading.delete(trackId)
  }
}

/** Replace bank A with the factory kit for this preset name. Unknown names leave the samples. */
export async function applyPadKitSamples(store: ProjectStore, trackId: string, presetName: string): Promise<void> {
  const token = nextGeneration(trackId)
  try {
    await loadKitSamples(store, trackId, presetName, token, true)
  } catch {
    /* The current kit keeps playing when a preset cannot be fetched. */
  }
}

async function loadKitSamples(store: ProjectStore, trackId: string, presetName: string, token: number, replace: boolean) {
  const kit = beatKitByPreset(presetName)
  if (!kit) return
  const catalog = await loadSoundCatalog(fetch, soundCache())
  if (!liveToken(trackId, token)) return
  const voices = resolveBeatKit(kit, catalog.entries)
  if (!voices) return
  if (!replace && store.trackKit(trackId).banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  const prepared: { index: number; name: string; samples?: Float32Array; sampleRate?: number; level: number; tune: number; decay: number }[] = []
  await Promise.all(voices.map(async (voice) => {
    if (!liveToken(trackId, token)) return
    const row = store.trackKit(trackId).banks[0]?.[0]
    const level = voiceLevel(row?.level ?? 0.8, voice.levelScale)
    const decay = voiceDecay(row?.decay ?? 1, voice.decayScale)
    const tune = row?.tune ?? 0
    const current = store.trackKit(trackId).banks[0]?.[voice.index]
    if (!replace && current?.layers.some((layer) => layer.bufferId)) return
    if (current?.sampleName === voice.name && current.layers.some((layer) => layer.bufferId)) {
      prepared.push({ index: voice.index, name: voice.name, level, tune, decay })
      return
    }
    const entry = catalog.entries.find((item) => item.id === voice.id)
    if (!entry) return
    try {
      const bytes = await fetchCatalogSound(entry)
      const decoded = await decodeSoundBytes(bytes)
      const samples = decoded.channels[0]
      if (!samples?.length) return
      prepared.push({ index: voice.index, name: voice.name, samples, sampleRate: decoded.sampleRate, level, tune, decay })
    } catch {
      /* This pad keeps the voice it already has. */
    }
  }))
  if (!liveToken(trackId, token)) return
  if (!prepared.length) return
  if (!replace && store.trackKit(trackId).banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  const base = store.trackKit(trackId).banks[0]?.[0]
  const leveled = prepared.map((pad) => {
    const voice = voices.find((item) => item.index === pad.index) as ResolvedVoice
    return {
      ...pad,
      level: voiceLevel(base?.level ?? pad.level, voice.levelScale),
      decay: voiceDecay(base?.decay ?? pad.decay, voice.decayScale),
      tune: base?.tune ?? pad.tune,
    }
  })
  store.placePadKit(trackId, 0, leveled)
}

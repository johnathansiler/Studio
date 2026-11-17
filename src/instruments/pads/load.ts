/** Fill an empty Beat Machine from the curated kit. A saved kit is left alone. */

import { soundInfoLine } from '../../sounds/license'
import { soundCache } from '../../sounds/cache'
import { fetchCatalogSound, loadSoundCatalog } from '../../sounds/catalog'
import { decodeSoundBytes } from '../../sounds/place'
import { commitChoice, presetByName, readStamp } from '../../presets/library'
import { commitPadPreset } from '../../presets/project'
import { DRUM_PADS } from '../../model/drums'
import type { ProjectStore } from '../../state/store'
import {
  DEFAULT_BEAT_PRESET,
  beatKitByPreset,
  evenLevelScale,
  inspectBeatKit,
  leadStartFraction,
  voiceDecay,
  voiceLevel,
} from './kits'

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

export function catalogPadError(label: string, soundId: string, reason: 'missing' | 'empty' | 'failed') {
  if (!soundId) return `${label} has no catalog sample yet. This pad stays quiet.`
  if (reason === 'missing') return `${label} is not in this sound library (${soundId}). This pad stays quiet.`
  if (reason === 'empty') return `${label} sample had no audio (${soundId}). This pad stays quiet.`
  return `Could not load ${label} (${soundId}). This pad stays quiet.`
}

/** Fills empty bank A pads on a new kit. A pad that already has a sample is left alone. */
export async function ensureDefaultKit(store: ProjectStore, trackId: string): Promise<void> {
  if (loading.has(trackId)) return
  const kit = store.trackKit(trackId)
  if (kit.banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  if (!kit.catalogDrums) return
  if (!readStamp(store.project.presets, `pads:${trackId}`)) {
    const preset = presetByName('pads', store.project.presets, DEFAULT_BEAT_PRESET)
    if (preset) {
      const committed = commitChoice(store.project.presets, `pads:${trackId}`, preset)
      commitPadPreset(store, trackId, committed.params, committed.presets)
    }
  }
  const token = nextGeneration(trackId)
  loading.add(trackId)
  try {
    await loadKitSamples(store, trackId, DEFAULT_BEAT_PRESET, token, false)
  } catch {
    stampFailure(store, trackId, token, 'The sound library did not load. This pad stays quiet.')
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
    stampFailure(store, trackId, token, 'The sound library did not load. This pad stays quiet.')
  }
}

function stampFailure(store: ProjectStore, trackId: string, token: number, message: string) {
  if (!liveToken(trackId, token)) return
  const kit = store.trackKit(trackId)
  if (!kit.catalogDrums) return
  const pads = kit.banks[0].map((pad, index) => ({
    index,
    name: message,
    error: pad.sampleError || message,
    catalog: true,
  }))
  store.placePadKit(trackId, 0, pads)
  store.toast(message, 'warn')
}

async function loadKitSamples(store: ProjectStore, trackId: string, presetName: string, token: number, replace: boolean) {
  const kit = beatKitByPreset(presetName)
  if (!kit) return
  if (!replace && store.trackKit(trackId).banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  const blockResident = replace || store.trackKit(trackId).catalogDrums === true
  const catalog = await loadSoundCatalog(fetch, soundCache())
  if (!liveToken(trackId, token)) return
  if (!replace && store.trackKit(trackId).banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  const voices = inspectBeatKit(kit, catalog.entries)
  const byId = new Map(catalog.entries.map((entry) => [entry.id, entry]))
  const reference = byId.get(voices[0]?.soundId ?? '')
  const base = store.trackKit(trackId).banks[0]?.[0]
  const prepared: {
    index: number
    name: string
    samples?: Float32Array
    sampleRate?: number
    level: number
    tune: number
    decay: number
    catalog?: boolean
    error?: string
    credit?: string
    start?: number
    preserve?: boolean
  }[] = []
  const errors: string[] = []
  await Promise.all(voices.map(async (voice) => {
    if (!liveToken(trackId, token)) return
    const entry = voice.soundId ? byId.get(voice.soundId) : undefined
    const levelScale = voice.index === 0 ? 1 : evenLevelScale(entry?.rmsDb, entry?.peakDb, reference?.rmsDb ?? entry?.rmsDb)
    const level = voiceLevel(base?.level ?? 0.8, Number.isFinite(levelScale) ? levelScale : voice.levelScale)
    const decay = voiceDecay(base?.decay ?? 1, voice.decayScale)
    const tune = base?.tune ?? 0
    const label = DRUM_PADS[voice.index]?.name ?? voice.role
    const credit = entry ? soundInfoLine(entry) : ''
    const start = leadStartFraction(entry?.leadSilenceMs, entry?.durationSec)
    const current = store.trackKit(trackId).banks[0]?.[voice.index]
    if (!replace && current?.layers.some((layer) => layer.bufferId)) return
    const fail = (reason: 'missing' | 'empty' | 'failed') => {
      if (!blockResident) return
      const error = catalogPadError(label, voice.soundId, reason)
      errors.push(error)
      prepared.push({ index: voice.index, name: error, error, catalog: true, level, tune, decay, credit: credit || undefined })
    }
    if (!entry) {
      fail('missing')
      return
    }
    if (current?.sampleName === voice.name && current.layers.some((layer) => layer.bufferId) && !current.sampleError) {
      prepared.push({ index: voice.index, name: voice.name, catalog: true, level, tune, decay, credit: credit || current.sampleCredit, start })
      return
    }
    try {
      const bytes = await fetchCatalogSound(entry)
      const decoded = await decodeSoundBytes(bytes)
      const samples = decoded.channels[0]
      if (!samples?.length) {
        fail('empty')
        return
      }
      prepared.push({
        index: voice.index,
        name: voice.name,
        samples,
        sampleRate: decoded.sampleRate,
        level,
        tune,
        decay,
        catalog: true,
        credit: credit || undefined,
        start,
        preserve: true,
      })
    } catch {
      fail('failed')
    }
  }))
  if (!liveToken(trackId, token)) return
  if (!prepared.length) return
  if (!replace && store.trackKit(trackId).banks[0]?.some((pad) => pad.layers.some((layer) => layer.bufferId))) return
  store.placePadKit(trackId, 0, prepared)
  if (errors.length === 1) store.toast(errors[0], 'warn')
  else if (errors.length) store.toast(`${presetName}: ${errors.length} pads could not load a drum sample. Those pads stay quiet.`, 'warn')
}

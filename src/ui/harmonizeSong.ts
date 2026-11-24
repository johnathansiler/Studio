import { monoMix } from '../analysis/mix'
import { publishedLibraryEntry } from '../library/place'
import { recentSounds } from '../library/recent'
import {
  harmonizeGate,
  harmonizeRows,
  retargetHarmonize,
  type HarmonizeMeta,
  type HarmonizeRow,
  type HeardKey,
} from '../model/harmonize'
import type { MusicalKey } from '../model/keyFit'
import type { AudioClip } from '../model/types'
import type { ProjectStore } from '../state/store'

export interface HarmonizeProgress {
  phase: 'listen' | 'shift'
  done: number
  total: number
  name: string
}

export function metaForBuffer(store: ProjectStore, bufferId: string): HarmonizeMeta | null {
  const ref = store.project.libraryFiles?.find((item) => item.bufferId === bufferId)
  if (!ref) return null
  const entry = publishedLibraryEntry(ref.key) ?? recentSounds().find((row) => row.library?.key === ref.key)?.library ?? null
  if (!entry) return { key: ref.key }
  return {
    type: entry.type,
    category: entry.category,
    tags: entry.tags,
    musicalKey: entry.musicalKey,
    instrument: entry.instrument,
    name: entry.name,
    key: entry.key,
  }
}

/** Open the key picker, or explain why there is nothing melodic to move. */
export function askHarmonize(store: ProjectStore) {
  const rows = harmonizeRows(store.project, (bufferId) => metaForBuffer(store, bufferId), new Map(), { includeVocals: false })
  const gate = harmonizeGate(rows)
  if (!gate.open) {
    store.toast(gate.toast, 'warn')
    return false
  }
  store.openHarmonizeSheet()
  return true
}

export async function resolveHarmonizeRows(
  store: ProjectStore,
  options: { includeVocals: boolean; onProgress?: (progress: HarmonizeProgress) => void },
): Promise<HarmonizeRow[]> {
  const metaFor = (bufferId: string) => metaForBuffer(store, bufferId)
  const preview = harmonizeRows(store.project, metaFor, new Map(), options)
  const pending = preview.filter((row) => row.action === 'listen')
  const heard = new Map<string, HeardKey | null>()
  let done = 0
  for (const row of pending) {
    options.onProgress?.({ phase: 'listen', done, total: pending.length, name: row.name })
    const clip = store.track(row.trackId)?.clips.find((item) => item.id === row.clipId)
    heard.set(row.clipId, clip ? await hearClip(store, row.trackId, clip) : { clear: false, root: null, minor: false, label: 'No clear key' })
    done += 1
    options.onProgress?.({ phase: 'listen', done, total: pending.length, name: row.name })
    await yieldFrame()
  }
  return harmonizeRows(store.project, metaFor, heard, options)
}

/** Cache each audio move on the pitch worker, then commit every clip in one undo. */
export async function runHarmonizeSong(
  store: ProjectStore,
  rows: HarmonizeRow[],
  target: MusicalKey,
  onProgress?: (progress: HarmonizeProgress) => void,
) {
  const shifts = retargetHarmonize(rows, target).filter((row): row is Extract<HarmonizeRow, { action: 'shift' }> => row.action === 'shift')
  if (!shifts.length) {
    store.toast('Nothing to shift. Turn on Include vocals, or drop a melodic loop.', 'warn')
    return false
  }
  if (store.remoteFollow) {
    store.toast('The host has the session.', 'warn')
    return false
  }
  const audible = shifts.filter((row) => row.kind === 'audio' && row.semitones !== 0)
  let done = 0
  for (const shift of audible) {
    onProgress?.({ phase: 'shift', done, total: audible.length, name: shift.name })
    await cacheShift(store, shift.trackId, shift.clipId, shift.semitones)
    done += 1
    onProgress?.({ phase: 'shift', done, total: audible.length, name: shift.name })
    await yieldFrame()
  }
  store.applyHarmonizeSong({ root: target.root, minor: target.minor, shifts })
  store.toast(`Harmonized to ${target.label}`)
  return true
}

async function cacheShift(store: ProjectStore, trackId: string, clipId: string, semitones: number) {
  const clip = store.track(trackId)?.clips.find((item) => item.id === clipId)
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  if (!clip || !asset?.channels?.length) return
  try {
    const { cacheFormantPitch } = await import('../audio/stretch/pitchJob')
    const stretch = clip.stretch
    await cacheFormantPitch({
      channels: asset.channels,
      bufferId: clip.bufferId,
      offsetSamples: clip.offsetSamples,
      sourceSamples: stretch?.sourceSamples || clip.durationSamples,
      sampleRate: store.project.sampleRate,
      semitones,
      cents: 0,
      formant: true,
      mode: stretch?.mode === 'tonal' ? 'tonal' : 'pro',
    })
  } catch {
    /* Playback renders the same in-house shift if the cache misses. */
  }
}

async function hearClip(store: ProjectStore, trackId: string, clip: AudioClip): Promise<HeardKey> {
  const asset = store.buffers.get(clip.bufferId)
  if (!asset?.channels.length) return { clear: false, root: null, minor: false, label: 'No clear key' }
  const offset = Math.max(0, clip.offsetSamples || 0)
  const source = Math.max(1, clip.stretch?.sourceSamples || clip.durationSamples)
  const slices = asset.channels
    .map((channel) => channel.subarray(offset, Math.min(channel.length, offset + source)))
    .filter((channel) => channel.length > 0)
  if (!slices.length) return { clear: false, root: null, minor: false, label: 'No clear key' }
  try {
    const { detectKeyOffThread } = await import('../analysis/keyJob')
    const heard = await detectKeyOffThread(monoMix(slices), asset.sampleRate)
    if (!heard.clear || heard.root == null || (heard.scale !== 'ionian' && heard.scale !== 'aeolian')) {
      return { clear: false, root: null, minor: false, label: 'No clear key' }
    }
    const minor = heard.scale === 'aeolian'
    const label = heard.label && heard.label !== 'No clear key'
      ? heard.label
      : `${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][heard.root]} ${minor ? 'minor' : 'major'}`
    store.rememberLoopKey(trackId, clip.id, label)
    return { clear: true, root: heard.root, minor, label }
  } catch {
    return { clear: false, root: null, minor: false, label: 'No clear key' }
  }
}

function yieldFrame() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

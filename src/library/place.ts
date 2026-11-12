import { parseNote } from '../audio/multisample/sfz'
import { decodeSlotBytes, decodeSlotFile, focusedSlot } from '../audio/sample/slot'
import type { AudioAsset } from '../model/types'
import { placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
import type { ProjectStore } from '../state/store'
import { fetchLibraryBytes } from './audio'
import { midiName, summarizeInstrument, type LibraryInstrument } from './group'
import { fetchLibraryInstrument } from './instrumentsApi'
import { programFromLibraryInstrument } from './instrumentProgram'
import { rememberLibraryInstrument, rememberLibrarySound } from './recent'
import { librarySampleUrl, loadLibrarySampleBytes } from './samples'
import type { LibraryEntry } from './types'

const registry = new Map<string, LibraryEntry>()

export function libraryBufferId(key: string) {
  let high = 2166136261
  let low = 2166136261 ^ 0x9e3779b9
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i)
    high ^= code
    high = Math.imul(high, 16777619)
    low ^= code
    low = Math.imul(low, 2246822519)
  }
  return `r2_${(high >>> 0).toString(36)}_${(low >>> 0).toString(36)}`
}

function midiRoot(entry: LibraryEntry) {
  const parsed = parseNote(entry.note) ?? parseNote(entry.root)
  return parsed == null ? undefined : parsed
}

function padsHost(store: ProjectStore) {
  const open = store.padsTrackId
  if (open && store.track(open)?.type === 'midi') return open
  return store.project.tracks.find((track) => track.type === 'midi' && track.instrument === 'pads')?.id ?? null
}

export function publishLibrary(entries: LibraryEntry[]) {
  registry.clear()
  for (const entry of entries) registry.set(entry.key, entry)
}

export function libraryDragId(entry: LibraryEntry) {
  return `library:${entry.key}`
}

export function libraryEntryForDrag(id: string) {
  if (!id.startsWith('library:')) return null
  return registry.get(id.slice('library:'.length)) ?? null
}

export async function readLibraryAsset(entry: LibraryEntry, decode?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>): Promise<AudioAsset> {
  const bytes = await fetchLibraryBytes(entry.key)
  const decoded = await (decode ?? decodeSlotFile)(bytes)
  if (!decoded.channels[0]?.length) throw new Error('That sound had no audio.')
  return {
    id: libraryBufferId(entry.key),
    name: entry.name,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
  }
}

function asSound(entry: LibraryEntry, sampleRate: number): SoundEntry {
  const type = entry.type === 'loop' ? 'loop' : entry.type === 'instrument' ? 'instrument' : 'one-shot'
  return {
    id: libraryBufferId(entry.key),
    path: entry.key,
    name: entry.name,
    type,
    tags: entry.tags,
    bpm: entry.bpm ?? undefined,
    key: entry.musicalKey || undefined,
    durationSec: 0,
    sampleRate,
    license: entry.license || 'private',
    source: 'My Library',
    category: entry.category || undefined,
    pack: entry.pack || undefined,
    origin: 'private',
  }
}

function emptyPad(store: ProjectStore, trackId: string) {
  const kit = store.trackKit(trackId)
  const bank = kit.activeBank || 0
  const row = kit.banks[bank] ?? []
  const index = row.findIndex((pad) => !pad.layers.some((layer) => layer.bufferId))
  return { bank, index: index >= 0 ? index : 0 }
}

/**
 * Put a library sound where audio already loads.
 * An open sampler or looper wins. Loops go on the arrangement.
 * Multisample notes go on an instrument track. One-shots and effects go on a Beat Machine pad.
 */
export function placeLibraryAsset(store: ProjectStore, entry: LibraryEntry, asset: AudioAsset, startSample: number) {
  store.addAsset(asset)
  store.rememberLibrarySound(asset.id, entry.key)
  const slot = focusedSlot(store)
  if (slot) {
    store.loadSlotAudio(slot.trackId, slot.pluginId, asset)
    rememberLibrarySound(entry)
    return `${entry.name} is in the ${slot.kind}.`
  }
  if (entry.type === 'loop') {
    const placed = placeSound({
      entry: asSound(entry, asset.sampleRate),
      channels: asset.channels,
      fileRate: asset.sampleRate,
      project: store.project,
      startSample: 0,
      bufferId: asset.id,
    })
    if (!placed) throw new Error('That sound had no audio.')
    store.addAsset(placed.asset)
    const selected = store.selectedTrackId ? store.track(store.selectedTrackId) : null
    const host = selected?.type === 'audio' ? selected.id : null
    const landed = store.placeClipAtPlayhead(host, placed.clip, startSample)
    if (!landed) throw new Error('Could not add that sound onto the track.')
    rememberLibrarySound(entry)
    return `${entry.name} is on the track.`
  }
  if (entry.type === 'multisample note') {
    const selected = store.selectedTrackId ? store.track(store.selectedTrackId) : null
    const host = selected?.type === 'midi' && selected.instrument !== 'pads' ? selected.id : null
    const trackId = host ?? store.addTracks({ kind: 'midi', count: 1, instrument: 'sampler', input: 'mic', channels: 1, armed: false })[0]
    if (!trackId) throw new Error('Could not add an instrument track.')
    store.loadSamplerSound(trackId, asset, midiRoot(entry), false)
    rememberLibrarySound(entry)
    return `${entry.name} plays across the keyboard.`
  }
  const trackId = store.insertPads(padsHost(store))
  if (!trackId) throw new Error('Could not open Beat Machine.')
  const pad = emptyPad(store, trackId)
  store.assignTrackPad(trackId, pad.bank, pad.index, { name: entry.name, bufferId: asset.id })
  rememberLibrarySound(entry)
  return `${entry.name} is on a pad.`
}

async function decodeLibraryBytes(bytes: ArrayBuffer, decode?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>) {
  if (decode) return decode(bytes)
  const lossless = decodeSlotBytes(bytes)
  if (lossless?.channels[0]?.length) return { sampleRate: lossless.sampleRate, channels: lossless.channels }
  return decodeSlotFile(bytes)
}

/** One note around C4, for the row preview. The rest of the instrument stays unloaded. */
export async function previewLibraryInstrument(instrument: { id: string; previewKey: string }, decode?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>) {
  const bytes = await loadLibrarySampleBytes(librarySampleUrl(instrument.id, instrument.previewKey))
  const decoded = await decodeLibraryBytes(bytes, decode)
  if (!decoded.channels[0]?.length) throw new Error('That note had no audio.')
  return decoded
}

/**
 * Put every sampled note on the keyboard.
 * Keys that were not sampled play the nearest root, pitched.
 */
export async function loadGroupedLibraryInstrument(store: ProjectStore, id: string) {
  const instrument = await fetchLibraryInstrument(id)
  return placeLibraryInstrument(store, instrument)
}

export function placeLibraryInstrument(store: ProjectStore, instrument: LibraryInstrument) {
  const program = programFromLibraryInstrument(instrument)
  const selected = store.selectedTrackId ? store.track(store.selectedTrackId) : null
  const host = selected?.type === 'midi' && selected.instrument !== 'pads' ? selected.id : null
  const trackId = host ?? store.addTracks({ kind: 'midi', count: 1, instrument: 'sampler', input: 'mic', channels: 1, armed: false })[0]
  if (!trackId) throw new Error('Could not add an instrument track.')
  store.setLibrary(trackId, program)
  rememberLibraryInstrument(summarizeInstrument(instrument))
  const span = instrument.notes <= 1 ? `Root ${midiName(instrument.previewMidi)}` : `${midiName(instrument.lo)}–${midiName(instrument.hi)}`
  return `${instrument.name} plays across the keyboard. ${span}.`
}

export async function loadLibraryEntry(store: ProjectStore, entry: LibraryEntry, startSample: number, decode?: (bytes: ArrayBuffer) => Promise<{ sampleRate: number; channels: Float32Array[] }>) {
  const asset = await readLibraryAsset(entry, decode)
  return placeLibraryAsset(store, entry, asset, startSample)
}

export async function loadLibraryDrag(store: ProjectStore, dragId: string, startSample: number, pad?: { trackId: string; bank: number; index: number }) {
  const entry = libraryEntryForDrag(dragId)
  if (!entry) return false
  const asset = await readLibraryAsset(entry)
  if (pad) {
    store.addAsset(asset)
    store.rememberLibrarySound(asset.id, entry.key)
    store.assignTrackPad(pad.trackId, pad.bank, pad.index, { name: entry.name, bufferId: asset.id })
    rememberLibrarySound(entry)
    return true
  }
  placeLibraryAsset(store, entry, asset, startSample)
  return true
}

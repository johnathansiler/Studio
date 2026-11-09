import { renderClipChannels } from '../audio/stretch/engine'
import type { AudioClip, Project } from '../model/types'
import { placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
import { keySemitones } from './key'
import type { HarborEntry } from './types'

export function toSoundEntry(entry: HarborEntry): SoundEntry {
  const tags = [...entry.tags]
  if (entry.loopKind && !tags.includes(entry.loopKind)) tags.push(entry.loopKind)
  if (entry.instrument && !tags.includes(entry.instrument)) tags.push(entry.instrument)
  return {
    id: entry.id,
    path: entry.path,
    name: entry.name,
    type: 'loop',
    tags,
    bpm: entry.bpm,
    key: entry.key,
    durationSec: entry.durationSec,
    sampleRate: entry.sampleRate,
    license: entry.license,
    source: entry.source,
    pack: entry.pack,
  }
}

/**
 * A loop becomes an audio clip that follows the song tempo.
 * Melodic loops can also move to the project key. Drum loops stay at their original pitch.
 */
export function placeHarborLoop(options: {
  entry: HarborEntry
  channels: Float32Array[]
  fileRate: number
  project: Project
  startSample: number
  matchKey?: boolean
  bufferId?: string
  clipId?: string
}): { asset: { id: string; name: string; sampleRate: number; channels: Float32Array[] }; clip: AudioClip } | null {
  const placed = placeSound({
    entry: toSoundEntry(options.entry),
    channels: options.channels,
    fileRate: options.fileRate,
    project: options.project,
    startSample: options.startSample,
    bufferId: options.bufferId,
    clipId: options.clipId,
  })
  if (!placed) return null
  const pitch = options.matchKey && options.entry.loopKind !== 'drum'
  const semitones = pitch ? keySemitones(options.entry.key, options.project.scale?.root ?? 0) : 0
  if (placed.clip.stretch && semitones) placed.clip.stretch.semitones = semitones
  return placed
}

/** Speaker preview. The same stretch and pitch the clip will use on the timeline. */
export function previewHarborLoop(options: {
  entry: HarborEntry
  channels: Float32Array[]
  fileRate: number
  project: Project
  startSample?: number
  matchKey?: boolean
}) {
  const placed = placeHarborLoop({ ...options, startSample: options.startSample ?? 0 })
  if (!placed) return null
  return renderClipChannels(placed.asset.channels, placed.clip, options.project, 'preview')
}

/**
 * Read the session, detect keys that are not tagged, then pitch-shift off the main thread.
 * The project itself changes in one store call after the audio is ready.
 */

import { monoMix } from '../analysis/mix'
import { isDrumsPlugin } from '../audio/plugins/ids'
import type { AudioClip, MidiClip, Project } from '../model/types'
import {
  majorMinorKey,
  scopeClip,
  withDetectedKey,
  type HarmonizeInput,
  type HarmonizeMove,
  type ScopedClip,
} from '../model/harmonize'
import type { MusicalKey } from '../model/keyFit'
import { recentSounds } from '../library/recent'
import type { ProjectStore } from '../state/store'

export function collectHarmonizeInputs(store: ProjectStore): HarmonizeInput[] {
  const inputs: HarmonizeInput[] = []
  for (const track of store.project.tracks) {
    const pluginIds = track.plugins.map((plugin) => plugin.pluginId)
    const drumMachine = track.plugins.some((plugin) => isDrumsPlugin(plugin))
    for (const clip of track.clips) {
      inputs.push(audioInput(store.project, track, clip, pluginIds, drumMachine))
    }
    for (const clip of track.midiClips) {
      inputs.push(midiInput(track, clip, pluginIds, drumMachine))
    }
  }
  for (const clip of store.project.patternClips ?? []) {
    if (clip.suppressed || clip.scene != null) continue
    inputs.push({
      trackId: clip.trackId || '',
      clipId: clip.id,
      name: 'Beat pattern',
      kind: 'pattern',
      trackName: 'Beat Machine',
    })
  }
  return inputs
}

export function scopeSession(inputs: readonly HarmonizeInput[]): ScopedClip[] {
  return inputs.map((input) => scopeClip(input))
}

export async function detectMissingKeys(
  store: ProjectStore,
  clips: ScopedClip[],
  onProgress: (done: number, total: number, label: string) => void,
  alive: () => boolean,
): Promise<ScopedClip[]> {
  const pending = clips.filter((clip) => clip.needsDetect)
  const next = clips.map((clip) => ({ ...clip }))
  let done = 0
  for (const clip of pending) {
    if (!alive()) return next
    onProgress(done, pending.length, `Listening to ${clip.name}`)
    const key = await detectAudioKey(store, clip.trackId, clip.clipId)
    if (!alive()) return next
    const index = next.findIndex((item) => item.clipId === clip.clipId && item.trackId === clip.trackId)
    if (index >= 0) next[index] = withDetectedKey(next[index], key)
    done += 1
    onProgress(done, pending.length, `Listening to ${clip.name}`)
    await yieldFrame()
  }
  return next
}

export async function pitchHarmonizeMoves(
  store: ProjectStore,
  moves: readonly HarmonizeMove[],
  onProgress: (done: number, total: number, label: string) => void,
  alive: () => boolean,
) {
  const audio = moves.filter((move) => move.kind === 'audio' && move.semitones !== 0)
  let done = 0
  for (const move of audio) {
    if (!alive()) return
    const clip = store.track(move.trackId)?.clips.find((item) => item.id === move.clipId)
    const name = clip?.name || 'Clip'
    onProgress(done, audio.length, `Shifting ${name}`)
    if (clip) await cacheClipPitch(store, clip, (clip.stretch?.semitones ?? 0) + move.semitones)
    done += 1
    onProgress(done, audio.length, `Shifting ${name}`)
    await yieldFrame()
  }
}

async function cacheClipPitch(store: ProjectStore, clip: AudioClip, semitones: number) {
  const asset = store.buffers.get(clip.bufferId)
  if (!asset?.channels.length || !semitones) return
  const mode = clip.stretch?.mode === 'tonal' ? 'tonal' : 'pro'
  try {
    const { cacheFormantPitch } = await import('../audio/stretch/pitchJob')
    await cacheFormantPitch({
      channels: asset.channels,
      bufferId: clip.bufferId,
      offsetSamples: clip.offsetSamples,
      sourceSamples: clip.stretch?.sourceSamples || clip.durationSamples,
      sampleRate: store.project.sampleRate,
      semitones,
      cents: 0,
      formant: true,
      mode,
    })
  } catch {
    /* Playback renders the same shift if the cache misses. */
  }
}

async function detectAudioKey(store: ProjectStore, trackId: string, clipId: string): Promise<MusicalKey | null> {
  const clip = store.track(trackId)?.clips.find((item) => item.id === clipId)
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  if (!clip || !asset?.channels.length) return null
  const offset = Math.max(0, clip.offsetSamples || 0)
  const source = Math.max(1, clip.stretch?.sourceSamples || clip.durationSamples)
  const slices = asset.channels
    .map((channel) => channel.subarray(offset, Math.min(channel.length, offset + source)))
    .filter((channel) => channel.length > 0)
  if (!slices.length) return null
  try {
    const { detectKeyOffThread } = await import('../analysis/keyJob')
    const heard = await detectKeyOffThread(monoMix(slices), asset.sampleRate)
    if (!heard.clear || heard.root == null) return null
    if (heard.scale !== 'ionian' && heard.scale !== 'aeolian') return null
    return majorMinorKey(heard.root, heard.scale === 'aeolian')
  } catch {
    return null
  }
}

function audioInput(project: Project, track: Project['tracks'][number], clip: AudioClip, pluginIds: string[], drumMachine: boolean): HarmonizeInput {
  const library = libraryFacts(project, clip)
  return {
    trackId: track.id,
    clipId: clip.id,
    name: clip.name,
    kind: 'audio',
    trackName: track.name,
    trackKind: track.kind,
    instrument: track.instrument,
    pluginIds,
    drumMachine,
    soundType: clip.soundType || library.type,
    soundCategory: clip.soundCategory || library.category,
    soundRole: clip.soundRole || library.role,
    soundTags: clip.soundTags?.length ? clip.soundTags : library.tags,
    soundKey: clip.soundKey || library.key,
    loopKey: clip.loopKey,
    hearingKey: clip.hearing?.key,
    hearingClear: clip.hearing ? clip.hearing.clearKey : null,
    existingSemitones: clip.stretch?.semitones ?? 0,
  }
}

function midiInput(track: Project['tracks'][number], clip: MidiClip, pluginIds: string[], drumMachine: boolean): HarmonizeInput {
  return {
    trackId: track.id,
    clipId: clip.id,
    name: clip.name,
    kind: 'midi',
    trackName: track.name,
    trackKind: track.kind,
    instrument: track.instrument,
    pluginIds,
    drumMachine,
    notes: clip.notes.map((note) => ({ pitch: note.pitch, durationBeats: note.durationBeats })),
  }
}

function libraryFacts(project: Project, clip: AudioClip) {
  const empty = { type: '', category: '', role: '', tags: [] as string[], key: '' }
  const fileKey = project.libraryFiles?.find((item) => item.bufferId === clip.bufferId)?.key
  for (const row of recentSounds()) {
    const sound = row.sound
    if (sound && (clip.bufferId === `lib_${sound.id}` || sound.name === clip.name)) {
      return { type: sound.type, category: sound.category || '', role: sound.role || '', tags: sound.tags, key: sound.key || '' }
    }
    const library = row.library
    if (library && (library.key === fileKey || library.name === clip.name)) {
      return { type: library.type, category: library.category || '', role: '', tags: library.tags, key: library.musicalKey || '' }
    }
  }
  return empty
}

function yieldFrame() {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
    else setTimeout(resolve, 0)
  })
}

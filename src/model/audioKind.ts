import { recordedStretch, isRecordedClip } from '../audio/recordTake'
import { tempoFollowsProject } from './clipTempo'
import type { AudioClip, Project, Track } from './types'

export function isVocalTrack(track: { type?: string; kind?: string } | null | undefined): boolean {
  return track?.type === 'audio' && track.kind === 'vocal'
}

export function isLoopTrack(track: { type?: string; kind?: string } | null | undefined): boolean {
  return track?.type === 'audio' && track.kind === 'loop'
}

/** Loop audio is never armed. MIDI arm is separate. Undefined kind still records. */
export function canArmAudio(track: { type?: string; kind?: string } | null | undefined): boolean {
  if (track?.type !== 'audio') return false
  return track.kind !== 'loop'
}

/** A catalog loop (or anything already following the song) does not belong on a Vocal track. */
export function clipWantsLoopTrack(clip: AudioClip): boolean {
  if (isRecordedClip(clip)) return false
  return tempoFollowsProject(clip.stretch)
}

function clipIsTake(clip: AudioClip): boolean {
  if (clip.playback === 'recorded') return true
  if (clip.takeId) return true
  if (clip.source === 'guide' || clip.source === 'aligned-take') return true
  return !!clip.folder?.lanes.some((lane) => lane.takeId || lane.source === 'local' || lane.source === 'guide' || lane.source === 'aligned-take')
}

/** A saved take, or a track that was already armed to record. */
export function trackHoldsTake(track: Track): boolean {
  if (track.armed) return true
  return track.clips.some(clipIsTake)
}

/**
 * Fill kind on audio tracks that predate the split.
 * A take or an armed input becomes Vocal. Everything else is a Loop and is disarmed.
 * Clips that are actual takes drop their warp so they play back dry.
 */
export function migrateAudioKinds(project: Project) {
  for (const track of project.tracks) {
    if (track.type !== 'audio') continue
    if (track.kind !== 'vocal' && track.kind !== 'loop') {
      track.kind = trackHoldsTake(track) ? 'vocal' : 'loop'
    }
    if (track.kind === 'loop') track.armed = false
    if (track.kind === 'vocal' && (track.inputGainDb == null || !Number.isFinite(track.inputGainDb))) track.inputGainDb = 0
    if (track.kind !== 'vocal') continue
    for (const clip of track.clips) {
      if (!clip.takeId && clip.playback !== 'recorded' && clip.source !== 'guide' && clip.source !== 'aligned-take') continue
      const source = Math.max(1, clip.stretch?.sourceSamples || clip.durationSamples)
      clip.playback = 'recorded'
      clip.warp = false
      delete clip.durationBeats
      if (clip.durationSamples > source + 1) clip.durationSamples = source
      clip.stretch = recordedStretch(source)
    }
  }
}

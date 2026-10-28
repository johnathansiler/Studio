import type { Project, Track } from './types'
import type { StepChannel } from './steps'

/**
 * Mixer strip a Beats row is explicitly linked to.
 * An empty output stays on the row itself, so one fader does not move every drum.
 */
export function channelRoute(project: Project, channel: Pick<StepChannel, 'output'>): string | null {
  if (!channel.output) return null
  return project.tracks.some((track) => track.id === channel.output) ? channel.output : null
}

/** Copy a mixer strip onto every Beats row that plays through it. */
export function mirrorTrackMix(project: Project, trackId: string) {
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track || !project.beats) return
  for (const pattern of project.beats.patterns) {
    for (const channel of pattern.channels) {
      if (channelRoute(project, channel) !== trackId) continue
      channel.volume = track.volume
      channel.pan = track.pan
      channel.mute = track.mute
      channel.solo = track.solo
    }
  }
}

export function mixOf(track: Track) {
  return {
    id: track.id,
    name: track.name,
    volume: track.volume,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    sends: track.sends,
    plugins: track.plugins ?? [],
  }
}

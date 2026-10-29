import type { Track } from '../model/types'

/** A pitched sample or a multi-zone library instrument. The Analog patch stays hidden. */
export function isSampledInstrument(track: Pick<Track, 'type' | 'instrument'> | null | undefined): boolean {
  if (!track || track.type !== 'midi') return false
  return track.instrument === 'sampler' || track.instrument === 'library'
}

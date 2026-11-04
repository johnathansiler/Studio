/**
 * Call sound with the switch removed.
 * Opus at its cap (stereo, FEC, DTX off) is the quality path. PCM only bypassed it.
 */
export const automaticMonitorMode = 'opus' as const

/** Mesh offers always carry music, talk, camera, and screen, in that order, before createOffer. */
export const MESH_TRANSCEIVER_KINDS = ['audio', 'audio', 'video', 'video'] as const

export function videoMLinesReady(kinds: readonly string[]): boolean {
  const video = kinds.filter((kind) => kind === 'video').length
  const audioAt = kinds.indexOf('audio')
  const videoAt = kinds.indexOf('video')
  return video >= 1 && audioAt >= 0 && videoAt > audioAt
}

export function liveMediaTracks<T extends { readyState: string }>(tracks: readonly T[] | undefined | null): T[] {
  if (!tracks) return []
  return tracks.filter((track) => track.readyState === 'live')
}

/** A stream object left by Leave is not usable once its tracks have ended. */
export function needsFreshCapture(input: { audioLive: boolean; videoLive: boolean; camOn: boolean }): boolean {
  if (!input.audioLive) return true
  if (input.camOn && !input.videoLive) return true
  return false
}

export function trackFact(track: { id: string; readyState: string } | null | undefined): { id: string; live: boolean } | null {
  if (!track) return null
  return { id: track.id, live: track.readyState === 'live' }
}

/** A live video track that was not in the last offer has to be negotiated. replaceTrack alone stays silent on a relay. */
export function videoSendChanged(
  previous: { id: string; live: boolean } | null,
  next: { id: string; live: boolean } | null,
): boolean {
  if (!next?.live) return false
  if (!previous?.live) return true
  return previous.id !== next.id
}

/**
 * Renegotiate when the camera shows up after the first offer.
 * Restart ICE only when this gather has nothing but relay candidates, and only once,
 * so a Wi-Fi host pair is left alone.
 */
export function offerAfterVideoAttach(input: {
  trackBecameLive: boolean
  relayOnly: boolean
  alreadyRestarted: boolean
}): { renegotiate: boolean; iceRestart: boolean } {
  if (!input.trackBecameLive) return { renegotiate: false, iceRestart: false }
  return { renegotiate: true, iceRestart: input.relayOnly && !input.alreadyRestarted }
}

export function relayOnlyGather(gathered: { host: number; srflx: number; relay: number; prflx: number }): boolean {
  return gathered.relay > 0 && gathered.host === 0 && gathered.srflx === 0 && gathered.prflx === 0
}

export function remoteTrackSlot(input: {
  index: number
  kind: 'audio' | 'video'
  musicFilled: boolean
  cameraFilled: boolean
}): 'music' | 'talk' | 'camera' | 'screen' {
  if (input.index === 0) return 'music'
  if (input.index === 1) return 'talk'
  if (input.index === 2) return 'camera'
  if (input.index === 3) return 'screen'
  if (input.kind === 'audio') return input.musicFilled ? 'talk' : 'music'
  return input.cameraFilled ? 'screen' : 'camera'
}

/** Ended tracks are not painted. A live track is attached and played inline, including when it is still muted. */
export function previewPlayback(track: { readyState: string } | null): { attach: boolean; playsInline: boolean; play: boolean } {
  const attach = Boolean(track && track.readyState === 'live')
  return { attach, playsInline: true, play: attach }
}

export function rejoinMediaPlan(input: {
  audioLive: boolean
  videoLive: boolean
  camOn: boolean
  selfTrack: { readyState: string } | null
  remoteTrack: { readyState: string } | null
}): { recapture: boolean; showSelf: boolean; showRemote: boolean } {
  const self = previewPlayback(input.selfTrack)
  const remote = previewPlayback(input.remoteTrack)
  return {
    recapture: needsFreshCapture({ audioLive: input.audioLive, videoLive: input.videoLive, camOn: input.camOn }),
    showSelf: self.attach && self.play,
    showRemote: remote.attach && remote.play,
  }
}

export type ConnectionGrade = 'Good' | 'OK' | 'Poor'

export function connectionWord(input: {
  status: string
  failed: boolean
  oneWayMs: number | null
}): ConnectionGrade {
  if (input.status === 'error' || input.status === 'rejected' || input.status === 'removed' || input.failed) return 'Poor'
  if (input.status === 'connecting' || input.status === 'reconnecting') return 'OK'
  if (input.oneWayMs != null && input.oneWayMs > 180) return 'Poor'
  if (input.oneWayMs != null && input.oneWayMs > 80) return 'OK'
  return 'Good'
}

/** Denied mic still joins. The room is listen-only until a later tap grants the microphone. */
export function joinPlayback(micGranted: boolean): 'talk' | 'listen' {
  return micGranted ? 'talk' : 'listen'
}

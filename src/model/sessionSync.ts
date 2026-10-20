import type { Project } from './types'

/** How long the host waits so a guest can receive the start time before the downbeat. */
export function scheduleLeadMs(oneWayMs: number): number {
  const oneWay = Number.isFinite(oneWayMs) ? Math.max(0, oneWayMs) : 40
  return Math.min(400, Math.max(120, oneWay + 80))
}

/**
 * hostPerf ≈ guestPerf + offset, with offset measured on the guest.
 * The instant the host named is this performance.now() on the guest.
 */
export function guestStartPerf(hostPerfAtSample: number, clockOffsetMs: number): number {
  return hostPerfAtSample - clockOffsetMs
}

/** If the start message arrives late, move the playhead forward so both sides meet. */
export function catchUpSchedule(args: {
  targetPerf: number
  nowPerf: number
  sample: number
  sampleRate: number
}): { sample: number; perf: number } {
  const lateMs = args.nowPerf - args.targetPerf
  if (lateMs <= 2) return { sample: Math.max(0, Math.round(args.sample)), perf: args.targetPerf }
  const lateSamples = Math.round((lateMs * args.sampleRate) / 1000)
  return { sample: Math.max(0, Math.round(args.sample) + lateSamples), perf: args.nowPerf }
}

export function guestMayRequest(action: string): boolean {
  return action === 'play' || action === 'stop' || action === 'seek'
}

export function referencedBufferIds(project: Project): string[] {
  const ids = new Set<string>()
  for (const track of project.tracks) {
    for (const clip of track.clips) ids.add(clip.bufferId)
  }
  return [...ids]
}

/** Musical state the guest must mirror. Ignores selection and undo history. */
export function arrangementDigest(project: Project): string {
  return JSON.stringify({
    id: project.id,
    name: project.name,
    sampleRate: project.sampleRate,
    tempo: project.tempo,
    timeSignature: project.timeSignature,
    masterVolume: project.masterVolume,
    loopEnabled: project.loopEnabled,
    loopStartSample: project.loopStartSample,
    loopEndSample: project.loopEndSample,
    metronomeEnabled: project.metronomeEnabled,
    countIn: project.countIn,
    snap: project.snap,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      color: track.color,
      clips: track.clips.map((clip) => [clip.id, clip.bufferId, clip.startSample, clip.offsetSamples, clip.durationSamples, clip.gain]),
      midi: track.midiClips.map((clip) => [clip.id, clip.startBeat, clip.durationBeats, clip.notes.length]),
    })),
  })
}

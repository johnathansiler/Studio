import { computePeaks } from './demo'
import type { AudioAsset, Project } from './types'

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

/**
 * Where the guest playhead should start.
 * A measured clock offset maps the host's named instant. Without one, start
 * about one scheduling lead after the host pressed play, minus the one-way
 * delay already spent getting the message here.
 */
export function guestFollowStart(args: {
  hostPerfAtSample: number
  clockOffsetMs: number | null
  oneWayMs: number
  nowPerf: number
  /** When the clocks are not mapped yet, wait out the count-in instead of starting now. */
  countInMs?: number
}): number {
  if (args.clockOffsetMs == null || !Number.isFinite(args.clockOffsetMs)) {
    const oneWay = Number.isFinite(args.oneWayMs) ? Math.max(0, args.oneWayMs) : 40
    const countIn = Number.isFinite(args.countInMs) ? Math.max(0, Number(args.countInMs)) : 0
    if (countIn > 0) return args.nowPerf + Math.max(0, countIn - oneWay)
    return args.nowPerf + Math.max(0, scheduleLeadMs(oneWay) - oneWay)
  }
  return guestStartPerf(args.hostPerfAtSample, args.clockOffsetMs)
}

/** Small peak outline for each referenced clip. The wav itself stays on HTTP. */
export function outlineWaveforms(project: Project, buffers: Map<string, AudioAsset>): Record<string, { min: number; max: number }[]> {
  const out: Record<string, { min: number; max: number }[]> = {}
  for (const id of referencedBufferIds(project)) {
    const channel = buffers.get(id)?.channels[0]
    if (!channel?.length) continue
    out[id] = computePeaks(channel, 160).map((peak) => ({
      min: Math.round(peak.min * 100) / 100,
      max: Math.round(peak.max * 100) / 100,
    }))
  }
  return out
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

/** Wav bytes per HTTP chunk. A 1 Mbps uplink still has room for video beside this. */
export const ASSET_CHUNK_BYTES = 12_000
/** Gap between chunks so the upload stays behind the call. */
export const ASSET_CHUNK_GAP_MS = 400

export function assetChunkCount(byteLength: number, chunkBytes = ASSET_CHUNK_BYTES): number {
  if (byteLength <= 0) return 0
  return Math.ceil(byteLength / chunkBytes)
}

/**
 * Bulk project audio waits until this call is already carrying media.
 * A connected peer with outbound bytes means ICE finished and the uplink is in use.
 */
export function mediaCanCarryAssets(peers: Array<{ connection: string; outboundVideo: number; outboundAudio: number }>): boolean {
  return peers.some((peer) => peer.connection === 'connected' && (peer.outboundVideo > 0 || peer.outboundAudio > 0))
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
    launchQuant: project.launchQuant ?? null,
    recordBars: project.recordBars ?? 0,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      type: track.type,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      color: track.color,
      clips: track.clips.map((clip) => [clip.id, clip.bufferId, clip.startSample, clip.offsetSamples, clip.durationSamples, clip.gain, clip.quant ?? null, clip.mode ?? null, clip.loop ?? null, clip.warp ?? null, clip.follow ?? null, clip.legato ?? null, clip.slotOnly ?? null]),
      midi: track.midiClips.map((clip) => [clip.id, clip.startBeat, clip.durationBeats, clip.notes.length, clip.notes.map((note) => (note.slide ? 1 : 0)).join(''), clip.quant ?? null, clip.mode ?? null, clip.follow ?? null, clip.legato ?? null, clip.slotOnly ?? null]),
      audioSlots: track.audioSlots ?? null,
      midiSlots: track.midiSlots ?? null,
      rack: track.rack?.devices.map((device) => [device.id, device.kind, device.params, device.pattern, device.zones.length]),
      cables: track.rack?.cables.map((cable) => [cable.from, cable.fromPort, cable.to, cable.toPort, cable.amount]),
    })),
  })
}

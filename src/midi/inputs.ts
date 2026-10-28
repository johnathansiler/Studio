import { channelConstraints, mediaChannelCount } from '../model/comp'
import { planAudioRoutes, type AudioRoute } from '../model/midiTools'
import type { Track } from '../model/types'

export interface RecordStreamInput {
  key: string
  stream: MediaStream
  source: 'local' | 'guide'
  peerId?: string
  takeId?: string
  channel?: number
}

export async function collectRecordInputs(opts: {
  tracks: Track[]
  takeId: string
  localStream: () => MediaStream | null
  remoteStream: (peerId: string) => MediaStream | null
  setLocalMic: (stream: MediaStream) => void
  openMic: (audio: MediaTrackConstraints) => Promise<MediaStream>
}): Promise<RecordStreamInput[]> {
  const routes = planAudioRoutes(opts.tracks)
  const inputs: RecordStreamInput[] = []
  const shared = routes.filter((route) => !route.deviceId && !route.peerId)
  const devices = new Map<string, AudioRoute[]>()
  for (const route of routes) {
    if (!route.deviceId) continue
    const list = devices.get(route.deviceId) || []
    list.push(route)
    devices.set(route.deviceId, list)
  }
  if (shared.length) {
    const stream = await openShared(shared, opts)
    if (stream) {
      opts.setLocalMic(stream)
      for (const route of shared) {
        inputs.push({
          key: route.trackId,
          stream,
          source: 'local',
          takeId: opts.takeId,
          channel: route.channel ?? undefined,
        })
      }
    }
  }
  for (const [deviceId, group] of devices) {
    const count = streamChannels(group)
    try {
      const stream = await opts.openMic({
        ...channelConstraints(count),
        deviceId: { exact: deviceId },
      })
      for (const route of group) {
        inputs.push({
          key: route.trackId,
          stream,
          source: 'local',
          takeId: opts.takeId,
          channel: route.channel ?? undefined,
        })
      }
    } catch {
      /* this device stayed closed; other inputs still record */
    }
  }
  for (const route of routes) {
    if (!route.peerId) continue
    const stream = opts.remoteStream(route.peerId)
    if (!stream) continue
    inputs.push({ key: route.trackId, stream, source: 'guide', peerId: route.peerId, takeId: opts.takeId })
  }
  if (inputs.length) return inputs
  const fallback = opts.tracks.find((track) => track.type === 'audio' && track.armed) || opts.tracks.find((track) => track.type === 'audio')
  if (!fallback) return []
  try {
    const stereo = fallback.channels === 2
    const stream = await opts.openMic(channelConstraints(stereo ? 2 : 1))
    opts.setLocalMic(stream)
    return [{ key: fallback.id, stream, source: 'local', takeId: opts.takeId }]
  } catch {
    return []
  }
}

function streamChannels(routes: AudioRoute[]): number {
  let count = mediaChannelCount(routes.map((route) => route.input))
  for (const route of routes) if (route.channel != null) count = Math.max(count, route.channel + 1)
  return count
}

async function openShared(
  routes: AudioRoute[],
  opts: { localStream: () => MediaStream | null; openMic: (audio: MediaTrackConstraints) => Promise<MediaStream> },
): Promise<MediaStream | null> {
  const existing = opts.localStream()
  if (existing) return existing
  const count = streamChannels(routes)
  try {
    return await opts.openMic(channelConstraints(count))
  } catch {
    try {
      return await opts.openMic(channelConstraints(1))
    } catch {
      return null
    }
  }
}

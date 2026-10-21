export interface NamedCodec {
  mimeType: string
}

/** H.264 first, then VP8, then everything else. Nothing is removed: Safari sends H.264 and Chrome must keep it. */
export function orderVideoCodecs<T extends NamedCodec>(codecs: T[]): T[] {
  const rank = (mime: string) => {
    const name = mime.toLowerCase()
    if (name === 'video/h264') return 0
    if (name === 'video/vp8') return 1
    if (name === 'video/vp9') return 2
    return 3
  }
  return [...codecs].sort((left, right) => rank(left.mimeType) - rank(right.mimeType) || left.mimeType.localeCompare(right.mimeType))
}

/** Codecs a Safari guest can actually send or receive. AV1 and VP9 stay out of the offer so one unknown codec cannot reject the whole video section. H.264 is kept whenever the browser has it. */
export function outboundVideoCodecs<T extends NamedCodec>(codecs: T[]): T[] {
  const groups: Record<string, T[]> = { 'video/h264': [], 'video/vp8': [] }
  for (let index = 0; index < codecs.length; index++) {
    const name = codecs[index].mimeType.toLowerCase()
    if (!groups[name]) continue
    groups[name].push(codecs[index])
    const next = codecs[index + 1]
    if (next && next.mimeType.toLowerCase() === 'video/rtx') groups[name].push(next)
  }
  return [...groups['video/h264'], ...groups['video/vp8']]
}

/** WebKit's setCodecPreferences can drop H.264. Leave Safari on its native order, which leads with H.264. */
export function shouldSetVideoCodecPreferences(userAgent: string) {
  const ua = userAgent.toLowerCase()
  const safari = ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium') && !ua.includes('android') && !ua.includes('crios')
  return !safari
}

export const VIDEO_BITRATES = [100_000, 150_000, 300_000] as const
/** Where the encoder starts. The cap opens toward VIDEO_CEILING_BITRATE once the estimate allows. */
export const DEFAULT_VIDEO_BITRATE = 100_000
export const VIDEO_START_BITRATE = DEFAULT_VIDEO_BITRATE
export const VIDEO_CEILING_BITRATE = 250_000
export const VIDEO_MAX_FRAMERATE = 15

/**
 * The camera opens at about 15 fps and 100 kbps. `medium` is enough of the
 * congestion estimate to reach that cap once the estimate is a few hundred
 * kilobits. Audio stays the higher priority.
 */
export function videoEncodingBudget(maxBitrate = VIDEO_START_BITRATE) {
  return {
    maxBitrate,
    maxFramerate: VIDEO_MAX_FRAMERATE,
    priority: 'medium' as const,
    networkPriority: 'low' as const,
  }
}

/** Opus stays at its cap. Video does not spend this. */
const VIDEO_AUDIO_RESERVE = 560_000
/** One asset POST is about 16 KB every 400 ms. A 1 Mbps uplink has to keep that. */
const VIDEO_UPLOAD_RESERVE = 360_000

/**
 * 100 kbps until the estimate can spare 200 kbps of video after audio and the
 * asset upload, then up to 250 kbps. 35% of an 800 kbps estimate is not spare
 * room: that pipe is already carrying Opus. Frame rate stays preferred; the
 * height only opens at the higher cap so a thin pipe is not asked for 480p.
 */
export function videoTargetForBwe(availableOutgoingBitrate: number, selected = VIDEO_CEILING_BITRATE): { maxBitrate: number; height: number } {
  const ceiling = selected > VIDEO_START_BITRATE ? Math.min(selected, VIDEO_CEILING_BITRATE) : VIDEO_CEILING_BITRATE
  const spare = availableOutgoingBitrate > 0 ? availableOutgoingBitrate - VIDEO_AUDIO_RESERVE - VIDEO_UPLOAD_RESERVE : 0
  if (spare >= 200_000 && ceiling >= 200_000) {
    const raw = Math.min(ceiling, Math.floor(spare))
    // 50 kbps steps. A noisy estimate must not call setParameters every second.
    const stepped = Math.min(ceiling, Math.max(200_000, Math.floor(raw / 50_000) * 50_000))
    return { maxBitrate: stepped, height: 480 }
  }
  return { maxBitrate: Math.min(VIDEO_START_BITRATE, ceiling), height: 240 }
}

/** Capture up to 480p so the sender can open that size. The encoder scales down while the cap is 100 kbps. */
export function videoCaptureBudget(): Pick<MediaTrackConstraints, 'width' | 'height' | 'frameRate'> {
  return {
    width: { ideal: 640, max: 854 },
    height: { ideal: 360, max: 480 },
    frameRate: { ideal: 15, max: 15 },
  }
}

/** Scale a larger camera down to 426×240, or to 854×480 when the target height says so. */
export function scaleResolutionDownBy(width: number, height: number, targetHeight = 240): number {
  const tall = targetHeight >= 400
  const targetWidth = tall ? 854 : 426
  const limitHeight = tall ? 480 : 240
  if (width <= 0 || height <= 0) return 1
  const scale = Math.max(width / targetWidth, height / limitHeight, 1)
  return Math.round(scale * 100) / 100
}

export type VideoSendDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'

export function videoDirection(send: boolean, recv: boolean): VideoSendDirection {
  if (send && recv) return 'sendrecv'
  if (send) return 'sendonly'
  if (recv) return 'recvonly'
  return 'inactive'
}

/**
 * An answer can only send when the offer is willing to receive, and can only
 * receive when the offer is willing to send. Forcing sendonly against a
 * sendonly offer makes Safari reject the whole description, audio included.
 */
export function legalDirection(want: VideoSendDirection, offer: VideoSendDirection | null): VideoSendDirection {
  if (!offer) return want
  const wantSend = want === 'sendrecv' || want === 'sendonly'
  const wantRecv = want === 'sendrecv' || want === 'recvonly'
  const maySend = offer === 'sendrecv' || offer === 'recvonly'
  const mayRecv = offer === 'sendrecv' || offer === 'sendonly'
  return videoDirection(wantSend && maySend, wantRecv && mayRecv)
}

/** Rich first, then a set Safari accepts when it rejects channel count or sample rate. The last entry is a bare audio request. */
export function musicCaptureAttempts(deviceId = ''): Array<true | MediaTrackConstraints> {
  const device = deviceId ? { deviceId: { ideal: deviceId } } : {}
  return [
    {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      sampleRate: { ideal: 48000 },
      ...device,
    },
    {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...device,
    },
    true,
  ]
}

/** Attempts Safari will accept. No exact deviceId, frameRate, sampleRate, or channelCount. */
export function cameraAttempts(deviceId: string): MediaTrackConstraints[] {
  const budget = videoCaptureBudget()
  const attempts: MediaTrackConstraints[] = []
  if (deviceId) attempts.push({ deviceId: { ideal: deviceId }, facingMode: 'user', ...budget })
  attempts.push({ facingMode: 'user', ...budget })
  attempts.push({ facingMode: 'user', width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } })
  attempts.push({ facingMode: 'user' })
  attempts.push({})
  return attempts
}

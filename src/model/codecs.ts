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
export const DEFAULT_VIDEO_BITRATE = 150_000

/** Seeing each other, not a broadcast. Ideal 320×240, never above 426×240 or 15 fps. */
export function videoCaptureBudget(): Pick<MediaTrackConstraints, 'width' | 'height' | 'frameRate'> {
  return {
    width: { ideal: 320, max: 426 },
    height: { ideal: 240, max: 240 },
    frameRate: { ideal: 15, max: 15 },
  }
}

/** Scale a larger camera down to the 426×240 budget. 1 means the capture is already small enough. */
export function scaleResolutionDownBy(width: number, height: number): number {
  if (width <= 0 || height <= 0) return 1
  const scale = Math.max(width / 426, height / 240, 1)
  return Math.round(scale * 100) / 100
}

export type VideoSendDirection = 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'

export function videoDirection(send: boolean, recv: boolean): VideoSendDirection {
  if (send && recv) return 'sendrecv'
  if (send) return 'sendonly'
  if (recv) return 'recvonly'
  return 'inactive'
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

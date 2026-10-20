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

/** Attempts Safari will accept. No exact deviceId, frameRate, sampleRate, or channelCount. */
export function cameraAttempts(deviceId: string): MediaTrackConstraints[] {
  const attempts: MediaTrackConstraints[] = []
  if (deviceId) attempts.push({ deviceId: { ideal: deviceId }, facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } })
  attempts.push({ facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } })
  attempts.push({ facingMode: 'user' })
  attempts.push({})
  return attempts
}

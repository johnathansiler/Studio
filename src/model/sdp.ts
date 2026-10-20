export interface OpusOptions {
  ptimeMs: number
  maxAverageBitrate: number
  stereo: boolean
  fec: boolean
  dtx: boolean
}

export const DEFAULT_OPUS: OpusOptions = {
  ptimeMs: 10,
  maxAverageBitrate: 510000,
  stereo: true,
  fec: true,
  dtx: false,
}

/** Payload types named on this m-line. A fmtp for any other type is illegal on Safari. */
export function mLinePayloadTypes(mline: string): Set<string> {
  return new Set(mline.trim().split(/\s+/).slice(3))
}

/**
 * Force low-latency Opus on a local offer or answer. Browser WebRTC floors
 * frames at 10ms. Each audio section is edited only for the Opus payload
 * types that section actually lists, because Safari's types differ per m-line.
 */
export function mungeOpusSdp(sdp: string, opts: OpusOptions = DEFAULT_OPUS): string {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const ptime = clamp(Math.round(opts.ptimeMs), 10, 60)

  const fmtpFor = (pt: string, existing?: string) => {
    const params = new Map<string, string>()
    if (existing) {
      for (const part of existing.split(';')) {
        const [k, v] = part.split('=')
        if (!k) continue
        params.set(k.trim(), (v ?? '').trim())
      }
    }
    params.set('minptime', String(ptime))
    params.set('useinbandfec', opts.fec ? '1' : '0')
    params.set('usedtx', opts.dtx ? '1' : '0')
    params.set('stereo', opts.stereo ? '1' : '0')
    params.set('sprop-stereo', opts.stereo ? '1' : '0')
    params.set('maxaveragebitrate', String(Math.round(opts.maxAverageBitrate)))
    params.set('maxplaybackrate', '48000')
    params.set('cbr', '0')
    const body = [...params.entries()].map(([k, v]) => `${k}=${v}`).join(';')
    return `a=fmtp:${pt} ${body}`
  }

  const sections: string[][] = [[]]
  for (const line of lines) {
    if (line.startsWith('m=') && sections[sections.length - 1].length) sections.push([])
    sections[sections.length - 1].push(line)
  }

  const rendered = sections.map((section) => {
    const audio = section[0]?.startsWith('m=audio')
    if (!audio) return section
    const listed = mLinePayloadTypes(section[0] || '')
    const opusPts = new Set<string>()
    for (const line of section) {
      const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i)
      if (match && listed.has(match[1])) opusPts.add(match[1])
    }
    const next: string[] = []
    const seenFmtp = new Set<string>()
    for (const line of section) {
      if (line.startsWith('a=ptime:') || line.startsWith('a=maxptime:')) continue
      const fmtp = line.match(/^a=fmtp:(\d+)\s*(.*)$/)
      if (fmtp && opusPts.has(fmtp[1])) {
        next.push(fmtpFor(fmtp[1], fmtp[2]))
        seenFmtp.add(fmtp[1])
        continue
      }
      next.push(line)
    }
    for (const pt of opusPts) {
      if (!seenFmtp.has(pt)) next.push(fmtpFor(pt))
    }
    if (opusPts.size) {
      next.push(`a=ptime:${ptime}`)
      next.push(`a=maxptime:${ptime}`)
    }
    return next
  })

  return rendered.flat().join('\r\n') + '\r\n'
}

/** Directions for one media kind, in m-line order. */
export function sectionDirections(sdp: string, kind: 'audio' | 'video'): Array<'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'> {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const dirs: Array<'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'> = []
  let inside = false
  let dir: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' | null = null
  const flush = () => {
    if (!inside) return
    dirs.push(dir || 'sendrecv')
    dir = null
  }
  for (const line of lines) {
    if (line.startsWith('m=')) {
      flush()
      inside = line.startsWith(`m=${kind}`)
      continue
    }
    if (!inside) continue
    if (line === 'a=sendrecv' || line === 'a=sendonly' || line === 'a=recvonly' || line === 'a=inactive') {
      dir = line.slice(2) as 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'
    }
  }
  flush()
  return dirs
}

/** Video directions in m-line order. Safari's answer must be legal against these. */
export function videoDirectionsFromSdp(sdp: string) {
  return sectionDirections(sdp, 'video')
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

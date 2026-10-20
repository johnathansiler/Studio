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

/**
 * Force low-latency Opus. Browser WebRTC generally floors frames at 10ms
 * even though libopus can go to 2.5ms, so ptime is clamped to 10–60ms.
 */
export function mungeOpusSdp(sdp: string, opts: OpusOptions = DEFAULT_OPUS): string {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const opusPts = new Set<string>()
  for (const line of lines) {
    const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000(?:\/2)?/i)
    if (match) opusPts.add(match[1])
  }
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
    const next: string[] = []
    const seenFmtp = new Set<string>()
    let wrotePtime = false
    for (const line of section) {
      if (line.startsWith('a=ptime:') || line.startsWith('a=maxptime:')) continue
      const fmtp = line.match(/^a=fmtp:(\d+)\s*(.*)$/)
      if (fmtp && opusPts.has(fmtp[1])) {
        next.push(fmtpFor(fmtp[1], fmtp[2]))
        seenFmtp.add(fmtp[1])
        continue
      }
      next.push(line)
      if (!wrotePtime && line.startsWith('a=rtpmap:')) {
        const pt = line.match(/^a=rtpmap:(\d+)/)?.[1]
        if (pt && opusPts.has(pt)) {
          next.push(`a=ptime:${ptime}`)
          next.push(`a=maxptime:${ptime}`)
          wrotePtime = true
        }
      }
    }
    if (!wrotePtime) {
      next.push(`a=ptime:${ptime}`)
      next.push(`a=maxptime:${ptime}`)
    }
    for (const pt of opusPts) {
      if (!seenFmtp.has(pt)) next.push(fmtpFor(pt))
    }
    return next
  })

  return rendered.flat().join('\r\n') + '\r\n'
}

/**
 * Safari answers a video m-line with a=recvonly when the track was attached
 * before setRemoteDescription, then cleared. The self-view still plays.
 * The host never receives that camera. Flip those sections to sendrecv
 * when we have a live local track. H.264 lines are left untouched.
 */
export function markOutboundVideo(sdp: string, send: Array<boolean | 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive'>): string {
  const lines = sdp.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const sections: string[][] = [[]]
  for (const line of lines) {
    if (line.startsWith('m=') && sections[sections.length - 1].length) sections.push([])
    sections[sections.length - 1].push(line)
  }
  let video = -1
  const rendered = sections.map((section) => {
    if (!section[0]?.startsWith('m=video')) return section
    video += 1
    const desired = send[video]
    if (!desired) return section
    const target = desired === true ? 'sendrecv' : desired
    return section.map((line) => (line === 'a=recvonly' || line === 'a=inactive' || line === 'a=sendonly' || line === 'a=sendrecv' ? `a=${target}` : line))
  })
  return rendered.flat().join('\r\n') + '\r\n'
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

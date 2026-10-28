/** Tracks the mix should pass. Mute wins. Solo opens the route to the master and keeps solo-safe returns. */
export interface AudibleTrack {
  id: string
  mute: boolean
  solo: boolean
  soloSafe?: boolean
  groupId?: string | null
  output?: string | null
  sends?: { busId: string; enabled: boolean }[]
}

export function audibleIds(tracks: AudibleTrack[]) {
  const heard = new Set<string>()
  const anySolo = tracks.some((track) => track.solo)
  if (!anySolo) {
    for (const track of tracks) if (!track.mute) heard.add(track.id)
    return heard
  }
  const queue = tracks.filter((track) => track.solo && !track.mute).map((track) => track.id)
  const sources = new Set(queue)
  while (queue.length) {
    const id = queue.pop()!
    for (const track of tracks) {
      if (track.mute || sources.has(track.id) || track.groupId !== id) continue
      sources.add(track.id)
      queue.push(track.id)
    }
  }
  for (const id of sources) heard.add(id)
  for (const track of tracks) if (track.soloSafe && !track.mute) heard.add(track.id)
  let grew = true
  while (grew) {
    grew = false
    for (const track of tracks) {
      if (!heard.has(track.id)) continue
      const dests = [track.groupId, track.output, ...(track.sends ?? []).filter((send) => send.enabled).map((send) => send.busId)]
      for (const dest of dests) {
        if (!dest || heard.has(dest)) continue
        const bus = tracks.find((item) => item.id === dest)
        if (!bus || bus.mute) continue
        heard.add(dest)
        grew = true
      }
    }
  }
  return heard
}

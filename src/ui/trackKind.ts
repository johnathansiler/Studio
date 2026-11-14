export function trackKindLabel(track: { type: string }) {
  if (track.type === 'audio') return 'Audio'
  if (track.type === 'bus') return 'Bus'
  if (track.type === 'group') return 'Group'
  if (track.type === 'midi') return 'Instrument'
  return 'Track'
}

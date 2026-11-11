/** Which page the Ideas sheet shows. Internal ids stay put; only the visible tab changes. */

export type IdeasPage = 'write' | 'players' | 'progressions'

/** `?ideas=1` is the chord-progression list. `?players=1` is the band. Otherwise Write. */
export function ideasPageFromSearch(search: string): IdeasPage {
  const params = new URLSearchParams(search)
  if (params.get('ideas') === '1') return 'progressions'
  if (params.get('players') === '1') return 'players'
  return 'write'
}

/** The sheet opens for the old Unstuck, Ideas, and Players links. */
export function ideasSheetRequested(search: string) {
  const params = new URLSearchParams(search)
  return params.get('unstuck') === '1' || params.get('ideas') === '1' || params.get('players') === '1'
}

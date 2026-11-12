/** Which small-button row the phone dock shows. Sheets open above the dock and never replace it. */

export type PhoneSheet = 'menu' | 'browse' | 'tools' | null
export type PhonePlace = 'arrange' | 'mix' | 'collab' | 'plugin' | 'other'
export type PhoneContextKind =
  | 'menu'
  | 'browse'
  | 'tools'
  | 'notes'
  | 'clip'
  | 'track'
  | 'mix'
  | 'collab'
  | 'plugin'
  | 'arrange'

export function phoneContextKind(input: {
  sheet: PhoneSheet
  place: PhonePlace
  notes: boolean
  clip: boolean
  /** The track header was tapped. A current track with no tap stays on the arrange row. */
  track: boolean
}): PhoneContextKind {
  /* Menu, Browse, and Tools pop above the dock. The edit row stays put. */
  if (input.place === 'mix') return 'mix'
  if (input.place === 'collab') return 'collab'
  if (input.place === 'plugin') return input.notes ? 'notes' : 'plugin'
  /* Arrange keeps Undo, Redo, Snap, Setup, metronome, and Punch, Tempo, Reset.
     A sheet or a track tap does not replace this row. */
  if (input.place === 'arrange') return 'arrange'
  if (input.notes) return 'notes'
  if (input.clip) return 'clip'
  return 'arrange'
}

export const BROWSER_TAB_EVENT = 'cueharbor-browser-tab'
export const CLOSE_ARRANGE_SHEETS = 'cueharbor-close-arrange-sheets'

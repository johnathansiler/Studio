/** Which small-button row the phone dock shows. Sheets win, then the screen, then the selection. */

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
  if (input.sheet === 'menu') return 'menu'
  if (input.sheet === 'browse') return 'browse'
  if (input.sheet === 'tools') return 'tools'
  if (input.place === 'mix') return 'mix'
  if (input.place === 'collab') return 'collab'
  if (input.notes) return 'notes'
  if (input.place === 'plugin') return 'plugin'
  /* Arrange keeps Undo, Redo, Snap, Setup, and the transport extras.
     Mute and Solo stay on the track header, so a track tap does not replace this row. */
  if (input.place === 'arrange') return 'arrange'
  if (input.clip) return 'clip'
  return 'arrange'
}

export const BROWSER_TAB_EVENT = 'cueharbor-browser-tab'
export const CLOSE_ARRANGE_SHEETS = 'cueharbor-close-arrange-sheets'

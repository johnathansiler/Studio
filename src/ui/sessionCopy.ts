import type { Copy, MenuSpec } from './chrome'

/** Session launcher copy. The build drops this module while FEATURES.session is false. */

export const SESSION_VIEW: Copy = {
  id: 'session',
  label: 'Session',
  hint: 'Launch clips in a grid. Tap a slot to play or record.',
}

export const SESSION_MENU: MenuSpec[] = [
  { id: 'session-view', action: 'session-mode', group: 'view', place: 'all', label: 'Launch', hint: 'Play clips from slots instead of the timeline.' },
  { id: 'arrangement', action: 'session-mode', group: 'view', place: 'all', label: 'Timeline', hint: 'Leave clip launching and go back to the arrangement.' },
  { id: 'capture', action: 'capture', group: 'view', place: 'phone', label: 'Capture', hint: 'Put the clips that are playing onto the timeline.' },
]

export const SESSION_SLOT: Copy = {
  id: 'slot',
  label: 'Slot',
  hint: 'Put this pattern in the first clip slot.',
}

export const SESSION_BAR: Copy[] = [
  { id: 'quant', label: 'Launch', hint: 'When a tapped clip starts: the next beat, bar, or immediately.' },
  { id: 'stop', label: 'Stop all', hint: 'Stop every launched clip on the next grid line.' },
  { id: 'clip', label: 'Clip', hint: 'How the selected slot launches, loops, and follows.' },
  { id: 'print', label: 'To arrangement', hint: 'Print the clips that are playing onto the timeline.' },
]

export const SESSION_SHEET: Copy[] = [
  { id: 'length', label: 'Record length', hint: 'How many bars a new clip records before it loops.' },
  { id: 'mode', label: 'Launch mode', hint: 'Toggle, gate, or one-shot when you tap the slot.' },
  { id: 'follow', label: 'Follow', hint: 'What the slot does when it finishes.' },
  { id: 'loop', label: 'Loop', hint: 'Repeat the clip instead of playing it once.' },
  { id: 'legato', label: 'Legato', hint: 'The next clip takes over without retriggering.' },
  { id: 'warp', label: 'Warp', hint: 'Stretch the audio to the song tempo.' },
]

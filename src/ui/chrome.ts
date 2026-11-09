import { FEATURES } from '../features'

/** Short labels and touch descriptions for the controls people see first. */

export interface Copy {
  id: string
  label: string
  hint: string
}

export const UNSTUCK_COPY: Copy = {
  id: 'unstuck',
  label: 'Ideas',
  hint: 'Pick a part, or write a full song. The MIDI stays editable.',
}

export const VIEW_COPY: Copy[] = [
  { id: 'arrange', label: 'Arrange', hint: 'Clips on a timeline. The tools above change what a tap does.' },
  { id: 'mix', label: 'Mix', hint: 'Level, pan, and effects for each track.' },
  { id: 'session', label: 'Session', hint: 'Launch clips in a grid. Tap a slot to play or record.' },
  { id: 'collab', label: 'Collab', hint: 'Call, video, and remote recording. Stays closed until you open this tab.' },
]

/** Tabs beside Collab. Collab itself is the first tab in the bar. Session stays in VIEW_COPY and returns with FEATURES.session. */
export function studioViewTabs(): Copy[] {
  return VIEW_COPY.filter((item) => item.id !== 'collab' && (FEATURES.session || item.id !== 'session'))
}

export const TRANSPORT_COPY: Copy[] = [
  { id: 'to-start', label: 'Start', hint: 'Move to bar 1. Playing keeps playing from the top. Stopped stays stopped.' },
  { id: 'play', label: 'Play', hint: 'Play from the playhead. After Stop, Play continues from there.' },
  { id: 'pause', label: 'Pause', hint: 'Pause playback. The playhead stays where it is.' },
  { id: 'stop', label: 'Stop', hint: 'Stop playback and recording. The playhead stays where it is.' },
  { id: 'record', label: 'Record', hint: 'Record onto armed tracks from the playhead.' },
  { id: 'click', label: 'Click', hint: 'Metronome while you play and record.' },
  { id: 'count-in', label: 'Count-in', hint: 'Count one bar before recording starts.' },
  { id: 'loop', label: 'Loop', hint: 'Repeat the highlighted region. Drag its edges to change the length.' },
  { id: 'tempo', label: 'Tempo', hint: 'Tap to set tempo. Pause after one tap to type an exact tempo. Scroll or the arrow keys nudge it.' },
  { id: 'tap', label: 'Tap', hint: 'Tap in time. The tempo follows your taps.' },
  { id: 'click', label: 'Click', hint: 'Metronome while you play and record.' },
  { id: 'count-in', label: 'Count', hint: 'Count off, one bar, or two bars before play and record.' },
  { id: 'reset', label: 'Reset', hint: 'Reset – fix glitches' },
]

/** Phone transport shows the same buttons as the desk. The menu does not repeat them. */
export const PHONE_TRANSPORT_MENU = [] as const

export const MENU_GROUPS = [
  { id: 'project', label: 'Project' },
  { id: 'edit', label: 'Edit' },
  { id: 'view', label: 'View' },
  { id: 'tools', label: 'Tools' },
  { id: 'settings', label: 'Settings' },
] as const

export type MenuGroupId = (typeof MENU_GROUPS)[number]['id']

/** Where a row is drawn. Phone omits desktop-only panel and plugin rows. */
export type MenuPlace = 'all' | 'desk' | 'phone'

export interface MenuSpec extends Copy {
  group: MenuGroupId
  place: MenuPlace
  /** One id per thing the row does. Alternates share an action and only one is shown. */
  action: string
}

/**
 * Each action appears once. Rows that repeat a tab, a track button, or a plugin insert
 * stay off this list: Session, Roll, Keys, Beat Machine, Generate, Sounds, and Collab.
 * Launch/Timeline is the session transport, which the Session tab does not switch.
 * Capture stays on the phone because the session bar hides that button there.
 * Play, Stop, Record, Loop, Click, Count-in, and Reset stay on the transport.
 * Select, Draw, Split, Trim, Zoom, Duplicate, Delete, and Snap stay on the strip.
 * Quantize stays in the piano roll and the beat pad, not on this strip.
 * While FEATURES.session is off, visibleMenu hides Launch, Timeline, and Capture.
 */
export const MENU_COPY: MenuSpec[] = [
  { id: 'new', action: 'new', group: 'project', place: 'all', label: 'New', hint: 'Start a fresh session. The timeline starts empty.' },
  { id: 'open', action: 'open', group: 'project', place: 'all', label: 'Open', hint: 'Open a project saved in this browser.' },
  { id: 'save', action: 'save', group: 'project', place: 'all', label: 'Save', hint: 'Keep this project in the browser.' },
  { id: 'export', action: 'export', group: 'project', place: 'all', label: 'Export', hint: 'Bounce or download the mix.' },
  { id: 'box', action: 'box', group: 'edit', place: 'all', label: 'Box', hint: 'Drag a rectangle to select several clips or notes.' },
  { id: 'erase', action: 'erase', group: 'edit', place: 'all', label: 'Erase', hint: 'Tap a clip or note to delete it. Drag to delete more.' },
  { id: 'pan', action: 'pan', group: 'edit', place: 'all', label: 'Scroll', hint: 'Scroll the timeline or the piano roll. This is not the mixer pan.' },
  { id: 'session-view', action: 'session-mode', group: 'view', place: 'all', label: 'Launch', hint: 'Play clips from slots instead of the timeline.' },
  { id: 'arrangement', action: 'session-mode', group: 'view', place: 'all', label: 'Timeline', hint: 'Leave clip launching and go back to the arrangement.' },
  { id: 'capture', action: 'capture', group: 'view', place: 'phone', label: 'Capture', hint: 'Put the clips that are playing onto the timeline.' },
  { id: 'dock-bottom', action: 'dock', group: 'view', place: 'desk', label: 'Bottom', hint: 'Move the side panel under the editor.' },
  { id: 'dock-side', action: 'dock', group: 'view', place: 'desk', label: 'Side', hint: 'Move the panel back beside the editor.' },
  { id: 'scaler', action: 'scaler', group: 'tools', place: 'desk', label: 'Scaler', hint: 'Chord instrument. Play pads, or open Write to generate MIDI.' },
  { id: 'midi', action: 'midi', group: 'tools', place: 'all', label: 'MIDI', hint: 'Learn knobs, effects, hardware out, live capture, and recording several inputs.' },
  { id: 'signature', action: 'signature', group: 'settings', place: 'all', label: 'Time', hint: 'Beats in each bar.' },
  { id: 'shortcuts', action: 'shortcuts', group: 'settings', place: 'all', label: 'Shortcuts', hint: 'Keys for play, record, and editing.' },
]

export function visibleMenu(input: {
  phone: boolean
  session: boolean
  dockBottom: boolean
  hardwareMidi: boolean
}): MenuSpec[] {
  const place = input.phone ? 'phone' : 'desk'
  return MENU_COPY.filter((item) => {
    if (!FEATURES.session && (item.action === 'session-mode' || item.action === 'capture')) return false
    if (item.place !== 'all' && item.place !== place) return false
    if (item.action === 'session-mode') return input.session ? item.id === 'arrangement' : item.id === 'session-view'
    if (item.action === 'dock') return input.dockBottom ? item.id === 'dock-side' : item.id === 'dock-bottom'
    if (item.action === 'midi') return input.hardwareMidi
    return true
  })
}

/** True when the open menu would show the same label or the same action twice. */
export function menuLabelsUnique(items: readonly Pick<MenuSpec, 'label' | 'action'>[]) {
  const labels = items.map((item) => item.label)
  const actions = items.map((item) => item.action)
  return new Set(labels).size === labels.length && new Set(actions).size === actions.length
}

export const PIANO_BAR: Copy[] = [
  { id: 'chords', label: 'Chords', hint: 'Pads of chords in the current key.' },
  { id: 'generate', label: 'Generate', hint: 'Open Scaler and write chords, bass, melody, arp, strum, or drums.' },
  { id: 'key', label: 'Key', hint: 'The key. Notes in the scale are marked on the keyboard.' },
  { id: 'scale', label: 'Scale', hint: 'Which notes are in key. Others show in amber.' },
  { id: 'snap', label: 'Snap', hint: 'New notes land on the scale.' },
  { id: 'grid', label: 'Grid', hint: 'How long a tapped note is, and where notes snap.' },
  { id: 'notes', label: 'Notes', hint: 'Quantize, arpeggio, strum, and other note edits.' },
]

export const PIANO_SHEET: Copy[] = [
  { id: 'detect', label: 'Detect key', hint: 'Guess the key from the notes in this clip.' },
  { id: 'ideas', label: 'Ideas', hint: 'Suggest chords that fit this clip.' },
  { id: 'slide', label: 'Slide', hint: 'Glide from the selected note into the next one.' },
  { id: 'quantize', label: 'Quantize', hint: 'Snap the selected notes onto the grid.' },
  { id: 'arp', label: 'Arp', hint: 'Turn the selected chord into an arpeggio.' },
  { id: 'strum', label: 'Strum', hint: 'Spread the selected chord like a strum.' },
  { id: 'duplicate', label: 'Duplicate', hint: 'Copy the selected notes and place them just after.' },
  { id: 'delete', label: 'Delete', hint: 'Remove the selected notes.' },
]

export const BEAT_BAR: Copy[] = [
  { id: 'pattern', label: 'Editing', hint: 'The pattern on this step grid. Song mode plays the clips you send to Arrange.' },
  { id: 'name', label: 'Pattern name', hint: 'Rename this pattern.' },
  { id: 'steps', label: 'Steps', hint: 'How many steps are in the pattern.' },
  { id: 'swing', label: 'Swing', hint: 'Push the off-beats late.' },
  { id: 'edit', label: 'Edit', hint: 'Fills, variations, and placing the pattern on the timeline.' },
]

export const BEAT_ROW: Copy[] = [
  { id: 'mute', label: 'Mute', hint: 'Silence this row.' },
  { id: 'solo', label: 'Solo', hint: 'Hear only this row.' },
  { id: 'volume', label: 'Vol', hint: 'How loud this row is.' },
  { id: 'pan', label: 'Pan', hint: 'Left or right.' },
  { id: 'output', label: 'Track', hint: 'Where this row plays.' },
  { id: 'steps', label: 'Steps', hint: 'How many steps this row has.' },
  { id: 'swing', label: 'Swing', hint: 'Swing for this row. Empty uses the pattern swing.' },
  { id: 'copy', label: 'Copy', hint: 'Copy this row of steps.' },
  { id: 'paste', label: 'Paste', hint: 'Paste copied steps onto this row.' },
  { id: 'more', label: 'More', hint: 'Volume, pan, track, length, copy, and paste.' },
  { id: 'less', label: 'Less', hint: 'Hide volume, pan, track, length, copy, and paste.' },
]

export const BEAT_SHEET: Copy[] = [
  { id: 'color', label: 'Color', hint: 'Color of this pattern on the timeline.' },
  { id: 'clone', label: 'Clone', hint: 'Copy this pattern into a new one.' },
  { id: 'fill-2', label: 'Fill every 2', hint: 'Put a hit on every second step of the selected row.' },
  { id: 'fill-4', label: 'Fill every 4', hint: 'Put a hit on every fourth step.' },
  { id: 'fill-8', label: 'Fill every 8', hint: 'Put a hit on every eighth step.' },
  { id: 'rand', label: 'Randomize', hint: 'Scatter hits across the pattern.' },
  { id: 'human', label: 'Humanize', hint: 'Nudge timing and velocity so it feels less rigid.' },
  { id: 'left', label: 'Shift left', hint: 'Rotate every hit one step earlier.' },
  { id: 'right', label: 'Shift right', hint: 'Rotate every hit one step later.' },
  { id: 'place', label: 'To Arrange', hint: 'Place this pattern on the Arrange timeline at the playhead.' },
  { id: 'slot', label: 'Slot', hint: 'Put this pattern in the first clip slot.' },
]

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

export const TRACK_ROW: Copy[] = [
  { id: 'mute', label: 'Mute', hint: 'Silence this track. The others keep playing.' },
  { id: 'solo', label: 'Solo', hint: 'Hear only this track.' },
  { id: 'arm', label: 'Arm', hint: 'This track records when you press record.' },
]

export const TRACK_SHEET: Copy[] = [
  { id: 'monitor', label: 'Input monitor', hint: 'Hear the input while you record.' },
  { id: 'volume', label: 'Volume', hint: 'How loud this track is.' },
  { id: 'input', label: 'Input', hint: 'Which mic or guest this track records.' },
  { id: 'scaler', label: 'Scaler', hint: 'Chord instrument. Key, pads, and progressions on this track.' },
  { id: 'rack', label: 'Rack', hint: 'The instrument and effects on this track.' },
  { id: 'keys', label: 'Keys', hint: 'Play this instrument on a keyboard.' },
  { id: 'drums', label: 'Open Beat Machine', hint: 'Beat machine. Banks of pads, and record on this track.' },
  { id: 'remove', label: 'Remove track', hint: 'Delete this track and its clips.' },
]

export const RECORD_COPY: Copy[] = [
  { id: 'options', label: 'Record options', hint: 'Loop record, punch in and out, and which input is armed.' },
  { id: 'cycle', label: 'Cycle', hint: 'Record in a loop and keep each pass.' },
  { id: 'punch', label: 'Punch', hint: 'Record only between the in and out points.' },
  { id: 'in', label: 'In', hint: 'Set the punch-in point at the playhead.' },
  { id: 'out', label: 'Out', hint: 'Set the punch-out point at the playhead.' },
  { id: 'quick', label: 'Quick', hint: 'Punch in and out with the next two taps.' },
  { id: 'pre', label: 'Pre-roll', hint: 'How much to play before the punch.' },
  { id: 'post', label: 'Post-roll', hint: 'How much to play after the punch.' },
  { id: 'unit', label: 'Roll unit', hint: 'Pre-roll and post-roll are in bars or seconds.' },
  { id: 'input', label: 'Track input', hint: 'Which mic or guest the selected track records.' },
  { id: 'midi-loop', label: 'MIDI passes', hint: 'Keep each pass, or merge them into one clip.' },
  { id: 'save-take', label: 'Save MIDI take', hint: 'Keep this pass so you can return to it.' },
  { id: 'midi-take', label: 'MIDI take', hint: 'Switch between recorded passes.' },
  { id: 'comp', label: 'Comp', hint: 'Which combination of takes is playing.' },
  { id: 'save-comp', label: 'Save comp', hint: 'Remember this combination of takes.' },
  { id: 'flatten', label: 'Flatten', hint: 'Render the comp into one clip.' },
  { id: 'merge', label: 'Merge', hint: 'Flatten the comp and keep the source takes.' },
]

export const CALL_COPY: Copy[] = [
  { id: 'mic', label: 'Mic', hint: 'Your talkback mic in the call. This is not the recording input.' },
  { id: 'cam', label: 'Cam', hint: 'Show or hide your camera.' },
  { id: 'share', label: 'Share', hint: 'Share your screen with the room.' },
  { id: 'settings', label: 'Call setup', hint: 'Your sound, recording delay, and which devices to use.' },
  { id: 'monitor', label: 'Monitor', hint: 'Switch the cue you hear between Opus and PCM.' },
  { id: 'create', label: 'Host a Collab', hint: 'Start a session and get a link to share.' },
  { id: 'join', label: 'Join a Collab', hint: 'Enter or paste an invite code or link.' },
  { id: 'new', label: 'New', hint: 'Start a fresh room and leave this one.' },
]

export function copyOf(list: readonly Copy[], id: string): Copy {
  const found = list.find((item) => item.id === id)
  if (!found) throw new Error(`missing control copy: ${id}`)
  return found
}

export function described(copy: Copy) {
  return {
    title: copy.hint,
    'aria-label': `${copy.label}. ${copy.hint}`,
  }
}

export function idsOf(list: readonly { id: string }[]) {
  return list.map((item) => item.id)
}

/** True when the same id is offered twice, which would show two buttons for one action. */
export function sharesId(a: readonly { id: string }[], b: readonly { id: string }[]) {
  const ids = new Set(a.map((item) => item.id))
  return b.filter((item) => ids.has(item.id)).map((item) => item.id)
}

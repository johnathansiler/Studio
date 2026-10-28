/** Short labels and touch descriptions for the controls people see first. */

export interface Copy {
  id: string
  label: string
  hint: string
}

export const UNSTUCK_COPY: Copy = {
  id: 'unstuck',
  label: 'Unstuck',
  hint: 'Suggest the next chord, section, transition, or arrangement.',
}

export const VIEW_COPY: Copy[] = [
  { id: 'arrange', label: 'Arrange', hint: 'Clips on a timeline. The tools above change what a tap does.' },
  { id: 'mix', label: 'Mix', hint: 'Level, pan, and effects for each track.' },
  { id: 'beats', label: 'Beats', hint: 'Step sequencer. Tap a pad to add a hit.' },
  { id: 'session', label: 'Session', hint: 'The video call. See people and talk while you play.' },
]

export const TRANSPORT_COPY: Copy[] = [
  { id: 'to-start', label: 'To start', hint: 'Move the playhead back to the beginning.' },
  { id: 'play', label: 'Play', hint: 'Play from the playhead.' },
  { id: 'stop', label: 'Stop', hint: 'Stop playback and recording.' },
  { id: 'record', label: 'Record', hint: 'Record onto armed tracks from the playhead.' },
  { id: 'loop', label: 'Loop', hint: 'Repeat the highlighted region.' },
  { id: 'tempo', label: 'Tempo', hint: 'Tap the number to set the tempo. Hold it for half-time, double-time, and rounding.' },
]

/** On a phone these leave the transport and live in the menu, so Play stays reachable. */
export const PHONE_TRANSPORT_MENU = ['to-start', 'loop'] as const

export const MENU_COPY: Copy[] = [
  { id: 'save', label: 'Save', hint: 'Keep this project in the browser.' },
  { id: 'export', label: 'Export', hint: 'Bounce or download the mix.' },
  { id: 'clips', label: 'Clips', hint: 'Launch clips in slots, like a live set.' },
  { id: 'keys', label: 'Keys', hint: 'Play the instrument on a keyboard.' },
  { id: 'pads', label: 'Pads', hint: 'Play drums on pads.' },
  { id: 'piano', label: 'Piano', hint: 'Open the piano roll for the instrument track.' },
  { id: 'quantize', label: 'Quantize', hint: 'Snap the selected notes onto the grid.' },
  { id: 'quantize-more', label: 'Quantize…', hint: 'Choose the grid and how hard to snap.' },
  { id: 'click', label: 'Click', hint: 'Metronome while you play and record.' },
  { id: 'count-in', label: 'Count-in', hint: 'Count one bar before recording starts.' },
  { id: 'snap', label: 'Snap', hint: 'Line clip edits up to the beat.' },
  { id: 'to-start', label: 'To start', hint: 'Move the playhead back to the beginning.' },
  { id: 'loop', label: 'Loop', hint: 'Repeat the highlighted region.' },
  { id: 'arrangement', label: 'Arrangement', hint: 'Leave clip launching and go back to the timeline.' },
  { id: 'session-view', label: 'Session view', hint: 'Launch clips in slots instead of the timeline.' },
  { id: 'capture', label: 'Capture', hint: 'Put the clips that are playing onto the timeline.' },
  { id: 'artist', label: 'Artist', hint: 'A simpler screen for performing in the call.' },
  { id: 'studio', label: 'Studio', hint: 'The full editor: timeline, mix, and beats.' },
  { id: 'dock-bottom', label: 'Bottom', hint: 'Move the side panel under the editor.' },
  { id: 'dock-side', label: 'Side', hint: 'Move the panel back beside the editor.' },
  { id: 'shortcuts', label: 'Shortcuts', hint: 'Keys for play, record, and editing.' },
]

export const PIANO_BAR: Copy[] = [
  { id: 'chords', label: 'Chords', hint: 'Pads of chords in the current key.' },
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
  { id: 'pattern', label: 'Pattern', hint: 'Which drum pattern you are editing.' },
  { id: 'name', label: 'Pattern name', hint: 'Rename this pattern.' },
  { id: 'steps', label: 'Steps', hint: 'How many steps are in the pattern.' },
  { id: 'swing', label: 'Swing', hint: 'Push the off-beats late.' },
  { id: 'edit', label: 'Edit', hint: 'Fills, variations, and placing the pattern on the timeline.' },
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
  { id: 'place', label: 'Place', hint: 'Drop this pattern on the timeline at the playhead.' },
  { id: 'slot', label: 'Slot', hint: 'Put this pattern in the first clip slot.' },
]

export const SESSION_BAR: Copy[] = [
  { id: 'quant', label: 'Launch', hint: 'When a tapped clip starts: the next beat, bar, or immediately.' },
  { id: 'stop', label: 'Stop all', hint: 'Stop every launched clip.' },
  { id: 'clip', label: 'Clip', hint: 'How the selected slot launches, loops, and follows.' },
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
  { id: 'rack', label: 'Rack', hint: 'The instrument and effects on this track.' },
  { id: 'keys', label: 'Keys', hint: 'Play this instrument on a keyboard.' },
  { id: 'drums', label: 'Pads', hint: 'Play this instrument on drum pads.' },
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
  { id: 'settings', label: 'Call setup', hint: 'Cue mix, calibration, jam, and devices.' },
  { id: 'monitor', label: 'Monitor', hint: 'Switch the cue you hear between Opus and PCM.' },
  { id: 'create', label: 'Create invite', hint: 'Start a room and get a link to share.' },
  { id: 'join', label: 'Join', hint: 'Enter a room with an invite code.' },
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

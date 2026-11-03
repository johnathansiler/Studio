/** Computer keys, matching the piano roll and step entry. A is middle C before the octave shift. */
export const KEY_NOTES: Record<string, number> = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
  KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
}

export const LETTER_NOTES: Record<string, number> = {
  a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71,
}

export const KEYBOARD_KEY = 'cueharbor-keyboard'
export const KEYBOARD_OCTAVE_KEY = 'cueharbor-keyboard-octave'

/** On-screen keys start at C3 when the shift is 0. */
export const KEYBOARD_OCTAVE_MIN = -4
export const KEYBOARD_OCTAVE_MAX = 5

export function clampKeyboardOctave(octave: number) {
  if (!Number.isFinite(octave)) return 0
  return Math.max(KEYBOARD_OCTAVE_MIN, Math.min(KEYBOARD_OCTAVE_MAX, Math.round(octave)))
}

/** MIDI note of the C that labels the on-screen octave. */
export function keyboardStart(octave: number) {
  return 48 + clampKeyboardOctave(octave) * 12
}

export type KeyClaim = 'note' | 'octave-down' | 'octave-up' | 'repeat'

export function keyboardHome(code: string, key: string): number | null {
  if (KEY_NOTES[code] != null) return KEY_NOTES[code]
  const letter = key.toLowerCase()
  return LETTER_NOTES[letter] ?? null
}

export function keyboardPitch(home: number, octave: number): number {
  return Math.max(0, Math.min(127, home + octave * 12))
}

/** Z lowers the octave. X raises it. Anything else is not an octave key. */
export function octaveKey(key: string): -1 | 1 | null {
  const letter = key.toLowerCase()
  if (letter === 'z') return -1
  if (letter === 'x') return 1
  return null
}

/**
 * What a computer key should do while the Keyboard toggle is on.
 * Typing fields, command shortcuts, and a key that is already held do not start another note.
 * A key this function does not claim is left for the normal shortcuts.
 */
export function claimComputerKey(input: {
  enabled: boolean
  typing: boolean
  meta: boolean
  alt: boolean
  repeat: boolean
  held: boolean
  code: string
  key: string
}): KeyClaim | null {
  if (!input.enabled || input.typing || input.meta || input.alt) return null
  if (octaveKey(input.key) === -1) return 'octave-down'
  if (octaveKey(input.key) === 1) return 'octave-up'
  if (keyboardHome(input.code, input.key) == null) return null
  if (input.repeat || input.held) return 'repeat'
  return 'note'
}

/** The selected MIDI track. Nothing else is a fallback. */
export function keyboardTarget(tracks: { id: string; type: string; armed: boolean }[], selectedId: string | null): string | null {
  const selected = tracks.find((track) => track.id === selectedId)
  if (selected?.type === 'midi') return selected.id
  return null
}

export function readKeyboardEnabled(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage): boolean {
  try {
    return storage?.getItem(KEYBOARD_KEY) === 'on'
  } catch {
    return false
  }
}

export function writeKeyboardEnabled(on: boolean, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    storage?.setItem(KEYBOARD_KEY, on ? 'on' : 'off')
  } catch {
    /* private mode keeps the choice for this visit */
  }
}

export function readKeyboardOctave(storage: Pick<Storage, 'getItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    return clampKeyboardOctave(Number(storage?.getItem(KEYBOARD_OCTAVE_KEY)))
  } catch {
    return 0
  }
}

export function writeKeyboardOctave(octave: number, storage: Pick<Storage, 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage) {
  try {
    storage?.setItem(KEYBOARD_OCTAVE_KEY, String(clampKeyboardOctave(octave)))
  } catch {
    /* private mode keeps the choice for this visit */
  }
}

/** The selected instrument, and its open clip when that clip belongs to it. */
export function keyboardDestination(
  tracks: { id: string; type: string; armed: boolean; midiClips?: { id: string; startBeat: number }[] }[],
  selectedTrackId: string | null,
  selectedClipId: string | null,
): { trackId: string; clipId: string | null; clipStart: number } | null {
  const trackId = keyboardTarget(tracks, selectedTrackId)
  if (!trackId) return null
  const track = tracks.find((item) => item.id === trackId)
  if (selectedClipId) {
    const clip = track?.midiClips?.find((item) => item.id === selectedClipId)
    if (clip) return { trackId, clipId: clip.id, clipStart: clip.startBeat }
  }
  return { trackId, clipId: null, clipStart: 0 }
}

/** The piano roll handles its own keys while it is on screen, so the dock does not play them twice. */
let rollKeysOwned = false

export function setRollOwnsKeys(on: boolean) {
  rollKeysOwned = on
}

export function rollOwnsKeys() {
  return rollKeysOwned
}

import { parseDeviceDrag } from './sessionBoard'

/** What a pointer or drop is carrying. */
export type SessionDrag =
  | { kind: 'sound'; id: string }
  | { kind: 'device'; device: 'audio' | 'midi' | 'instrument'; id: string }
  | { kind: 'clip'; trackId: string; clipId: string }

/** Where it landed. Scene 0 is the first slot, the same index as Scene 1. */
export type SessionTarget =
  | { kind: 'slot'; trackId: string; scene: number; trackType: string }
  | { kind: 'header'; trackId: string; trackType: string }

export type SessionDrop =
  | { action: 'place-sound'; trackId: string; scene: number; id: string }
  | { action: 'load-instrument'; trackId: string; id: string }
  | { action: 'add-audio-device'; trackId: string; id: string }
  | { action: 'add-midi-device'; trackId: string; id: string }
  | { action: 'move-clip'; fromTrackId: string; clipId: string; trackId: string; scene: number }
  | { action: 'reject'; reason: string }

export type SlotPart = 'body' | 'launch' | 'stop'
export type SlotGesture = 'select' | 'launch' | 'stop' | 'edit'

/** Body selects. The triangle launches. The stop square stops. A second click edits. */
export function slotGesture(part: SlotPart, clicks: 1 | 2): SlotGesture {
  if (part === 'stop') return 'stop'
  if (part === 'launch') return 'launch'
  return clicks === 2 ? 'edit' : 'select'
}

/** Double-click on an empty MIDI or instrument slot creates a clip. A plain click does not. */
export function createsEmptyMidiClip(trackType: string, gesture: SlotGesture, hasClip: boolean): boolean {
  return gesture === 'edit' && !hasClip && trackType === 'midi'
}

/**
 * Count-in is for recording. A session clip launch starts on the grid without one.
 * Transport play keeps its existing count-in. Recording still counts in.
 */
export function shouldCountIn(input: { enabled: boolean; stopped: boolean; intent: 'play' | 'record' | 'session-launch' }): boolean {
  if (!input.enabled || !input.stopped) return false
  return input.intent !== 'session-launch'
}

export function parseSessionDrag(text: string): SessionDrag | null {
  const clip = /^cueharbor-clip:([^:]+):([^:]+)$/.exec(text)
  if (clip) return { kind: 'clip', trackId: clip[1], clipId: clip[2] }
  if (text.startsWith('cueharbor-sound:')) {
    const id = text.slice('cueharbor-sound:'.length)
    return id ? { kind: 'sound', id } : null
  }
  const device = parseDeviceDrag(text)
  if (!device) return null
  return { kind: 'device', device: device.kind, id: device.id }
}

export function targetFromAttrs(attrs: {
  slotTrack?: string | null
  slotScene?: string | null
  headTrack?: string | null
  trackType?: string | null
}): SessionTarget | null {
  const trackType = attrs.trackType || ''
  if (attrs.slotTrack) {
    const scene = Number(attrs.slotScene)
    if (!Number.isInteger(scene) || scene < 0) return null
    return { kind: 'slot', trackId: attrs.slotTrack, scene, trackType }
  }
  if (attrs.headTrack) return { kind: 'header', trackId: attrs.headTrack, trackType }
  return null
}

export function planSessionDrop(drag: SessionDrag, target: SessionTarget): SessionDrop {
  if (drag.kind === 'sound') {
    if (target.kind !== 'slot') return { action: 'reject', reason: 'Drop sounds onto a slot.' }
    if (target.trackType !== 'audio') return { action: 'reject', reason: 'Drop sounds on an audio track.' }
    return { action: 'place-sound', trackId: target.trackId, scene: target.scene, id: drag.id }
  }
  if (drag.kind === 'clip') {
    if (target.kind !== 'slot') return { action: 'reject', reason: 'Drop the clip onto a slot.' }
    return { action: 'move-clip', fromTrackId: drag.trackId, clipId: drag.clipId, trackId: target.trackId, scene: target.scene }
  }
  if (drag.device === 'instrument') {
    if (target.trackType !== 'midi') return { action: 'reject', reason: 'That instrument goes on a MIDI track.' }
    return { action: 'load-instrument', trackId: target.trackId, id: drag.id }
  }
  if (drag.device === 'audio') return { action: 'add-audio-device', trackId: target.trackId, id: drag.id }
  if (target.trackType !== 'midi') return { action: 'reject', reason: 'That device goes on a MIDI track.' }
  return { action: 'add-midi-device', trackId: target.trackId, id: drag.id }
}

export interface SlotLabel {
  text: string
  /** Full name, with the duplicate number when there is one. */
  title: string
  badge: string | null
}

/** The second clip with the same name shows 2, and the number is not part of the truncated text. */
export function slotLabels(names: (string | null)[]): SlotLabel[] {
  const totals = new Map<string, number>()
  for (const name of names) {
    if (!name) continue
    totals.set(name, (totals.get(name) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  return names.map((name) => {
    if (!name) return { text: '', title: '', badge: null }
    const total = totals.get(name) ?? 1
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    if (total < 2 || n < 2) return { text: name, title: name, badge: null }
    return { text: name, title: `${name} ${n}`, badge: String(n) }
  })
}

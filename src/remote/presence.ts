/**
 * Live editing awareness for a collab room.
 *
 * The existing `t: 'presence'` message is the media roster (hand, mic, camera).
 * Editing state rides a separate `t: 'aware'` relay on the same /ws room so the
 * two cannot clobber each other. The server stamps id, name, and color.
 * Peers drop out on `peer-left` and after `AWARE_TIMEOUT_MS` without a message.
 */

export const AWARE_TYPE = 'aware' as const
export const AWARE_THROTTLE_MS = 100
export const AWARE_URGENT_MS = 40
export const AWARE_HEARTBEAT_MS = 2500
export const AWARE_TIMEOUT_MS = 8000
export const AWARE_RELAY_MIN_MS = 40
export const AWARE_LIST_MAX = 32
export const AWARE_ID_MAX = 64

export const PRESENCE_COLORS = [
  '#e25b45',
  '#e0b15a',
  '#73c48f',
  '#6cb6e0',
  '#c58bdb',
  '#ef8f6a',
  '#f2d48a',
  '#8fd0c4',
] as const

export interface EditCursor {
  clipId: string
  beat: number
  pitch: number
}

export interface RollClip {
  id: string
  startBeat: number
  durationBeats: number
  loop?: boolean
  notes?: readonly { startBeat: number; durationBeats: number }[]
}

export interface LocalAwareness {
  name: string
  /** Transport playhead in project samples. */
  cursorSample: number
  /** Beat inside the open piano-roll clip, or null when the roll is closed. */
  rollBeat: number | null
  rollPitch: number | null
  rollClipId: string | null
  selectedClipIds: string[]
  selectedNoteIds: string[]
  trackId: string | null
  playing: boolean
  recording: boolean
}

export type PresenceAccess = 'view' | 'comment' | 'edit'

export interface RemotePresence extends LocalAwareness {
  id: string
  color: string
  /** Server seat. View and Comment are visible, and only Edit may show Recording. */
  access: PresenceAccess
  seenAt: number
}

export interface AwareMessage {
  t: typeof AWARE_TYPE
  id: string
  name: string
  color: string
  cursorSample: number
  rollBeat: number | null
  rollPitch: number | null
  rollClipId: string | null
  clips: string[]
  notes: string[]
  trackId: string | null
  playing: boolean
  recording: boolean
  access: PresenceAccess
}

export interface AwarenessOptions {
  now?: () => number
  throttleMs?: number
  urgentMs?: number
  heartbeatMs?: number
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (id: unknown) => void
}

const EMPTY_PEERS: RemotePresence[] = []

export function presenceColor(id: string) {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 33 + id.charCodeAt(i)) >>> 0
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]
}

export function presenceInitial(name: string) {
  const trimmed = name.trim()
  const char = trimmed[0]
  return char ? char.toUpperCase() : '?'
}

export function awareRelayDue(lastAt: number, now: number, min = AWARE_RELAY_MIN_MS) {
  return !lastAt || now - lastAt >= min
}

export function presenceAccess(value: unknown): PresenceAccess | null {
  if (value === 'view' || value === 'comment' || value === 'edit') return value
  return null
}

export function presenceRoleLabel(access: PresenceAccess | undefined) {
  if (access === 'view') return 'View'
  if (access === 'comment') return 'Comment'
  return ''
}

/** Server relay. `peerId`, `peerName`, and `access` win over anything in the payload. */
export function relayAware(peerId: string, peerName: string, msg: Record<string, unknown>, access?: PresenceAccess): AwareMessage | null {
  const id = cleanId(peerId)
  if (!id) return null
  const cursor = finite(msg.cursorSample, 0, 1e15)
  if (cursor == null) return null
  const role = access ?? presenceAccess(msg.access) ?? 'edit'
  return {
    t: AWARE_TYPE,
    id,
    name: cleanName(peerName),
    color: presenceColor(id),
    cursorSample: Math.round(cursor),
    rollBeat: optionalFinite(msg.rollBeat, 0, 1e6, 3),
    rollPitch: optionalInt(msg.rollPitch, 0, 127),
    rollClipId: optionalId(msg.rollClipId),
    clips: idList(msg.clips),
    notes: idList(msg.notes),
    trackId: optionalId(msg.trackId),
    playing: msg.playing === true,
    recording: role === 'edit' && msg.recording === true,
    access: role,
  }
}

export function parseAware(msg: unknown, seenAt: number): RemotePresence | null {
  if (!msg || typeof msg !== 'object') return null
  const row = msg as Record<string, unknown>
  if (row.t !== AWARE_TYPE) return null
  const relay = relayAware(String(row.id || ''), String(row.name || ''), row)
  if (!relay) return null
  return {
    id: relay.id,
    name: relay.name,
    color: relay.color,
    cursorSample: relay.cursorSample,
    rollBeat: relay.rollBeat,
    rollPitch: relay.rollPitch,
    rollClipId: relay.rollClipId,
    selectedClipIds: relay.clips,
    selectedNoteIds: relay.notes,
    trackId: relay.trackId,
    playing: relay.playing,
    recording: relay.recording,
    access: relay.access,
    seenAt,
  }
}

/** Beat inside the open roll. A pointer on that clip wins over the playhead. */
export function chooseRollCursor(input: {
  open: boolean
  clip: RollClip | null
  songBeat: number
  pointer: EditCursor | null
}) {
  if (!input.open || !input.clip) return { rollBeat: null as number | null, rollPitch: null as number | null, rollClipId: null as string | null }
  const clipId = cleanId(input.clip.id)
  if (!clipId) return { rollBeat: null, rollPitch: null, rollClipId: null }
  const pointer = input.pointer
  if (pointer && cleanId(pointer.clipId) === clipId) {
    return {
      rollBeat: roundTo(clamp(pointer.beat, 0, 1e6), 3),
      rollPitch: Math.round(clamp(pointer.pitch, 0, 127)),
      rollClipId: clipId,
    }
  }
  return {
    rollBeat: foldRollBeat(input.songBeat, input.clip, rollViewBeats(input.clip)),
    rollPitch: null,
    rollClipId: clipId,
  }
}

export function localAwareness(input: {
  name: string
  cursorSample: number
  songBeat: number
  trackId: string | null
  clipIds: readonly string[]
  noteIds: readonly string[]
  playing: boolean
  recording: boolean
  rollOpen: boolean
  clip: RollClip | null
  rollTrackId: string | null
  pointer: EditCursor | null
}): LocalAwareness {
  const roll = chooseRollCursor({
    open: input.rollOpen,
    clip: input.clip,
    songBeat: input.songBeat,
    pointer: input.pointer,
  })
  return {
    name: cleanName(input.name),
    cursorSample: Math.round(clamp(input.cursorSample, 0, 1e15)),
    rollBeat: roll.rollBeat,
    rollPitch: roll.rollPitch,
    rollClipId: roll.rollClipId,
    selectedClipIds: idList(input.clipIds),
    selectedNoteIds: idList(input.noteIds),
    trackId: roll.rollClipId && input.rollTrackId ? optionalId(input.rollTrackId) : optionalId(input.trackId),
    playing: input.playing === true,
    recording: input.recording === true,
  }
}

export function editorsOnTrack(peers: readonly RemotePresence[], trackId: string) {
  return peers.filter((peer) => peer.trackId === trackId)
}

export function outlinePeer(peers: readonly RemotePresence[], clipId: string) {
  for (const peer of peers) {
    if (peer.selectedClipIds.includes(clipId)) return peer
  }
  return null
}

export function noteOutline(peers: readonly RemotePresence[], noteId: string, clipId: string) {
  for (const peer of peers) {
    if (peer.rollClipId && peer.rollClipId !== clipId) continue
    if (peer.selectedNoteIds.includes(noteId)) return peer
  }
  return null
}

let editCursor: EditCursor | null = null
const pokes = new Set<() => void>()

export function onPresencePoke(fn: () => void) {
  pokes.add(fn)
  return () => {
    pokes.delete(fn)
  }
}

export function currentEditCursor() {
  return editCursor
}

export function setEditCursor(next: EditCursor | null) {
  const quantized = next
    ? {
        clipId: cleanId(next.clipId) || next.clipId.slice(0, AWARE_ID_MAX),
        beat: Math.round(Math.max(0, next.beat) * 50) / 50,
        pitch: Math.max(0, Math.min(127, Math.round(next.pitch))),
      }
    : null
  if (sameCursor(editCursor, quantized)) return
  editCursor = quantized
  for (const fn of pokes) fn()
}

let bound: AwarenessChannel | null = null
const bindListeners = new Set<() => void>()

export function bindAwareness(channel: AwarenessChannel | null) {
  bound = channel
  for (const fn of bindListeners) fn()
}

export function currentAwareness() {
  return bound
}

export function subscribeAwarenessBinding(fn: () => void) {
  bindListeners.add(fn)
  return () => {
    bindListeners.delete(fn)
  }
}

interface KeyParts {
  all: string
  rest: string
}

export class AwarenessChannel {
  private peers = new Map<string, RemotePresence>()
  private cached: RemotePresence[] = EMPTY_PEERS
  private listeners = new Set<() => void>()
  private selfId = ''
  private lastAll = ''
  private lastRest = ''
  private lastSentAt = 0
  private sent = false
  private queued: { id: string; state: LocalAwareness } | null = null
  private timer: unknown = null
  private timerDue = 0
  private sweep: unknown = null
  private dead = false
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly urgentMs: number
  private readonly heartbeatMs: number
  private readonly timeoutMs: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void
  private readonly clearInterval: (id: unknown) => void
  private readonly send: (message: AwareMessage) => void

  constructor(send: (message: AwareMessage) => void, opts: AwarenessOptions = {}) {
    this.send = send
    this.now = opts.now ?? (() => Date.now())
    this.throttleMs = opts.throttleMs ?? AWARE_THROTTLE_MS
    this.urgentMs = opts.urgentMs ?? AWARE_URGENT_MS
    this.heartbeatMs = opts.heartbeatMs ?? AWARE_HEARTBEAT_MS
    this.timeoutMs = opts.timeoutMs ?? AWARE_TIMEOUT_MS
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
    this.clearInterval = opts.clearInterval ?? ((id) => clearInterval(id as ReturnType<typeof setInterval>))
    const startInterval = opts.setInterval ?? ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms)
      ;(id as { unref?: () => void }).unref?.()
      return id
    })
    this.sweep = startInterval(() => this.expire(), Math.min(1000, this.timeoutMs))
  }

  setSelf(id: string) {
    if (this.selfId === id) return
    this.selfId = id
    if (id && this.peers.delete(id)) this.touch()
  }

  publish(id: string, state: LocalAwareness) {
    if (this.dead || !id) return false
    const next = sanitizeLocal(state)
    const parts = splitKey(next)
    const now = this.now()
    const changed = parts.all !== this.lastAll
    const urgent = parts.rest !== this.lastRest
    const heartbeat = !changed && this.sent && now - this.lastSentAt >= this.heartbeatMs
    if (!changed && !heartbeat) return false
    const wait = urgent ? this.urgentMs : this.throttleMs
    if (this.sent && changed && now - this.lastSentAt < wait) {
      this.queued = { id, state: next }
      this.arm(wait - (now - this.lastSentAt))
      return false
    }
    this.flush(id, next, parts, now)
    return true
  }

  ingest(msg: unknown) {
    if (this.dead) return false
    const peer = parseAware(msg, this.now())
    if (!peer || (this.selfId && peer.id === this.selfId)) return false
    const prev = this.peers.get(peer.id)
    this.peers.set(peer.id, peer)
    if (!sameVisible(prev, peer)) this.touch()
    return true
  }

  forget(id: string) {
    if (!id || !this.peers.delete(id)) return false
    this.touch()
    return true
  }

  clear() {
    if (!this.peers.size) return
    this.peers.clear()
    this.touch()
  }

  expire(now = this.now()) {
    const dropped: string[] = []
    for (const [id, peer] of this.peers) {
      if (now - peer.seenAt > this.timeoutMs) {
        this.peers.delete(id)
        dropped.push(id)
      }
    }
    if (dropped.length) this.touch()
    return dropped
  }

  peersView() {
    return this.cached
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Stop sending. Remote cursors stay until leave or timeout. */
  silence() {
    this.queued = null
    this.disarm()
    this.sent = false
    this.lastAll = ''
    this.lastRest = ''
  }

  dispose() {
    this.dead = true
    this.silence()
    this.clearInterval(this.sweep)
    this.sweep = null
    this.peers.clear()
    this.cached = EMPTY_PEERS
    const listeners = this.listeners
    this.listeners = new Set()
    for (const fn of listeners) fn()
  }

  private flush(id: string, state: LocalAwareness, parts: KeyParts, now: number) {
    this.queued = null
    this.disarm()
    const message = relayAware(id, state.name, wireFields(state))
    if (!message) return
    this.lastAll = parts.all
    this.lastRest = parts.rest
    this.lastSentAt = now
    this.sent = true
    try {
      this.send(message)
    } catch {
      /* the socket can close between the ready check and the write */
    }
  }

  private arm(ms: number) {
    const wait = Math.max(0, ms)
    const due = this.now() + wait
    if (this.timer != null && this.timerDue <= due + 1) return
    this.disarm()
    this.timerDue = due
    this.timer = this.setTimer(() => {
      this.timer = null
      const queued = this.queued
      this.queued = null
      if (!queued || this.dead) return
      this.flush(queued.id, queued.state, splitKey(queued.state), this.now())
    }, wait)
  }

  private disarm() {
    if (this.timer == null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  private touch() {
    this.cached = this.peers.size
      ? [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      : EMPTY_PEERS
    for (const fn of this.listeners) fn()
  }
}

function sanitizeLocal(state: LocalAwareness): LocalAwareness {
  return {
    name: cleanName(state.name),
    cursorSample: Math.round(clamp(state.cursorSample, 0, 1e15)),
    rollBeat: state.rollBeat == null ? null : roundTo(clamp(state.rollBeat, 0, 1e6), 3),
    rollPitch: state.rollPitch == null ? null : Math.round(clamp(state.rollPitch, 0, 127)),
    rollClipId: optionalId(state.rollClipId),
    selectedClipIds: idList(state.selectedClipIds),
    selectedNoteIds: idList(state.selectedNoteIds),
    trackId: optionalId(state.trackId),
    playing: state.playing === true,
    recording: state.recording === true,
  }
}

function wireFields(state: LocalAwareness): Record<string, unknown> {
  return {
    cursorSample: state.cursorSample,
    rollBeat: state.rollBeat,
    rollPitch: state.rollPitch,
    rollClipId: state.rollClipId,
    clips: state.selectedClipIds,
    notes: state.selectedNoteIds,
    trackId: state.trackId,
    playing: state.playing,
    recording: state.recording,
  }
}

function splitKey(state: LocalAwareness & { access?: PresenceAccess }): KeyParts {
  const rest = [
    state.name,
    state.trackId ?? '',
    state.rollClipId ?? '',
    state.playing ? 1 : 0,
    state.recording ? 1 : 0,
    state.access ?? '',
    state.selectedClipIds.join(','),
    state.selectedNoteIds.join(','),
  ].join('|')
  const motion = `${state.cursorSample}|${state.rollBeat ?? ''}|${state.rollPitch ?? ''}`
  return { rest, all: `${rest}#${motion}` }
}

function sameVisible(prev: RemotePresence | undefined, next: RemotePresence) {
  if (!prev) return false
  return splitKey(prev).all === splitKey(next).all && prev.color === next.color
}

function sameCursor(a: EditCursor | null, b: EditCursor | null) {
  if (a === b) return true
  if (!a || !b) return false
  return a.clipId === b.clipId && a.beat === b.beat && a.pitch === b.pitch
}

function rollViewBeats(clip: RollClip) {
  let view = Math.max(clip.durationBeats, 8)
  for (const note of clip.notes ?? []) view = Math.max(view, note.startBeat + note.durationBeats + 1)
  return view
}

/** Same fold the piano roll uses for its own playhead. */
function foldRollBeat(songBeat: number, clip: RollClip, viewBeats: number) {
  const local = songBeat - clip.startBeat
  if (local < -1e-4) return null
  const span = Math.max(0.25, clip.durationBeats)
  const view = Math.max(span, viewBeats)
  if (clip.loop) return roundTo(((local % span) + span) % span, 3)
  if (local > view + 1e-4) return null
  return roundTo(local, 3)
}

function cleanName(name: string) {
  const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, 40)
  return trimmed || 'Guest'
}

function cleanId(id: string) {
  const trimmed = id.trim().slice(0, AWARE_ID_MAX)
  return trimmed || null
}

function optionalId(value: unknown) {
  if (typeof value !== 'string') return null
  return cleanId(value)
}

function idList(value: unknown) {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = cleanId(item)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
    if (out.length >= AWARE_LIST_MAX) break
  }
  return out
}

function finite(value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return clamp(value, min, max)
}

function optionalFinite(value: unknown, min: number, max: number, digits: number) {
  if (value == null) return null
  const next = finite(value, min, max)
  return next == null ? null : roundTo(next, digits)
}

function optionalInt(value: unknown, min: number, max: number) {
  const next = optionalFinite(value, min, max, 0)
  return next == null ? null : Math.round(next)
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function roundTo(value: number, digits: number) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

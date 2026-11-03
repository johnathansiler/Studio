import { useSyncExternalStore, type CSSProperties } from 'react'
import {
  currentAwareness,
  editorsOnTrack,
  noteOutline,
  presenceInitial,
  subscribeAwarenessBinding,
  type RemotePresence,
} from '../remote/presence'
import './presence.css'

const EMPTY: readonly RemotePresence[] = []

export function useRemotePeers(): readonly RemotePresence[] {
  const channel = useSyncExternalStore(subscribeAwarenessBinding, currentAwareness, () => null)
  return useSyncExternalStore(
    (notify) => channel?.subscribe(notify) ?? (() => undefined),
    () => channel?.peersView() ?? EMPTY,
    () => EMPTY,
  )
}

export function RecordingBadge() {
  return <em className="remote-rec" data-recording-badge="1">Recording</em>
}

export function TrackChips({ trackId, peers }: { trackId: string; peers: readonly RemotePresence[] }) {
  const editors = editorsOnTrack(peers, trackId)
  if (!editors.length) return null
  const recording = editors.some((peer) => peer.recording)
  const names = editors.map((peer) => peer.name).join(', ')
  return (
    <span
      className="presence-chips"
      data-presence-track={trackId}
      role="status"
      aria-label={`${names} ${editors.length === 1 ? 'is' : 'are'} editing this track${recording ? ', recording' : ''}`}
      style={{ '--remote': editors[0].color } as CSSProperties}
    >
      {editors.map((peer) => (
        <i key={peer.id} className="presence-avatar" data-presence={peer.id} style={{ background: peer.color }} title={peer.name}>
          {presenceInitial(peer.name)}
        </i>
      ))}
      <span className="presence-name">{names}</span>
      {recording && <RecordingBadge />}
    </span>
  )
}

export function TrackPresence({ trackId }: { trackId: string }) {
  return <TrackChips trackId={trackId} peers={useRemotePeers()} />
}

export function remoteClipMark<T extends { id: string; color: string; selectedClipIds: readonly string[] }>(peers: readonly T[], clipId: string) {
  for (const peer of peers) {
    if (peer.selectedClipIds.includes(clipId)) return peer
  }
  return null
}

export function RemoteTimeline({
  peers,
  sampleRate,
  px,
}: {
  peers: readonly RemotePresence[]
  sampleRate: number
  px: number
}) {
  if (!peers.length || sampleRate <= 0) return null
  return (
    <>
      {peers.map((peer) => (
        <RemoteCursor key={peer.id} peer={peer} left={(peer.cursorSample / sampleRate) * px} where="timeline" />
      ))}
    </>
  )
}

export function RemoteRollCursors({
  peers,
  clipId,
  pxBeat,
}: {
  peers: readonly RemotePresence[]
  clipId: string
  pxBeat: number
}) {
  const rows = peers.filter((peer) => peer.rollClipId === clipId && peer.rollBeat != null)
  if (!rows.length) return null
  return (
    <>
      {rows.map((peer) => (
        <RemoteCursor key={peer.id} peer={peer} left={Math.max(0, (peer.rollBeat ?? 0) * pxBeat)} where="piano" />
      ))}
    </>
  )
}

export function remoteNoteMark(peers: readonly RemotePresence[], noteId: string, clipId: string) {
  return noteOutline(peers, noteId, clipId)
}

function RemoteCursor({ peer, left, where }: { peer: RemotePresence; left: number; where: 'timeline' | 'piano' }) {
  return (
    <div
      className={`remote-cursor${peer.recording ? ' is-recording' : ''}`}
      data-remote-cursor={peer.id}
      data-cursor-where={where}
      role="img"
      aria-label={`${peer.name}${peer.recording ? ' recording' : ''} cursor`}
      style={{ left, '--remote': peer.color } as CSSProperties}
    >
      <span className="remote-cursor-label">
        <span className="remote-cursor-name">{peer.name}</span>
        {peer.recording && <RecordingBadge />}
      </span>
    </div>
  )
}

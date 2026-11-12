import type { CSSProperties, ReactNode } from 'react'
import type { ProjectStore } from '../state/store'

/** Inline column count for an equal grid. */
export function eqCols(count: number): CSSProperties {
  return { ['--eq-cols' as string]: String(Math.max(1, count)) }
}

/** Recessed tray whose cells share one width, one height, and one corner. */
export function EqualGrid({
  cols,
  className = '',
  label,
  children,
}: {
  cols: number
  className?: string
  label?: string
  children: ReactNode
}) {
  return (
    <div className={`eq-grid ${className}`.trim()} style={eqCols(cols)} role="group" aria-label={label}>
      {children}
    </div>
  )
}

/** Clip wins over the track. An empty selection does nothing. */
export function arrangeEditTarget(store: ProjectStore):
  | { kind: 'clip' }
  | { kind: 'track'; id: string; name: string }
  | { kind: 'none' } {
  const audio = store.selectedClipIds.length > 0 || !!store.selectedClipId
  const midi = store.selectedMidiClipIds.length > 0 || !!store.selectedMidiClipId
  const pattern = store.selectedPatternClipIds.length > 0 || !!store.selectedPatternClipId
  if (audio || midi || pattern) return { kind: 'clip' }
  const track = store.selectedTrackId ? store.project.tracks.find((item) => item.id === store.selectedTrackId) : undefined
  if (track) return { kind: 'track', id: track.id, name: track.name }
  return { kind: 'none' }
}

/** Cancel leaves the track. Delete removes it through the undo journal. */
export function applyTrackDelete(store: ProjectStore, trackId: string, choice: 'cancel' | 'delete') {
  if (choice !== 'delete') return
  store.removeTrack(trackId)
}

/** Tray confirm. Cancel and Delete are one equal pair, and Delete is red. */
export function DeleteTrackConfirm({
  name,
  onChoose,
}: {
  name: string
  onChoose: (choice: 'cancel' | 'delete') => void
}) {
  return (
    <div className="eq-confirm-scrim" role="presentation">
      <div className="eq-confirm" role="dialog" aria-modal="true" aria-label={`Delete track "${name}"?`}>
        <p>Delete track "{name}"?</p>
        <div className="eq-grid" style={eqCols(2)}>
          <button type="button" onClick={() => onChoose('cancel')}>Cancel</button>
          <button type="button" className="eq-danger" onClick={() => onChoose('delete')}>Delete</button>
        </div>
      </div>
    </div>
  )
}

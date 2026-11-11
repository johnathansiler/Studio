import type { ProjectStore } from '../state/store'
import { trackGlance } from './trackGlance'

/** Header-column readout. The track list underneath keeps the lanes where they are. */
export function TrackViewfinder({
  store,
  playheadSample,
}: {
  store: ProjectStore
  playheadSample: number
}) {
  const track = store.selectedTrackId ? store.track(store.selectedTrackId) ?? null : null
  const glance = trackGlance({
    project: store.project,
    track,
    buffers: store.buffers,
    selectedClipId: store.selectedClipId,
    selectedMidiClipId: store.selectedMidiClipId,
    selectedPatternClipId: store.selectedPatternClipId,
    playheadSample,
  })
  const line = glance.empty ? `No track · ${glance.key} · ${glance.bpm}` : null
  return (
    <aside className="track-viewfinder" data-viewfinder="" data-view-track={glance.id} aria-label="Track">
      <p className="viewfinder-line">
        {line ?? (
          <>
            <strong data-view-name="" style={{ color: glance.color }}>{glance.name}</strong>
            <span>{`\u00a0·\u00a0${glance.key}\u00a0·\u00a0${glance.bpm}`}</span>
          </>
        )}
      </p>
    </aside>
  )
}

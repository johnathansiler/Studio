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
  if (glance.empty) {
    return (
      <aside className="track-viewfinder" data-viewfinder="" data-view-track="" aria-label="Track">
        <p className="viewfinder-empty">No track</p>
        <p className="viewfinder-meta">{glance.bpm} · {glance.key}</p>
      </aside>
    )
  }
  const flag = (on: boolean, label: string) => `${label} ${on ? 'on' : 'off'}`
  return (
    <aside className="track-viewfinder" data-viewfinder="" data-view-track={glance.id} aria-label="Track">
      <p className="viewfinder-title">
        <strong data-view-name="" style={{ color: glance.color }}>{glance.name}</strong>
        <span data-view-type="">{glance.type}</span>
      </p>
      <p data-view-source="">{glance.source}</p>
      <p>Vol {glance.volume} · Pan {glance.pan}</p>
      <p data-view-marks="">{flag(glance.mute, 'Mute')} · {flag(glance.solo, 'Solo')} · {flag(glance.arm, 'Arm')}</p>
      <p data-view-inserts="">Inserts {glance.inserts}</p>
      <p data-view-clip="">
        {glance.clip ? `Clip ${glance.clip.name} · ${glance.clip.length} · ${glance.clip.start}` : 'No clip'}
      </p>
      <p className="viewfinder-meta" data-view-song="">{glance.bpm} · {glance.key} · {glance.playhead}</p>
    </aside>
  )
}

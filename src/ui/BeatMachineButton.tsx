import { OPEN_BEAT_MACHINE } from '../instruments/pads/identity'
import type { ProjectStore } from '../state/store'

export function OpenBeatMachineButton({
  store,
  trackId,
  onOpen,
}: {
  store: ProjectStore
  trackId: string
  onOpen?: (trackId: string) => void
}) {
  return (
    <button
      type="button"
      className="beat-open"
      data-beat-machine={trackId}
      aria-label={OPEN_BEAT_MACHINE}
      title="Open Beat Machine. Banks of pads, and record on this track."
      onClick={(event) => {
        event.stopPropagation()
        if (onOpen) onOpen(trackId)
        else store.insertPads(trackId)
      }}
    >
      {OPEN_BEAT_MACHINE}
    </button>
  )
}

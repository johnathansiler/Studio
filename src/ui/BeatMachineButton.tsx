import { OPEN_BEAT_MACHINE } from '../instruments/pads/identity'
import type { ProjectStore } from '../state/store'

function PadGridIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect x="1" y="1" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="10" y="1" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="1" y="10" width="7" height="7" rx="1.5" fill="currentColor" />
      <rect x="10" y="10" width="7" height="7" rx="1.5" fill="currentColor" />
    </svg>
  )
}

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
      title={OPEN_BEAT_MACHINE}
      onClick={(event) => {
        event.stopPropagation()
        if (onOpen) onOpen(trackId)
        else store.insertPads(trackId)
      }}
    >
      <PadGridIcon />
    </button>
  )
}

import { useRef, useState } from 'react'
import { TRACK_CHOICES, type TrackChoice } from '../model/addTrack'
import type { ProjectStore } from '../state/store'
import { AnchoredMenu } from './AnchoredMenu'

function ChoiceIcon({ id }: { id: TrackChoice }) {
  const common = { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const }
  if (id === 'audio') return <svg {...common}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0012 0M12 17v3" /></svg>
  if (id === 'instrument') return <svg {...common}><path d="M4 8h16M4 16h16M8 8v8M12 8v8M16 8v8" /></svg>
  if (id === 'steps') return <svg {...common}><rect x="3" y="5" width="4" height="4" rx="1" /><rect x="10" y="5" width="4" height="4" rx="1" /><rect x="17" y="5" width="4" height="4" rx="1" /><rect x="3" y="15" width="4" height="4" rx="1" /><rect x="10" y="15" width="4" height="4" rx="1" /></svg>
  return <svg {...common}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
}

function reveal(id: string) {
  requestAnimationFrame(() => {
    document.querySelector(`[data-track="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

export function AddTrackButton({
  store,
  prominent = false,
  onAdded,
}: {
  store: ProjectStore
  prominent?: boolean
  onAdded?: (id: string, choice: TrackChoice) => void
}) {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement>(null)

  function add(choice: TrackChoice) {
    const id = store.addQuickTrack(choice)
    setOpen(false)
    if (!id) return
    reveal(id)
    onAdded?.(id, choice)
  }

  return (
    <div className={`add-track-slot${prominent ? ' prominent' : ''}`}>
      <button
        type="button"
        ref={buttonRef}
        className="add-track-btn"
        aria-expanded={open}
        aria-label="Add Track"
        title="Add Track. Pick what the new track is for."
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M9 3.5v11M3.5 9h11" />
        </svg>
        <span>Add Track</span>
      </button>
      <AnchoredMenu className="add-track-menu" open={open} onClose={() => setOpen(false)} label="Add Track" triggerRef={buttonRef} prefer="down">
        <div role="group" aria-label="Add Track">
          {TRACK_CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              className="add-choice"
              aria-label={`${choice.name}. ${choice.detail}.`}
              onClick={() => add(choice.id)}
            >
              <ChoiceIcon id={choice.id} />
              <span>
                <strong>{choice.name}</strong>
                <small>{choice.detail}</small>
              </span>
            </button>
          ))}
        </div>
      </AnchoredMenu>
    </div>
  )
}

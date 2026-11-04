import { useEffect, useRef, useState } from 'react'
import { TRACK_CHOICES, type TrackChoice } from '../model/addTrack'
import type { ProjectStore } from '../state/store'

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
  const [place, setPlace] = useState<{ top: number; left: number; width: number } | null>(null)

  function placeMenu() {
    const button = buttonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    const width = Math.min(420, window.innerWidth - 16)
    const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
    const estimated = 248
    let top = rect.bottom + 4
    if (top + estimated > window.innerHeight - 8) top = Math.max(8, rect.top - estimated - 4)
    setPlace({ top, left, width })
  }

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.add-track-slot')) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', placeMenu)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', placeMenu)
    }
  }, [open])

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
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          placeMenu()
          setOpen(true)
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <path d="M9 3.5v11M3.5 9h11" />
        </svg>
        <span>Add Track</span>
      </button>
      {open && (
        <div
          className="add-track-menu"
          role="group"
          aria-label="Add Track"
          style={place ? { position: 'fixed', top: place.top, left: place.left, width: place.width, zIndex: 80 } : undefined}
        >
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
      )}
    </div>
  )
}

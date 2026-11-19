import { useState, useSyncExternalStore } from 'react'
import type { ProjectStore } from '../state/store'
import { runKeyShift } from './offerKeyShift'
import './keyShift.css'

/** Non-blocking ask: shift this loop into the project key, or leave it. */
export function KeyShiftPrompt({ store }: { store: ProjectStore }) {
  const offer = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.keyShiftOffer,
    () => store.keyShiftOffer,
  )
  const [always, setAlways] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!offer) return null
  return (
    <div className="key-shift-prompt" role="group" aria-label="Shift loop to the project key" data-key-shift-prompt="">
      <p>{busy ? 'Shifting…' : offer.line}</p>
      <label>
        <input
          type="checkbox"
          data-key-shift-always=""
          checked={always}
          disabled={busy}
          onChange={(event) => setAlways(event.target.checked)}
        />
        Always do this
      </label>
      <button
        type="button"
        data-key-shift="apply"
        disabled={busy}
        title="Pitch this loop into the project key. The original file stays put."
        onClick={() => {
          const current = store.keyShiftOffer
          if (!current || busy) return
          setBusy(true)
          void runKeyShift(store, current, always)
            .catch(() => store.toast('Could not shift that loop.', 'warn'))
            .finally(() => setBusy(false))
        }}
      >
        Shift
      </button>
      <button
        type="button"
        data-key-shift="keep"
        disabled={busy}
        title="Leave this loop in its original key."
        onClick={() => store.dismissKeyShiftOffer()}
      >
        Keep original
      </button>
    </div>
  )
}

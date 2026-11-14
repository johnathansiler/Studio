import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'
import { hidePianoRoll, notifyKeyboard } from './keyboardStage'

export function KeyboardToggle({
  store,
  engine,
  word = 'Keyboard',
  hint = 'Show the on-screen piano.',
}: {
  store: ProjectStore
  engine: AudioEngine
  /** Visible name. The track header and the note editor use a full phrase. */
  word?: string
  hint?: string
}) {
  return (
    <button
      type="button"
      className={`keyboard-toggle onscreen-piano${store.keyboardMidi ? ' on' : ''}`}
      aria-pressed={store.keyboardMidi}
      aria-label={`${word}. ${hint}`}
      title={hint}
      onClick={() => {
        engine.unlock()
        const next = !store.keyboardMidi
        if (next) {
          store.clearKeyboardReturn()
          hidePianoRoll()
        }
        store.setKeyboardMidi(next)
        notifyKeyboard(next)
      }}
    >
      <KeyboardIcon />
      <span>{word}</span>
    </button>
  )
}

/** Close and Keyboard stay outside the scrolling tool row. */
export function EditorPinned({
  store,
  engine,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  onClose?: () => void
}) {
  return (
    <div className="roll-pinned">
      {onClose && (
        <button type="button" className="roll-close" onClick={onClose}>
          Close
        </button>
      )}
      <KeyboardToggle
        store={store}
        engine={engine}
        word="On-screen Piano"
        hint="Show the on-screen piano for this track. Edit Notes brings the note editor back."
      />
    </div>
  )
}

function KeyboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="6.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="11.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="4.2" y="2" width="2.4" height="6" rx="0.5" fill="currentColor" />
      <rect x="9.4" y="2" width="2.4" height="6" rx="0.5" fill="currentColor" />
    </svg>
  )
}

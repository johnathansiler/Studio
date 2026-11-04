import type { AudioEngine } from '../audio/engine'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { MidiEditorMode } from '../model/types'
import { TipButton } from './Hint'
import { DrumEditor } from './DrumEditor'
import { EditorPinned } from './KeyboardDock'
import { FitRow } from './fitRow'
import { PianoRoll } from './PianoRoll'
import { ScoreView } from './ScoreView'
import { StepInput } from './StepInput'
import './midi-editors.css'
import { useScreenOverlay } from './screenOverlay'

const MODES: { id: MidiEditorMode; label: string; hint: string }[] = [
  { id: 'roll', label: 'Roll', hint: 'Piano roll. Draw and move notes on a grid.' },
  { id: 'step', label: 'Step', hint: 'Enter one note at a time from the keys, then move to the next step.' },
  { id: 'drums', label: 'Drums', hint: 'Drum lanes for this clip. Each row is a pad.' },
  { id: 'score', label: 'Score', hint: 'Read and edit this clip as standard notation.' },
]

export function MidiDock({
  store,
  engine,
  onIdeas,
  onGenerate,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  onIdeas?: () => void
  onGenerate?: () => void
  onClose?: () => void
}) {
  const { editor } = selectMidiEditor(store)
  useScreenOverlay(() => onClose?.())
  const modes = (
    <>
      {MODES.map((mode) => (
        <TipButton
          key={mode.id}
          label={mode.label}
          hint={mode.hint}
          pressed={editor.mode === mode.id}
          onClick={() => store.setMidiEditor({ mode: mode.id })}
        />
      ))}
    </>
  )
  return (
    <div className="midi-dock" data-screen-overlay="" aria-label="Piano roll">
      {editor.mode !== 'roll' && (
        <div className="roll-head">
          <EditorPinned store={store} engine={engine} onClose={onClose} />
          <FitRow className="me-modes">{modes}</FitRow>
        </div>
      )}
      {editor.mode === 'step' && <StepInput store={store} engine={engine} />}
      {editor.mode === 'drums' && <DrumEditor store={store} engine={engine} />}
      {editor.mode === 'score' && <ScoreView store={store} />}
      {editor.mode === 'roll' && (
        <PianoRoll store={store} engine={engine} onIdeas={onIdeas} onGenerate={onGenerate} onClose={onClose} leading={modes} />
      )}
    </div>
  )
}

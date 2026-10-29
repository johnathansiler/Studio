import type { AudioEngine } from '../audio/engine'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { MidiEditorMode } from '../model/types'
import { TipButton } from './Hint'
import { DrumEditor } from './DrumEditor'
import { FitRow } from './fitRow'
import { PianoRoll } from './PianoRoll'
import { ScoreView } from './ScoreView'
import { StepInput } from './StepInput'
import { useFormFactor } from './form'
import './midi-editors.css'

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
  const phone = useFormFactor() === 'phone'
  const modes = (
    <>
      {phone && onClose && <TipButton label="Close" hint="Back to the tracks." onClick={onClose} />}
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
    <div className="midi-dock">
      {editor.mode !== 'roll' && (
        <FitRow className="me-modes">{modes}</FitRow>
      )}
      {editor.mode === 'step' && <StepInput store={store} engine={engine} />}
      {editor.mode === 'drums' && <DrumEditor store={store} engine={engine} />}
      {editor.mode === 'score' && <ScoreView store={store} />}
      {editor.mode === 'roll' && (
        <PianoRoll store={store} engine={engine} onIdeas={onIdeas} onGenerate={onGenerate} leading={modes} />
      )}
    </div>
  )
}

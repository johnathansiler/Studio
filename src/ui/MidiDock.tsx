import type { AudioEngine } from '../audio/engine'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { MidiEditorMode } from '../model/types'
import { TipButton } from './Hint'
import { DrumEditor } from './DrumEditor'
import { PianoRoll } from './PianoRoll'
import { ScoreView } from './ScoreView'
import { StepInput } from './StepInput'
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
  onLibrary,
}: {
  store: ProjectStore
  engine: AudioEngine
  onIdeas?: () => void
  onGenerate?: () => void
  onLibrary?: () => void
}) {
  const { editor } = selectMidiEditor(store)
  return (
    <div className="midi-dock">
      <div className="me-modes" role="toolbar" aria-label="MIDI editor">
        {MODES.map((mode) => (
          <TipButton
            key={mode.id}
            label={mode.label}
            hint={mode.hint}
            pressed={editor.mode === mode.id}
            onClick={() => store.setMidiEditor({ mode: mode.id })}
          />
        ))}
      </div>
      {editor.mode === 'step' && <StepInput store={store} engine={engine} />}
      {editor.mode === 'drums' && <DrumEditor store={store} engine={engine} />}
      {editor.mode === 'score' && <ScoreView store={store} />}
      {editor.mode === 'roll' && <PianoRoll store={store} engine={engine} onIdeas={onIdeas} onGenerate={onGenerate} onLibrary={onLibrary} />}
    </div>
  )
}

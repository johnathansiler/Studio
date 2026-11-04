import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'
import { BeatView } from './BeatView'

/** The step grid for one track. Close, Back, and Escape leave the arrange view. */
export function StepSequencerPanel({
  store,
  engine,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  onClose: () => void
}) {
  return (
    <section className="step-sequencer" data-step-sequencer="open" aria-label="Step Sequencer">
      <header className="step-sequencer-bar">
        <h2>Step Sequencer</h2>
        <button type="button" className="step-close" onClick={onClose}>Close</button>
      </header>
      <BeatView store={store} engine={engine} />
    </section>
  )
}

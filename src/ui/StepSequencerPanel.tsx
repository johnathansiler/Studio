import type { AudioEngine } from '../audio/engine'
import { readGroove } from '../presets/apply'
import { commitPluginPreset } from '../presets/project'
import type { ProjectStore } from '../state/store'
import { BeatView } from './BeatView'
import { PresetControls } from './PresetControls'
import { useScreenOverlay } from './screenOverlay'

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
  const trackId = store.stepTrackId
  const plugin = trackId ? store.track(trackId)?.plugins.find((item) => item.pluginId === 'steps') : null
  const pattern = plugin?.steps?.patterns.find((item) => item.id === plugin.steps?.activeId) ?? plugin?.steps?.patterns[0]
  useScreenOverlay(onClose)
  return (
    <section className="step-sequencer" data-step-sequencer="open" data-screen-overlay="" aria-label="Step Sequencer">
      {plugin && pattern && trackId && (
        <PresetControls
          pluginId="steps"
          instanceKey={plugin.id}
          values={readGroove(pattern)}
          presets={store.project.presets}
          onCommit={(next) => commitPluginPreset(store, trackId, plugin.id, next.params, next.presets, true)}
        />
      )}
      <header className="step-sequencer-bar">
        <h2>Step Sequencer</h2>
        <button type="button" className="step-close overlay-close" onClick={onClose}>Close</button>
      </header>
      <BeatView store={store} engine={engine} />
    </section>
  )
}

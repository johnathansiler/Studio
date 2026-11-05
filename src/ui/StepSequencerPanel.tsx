import type { AudioEngine } from '../audio/engine'
import { readGroove } from '../presets/apply'
import { commitPluginPreset } from '../presets/project'
import type { ProjectStore } from '../state/store'
import { BeatView } from './BeatView'
import { PresetControls } from './PresetControls'
import { useScreenOverlay } from './screenOverlay'
import { useState } from 'react'
import './pluginPages.css'

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
  const [page, setPage] = useState<'steps' | 'mix'>('steps')
  useScreenOverlay(onClose)
  return (
    <section className="step-sequencer" data-step-sequencer="open" data-plugin-root="" data-plugin-pages="" data-screen-overlay="" aria-label="Step Sequencer">
      <header className="step-sequencer-bar">
        <h2>Step Sequencer</h2>
        <button type="button" className="step-close overlay-close" onClick={onClose}>Close</button>
      </header>
      <div className="plugin-page-tabs" role="tablist" aria-label="Step Sequencer pages">
        <button type="button" role="tab" data-plugin-tab="steps" aria-selected={page === 'steps'} className={page === 'steps' ? 'on' : ''} onClick={() => setPage('steps')}>Steps</button>
        <button type="button" role="tab" data-plugin-tab="mix" aria-selected={page === 'mix'} className={page === 'mix' ? 'on' : ''} onClick={() => setPage('mix')}>Mix</button>
      </div>
      {plugin && pattern && trackId && (
        <PresetControls
          pluginId="steps"
          instanceKey={plugin.id}
          values={readGroove(pattern)}
          presets={store.project.presets}
          onCommit={(next) => commitPluginPreset(store, trackId, plugin.id, next.params, next.presets, true)}
        />
      )}
      <BeatView store={store} engine={engine} page={page} />
    </section>
  )
}

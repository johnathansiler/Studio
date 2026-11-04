import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import type { ProjectStore } from '../state/store'
import { AutomationModeBar } from './AutomationLane'
import { GuideLayer } from './GuideLayer'
import { RecordBar } from './RecordBar'
import { SongMapHead } from './SongMap'
import './song-panel.css'

const TABS = [
  { id: 'automation', label: 'Automation' },
  { id: 'recording', label: 'Recording' },
  { id: 'markers', label: 'Markers' },
] as const

type SongTab = (typeof TABS)[number]['id']

/** Compact song setup. It floats over the arrange view. */
export function SongPanel({
  store,
  engine,
  session,
  position,
  compact,
  onClose,
  onQuickPunch,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  position: number
  compact: boolean
  onClose: () => void
  onQuickPunch: () => void
}) {
  const [tab, setTab] = useState<SongTab>('automation')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <GuideLayer>
      <button type="button" className="guide-scrim song-scrim" aria-label="Close song" onClick={onClose} />
      <div id="arrange-setup" className={`guide-sheet song-sheet ${compact ? 'sheet' : 'pop'}`} role="dialog" aria-label="Song">
        <header className="song-head">
          <h2>Song</h2>
          <button type="button" className="song-close" onClick={onClose}>Close</button>
        </header>
        <div className="song-pills" role="tablist" aria-label="Song sections">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'on' : ''}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        {tab === 'automation' && (
          <section className="song-pane" aria-label="Automation">
            <AutomationModeBar store={store} />
          </section>
        )}
        {tab === 'recording' && (
          <section className="song-pane" aria-label="Recording">
            <RecordBar store={store} engine={engine} session={session} onQuickPunch={onQuickPunch} inline />
          </section>
        )}
        {tab === 'markers' && (
          <section className="song-pane" aria-label="Markers">
            <SongMapHead store={store} position={position} />
          </section>
        )}
      </div>
    </GuideLayer>
  )
}

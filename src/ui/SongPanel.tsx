import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import type { ProjectStore } from '../state/store'
import { AutomationModeBar } from './AutomationLane'
import { GuideLayer } from './GuideLayer'
import { SongMapHead } from './SongMap'
import { useScreenOverlay } from './screenOverlay'
import './song-panel.css'

const TABS = [
  { id: 'automation', label: 'Automation' },
  { id: 'markers', label: 'Markers' },
  { id: 'time', label: 'Time' },
] as const

const METERS: [number, number, string][] = [
  [4, 4, '4/4'],
  [3, 4, '3/4'],
  [6, 8, '6/8'],
  [5, 4, '5/4'],
  [7, 8, '7/8'],
]

type SongTab = (typeof TABS)[number]['id']

/** Compact song setup. It floats over the arrange view. */
export function SongPanel({
  store,
  engine,
  session,
  position,
  compact,
  onClose,
  onQuickPunch: _onQuickPunch,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  position: number
  compact: boolean
  onClose: () => void
  onQuickPunch: () => void
}) {
  void engine
  void session
  void _onQuickPunch
  const [tab, setTab] = useState<SongTab>('automation')
  useScreenOverlay(onClose)
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <GuideLayer>
      <button type="button" className="guide-scrim song-scrim" aria-label="Close setup" onClick={onClose} />
      <div id="arrange-setup" className={`guide-sheet song-sheet ${compact ? 'sheet' : 'pop'}`} role="dialog" aria-label="Setup" data-screen-overlay="">
        <header className="song-head">
          <h2>Setup</h2>
          <button type="button" className="song-close overlay-close" onClick={onClose}>Close</button>
        </header>
        <div className="song-pills" role="tablist" aria-label="Setup sections">
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
        {tab === 'markers' && (
          <section className="song-pane" aria-label="Markers">
            <SongMapHead store={store} position={position} />
          </section>
        )}
        {tab === 'time' && (
          <section className="song-pane" aria-label="Time signature">
            <p className="song-note">How the beats are grouped. 4/4 is four quarter notes in a bar.</p>
            <div className="song-meters" role="group" aria-label="Time signature">
              {METERS.map(([beats, note, label]) => {
                const on = store.project.timeSignature.numerator === beats && store.project.timeSignature.denominator === note
                return (
                  <button
                    key={label}
                    type="button"
                    className={on ? 'on' : ''}
                    aria-pressed={on}
                    onClick={() => store.setTimeSignature(beats, note)}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </section>
        )}
      </div>
    </GuideLayer>
  )
}

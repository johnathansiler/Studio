import { useState, type RefObject } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import type { ProjectStore } from '../state/store'
import { AutomationModeBar } from './AutomationLane'
import { SongMapHead } from './SongMap'
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

/** Compact song setup. It docks under the Setup button and stays as tall as its controls. */
export function SongPanel({
  store,
  position,
  triggerRef,
  onClose,
  onQuickPunch: _onQuickPunch,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  position: number
  compact: boolean
  triggerRef: RefObject<HTMLButtonElement | null>
  onClose: () => void
  onQuickPunch: () => void
}) {
  void _onQuickPunch
  void triggerRef
  void onClose
  const [tab, setTab] = useState<SongTab>('automation')

  return (
      <div className="song-sheet">
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
  )
}

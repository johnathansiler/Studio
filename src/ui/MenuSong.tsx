import { useState } from 'react'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import type { AutomationWriteMode } from '../model/types'
import type { ProjectStore } from '../state/store'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import './menuPanels.css'

const MODES: { id: AutomationWriteMode; label: string; hint: string }[] = [
  { id: 'off', label: 'Off', hint: 'Ignore automation.' },
  { id: 'read', label: 'Read', hint: 'Play the written moves.' },
  { id: 'touch', label: 'Touch', hint: 'Write while you hold a control.' },
  { id: 'latch', label: 'Latch', hint: 'Keep the last value until playback stops.' },
]

const TABS = ['Automation', 'Recording', 'Markers'] as const

export function MenuSong({
  store,
  engine,
  session,
  onQuickPunch,
  onSeek,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onQuickPunch: () => void
  onSeek: (sample: number) => void
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Automation')
  const project = store.project
  const record = store.recordSettings()
  const mode = project.automationMode ?? 'read'
  const audio = project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'audio')
  const hint = tab === 'Automation'
    ? MODES.find((item) => item.id === mode)?.hint
    : tab === 'Recording'
      ? 'Cycle repeats the loop. Punch records between In and Out.'
      : 'Markers name a bar. Jump moves the playhead there.'
  const playBeat = () => projectSampleBeat(project, engine.currentTimelineSample())

  return (
    <div className="menu-song" role="region" aria-label="Song">
      <div className="menu-tabs" role="tablist" aria-label="Song sections">
        {TABS.map((item) => (
          <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? 'on' : ''} onClick={() => setTab(item)}>
            {item}
          </button>
        ))}
      </div>
      <p className="menu-hint">{hint}</p>
      {tab === 'Automation' && (
        <div className="menu-pills" role="group" aria-label="Automation">
          {MODES.map((item) => (
            <button key={item.id} type="button" className={mode === item.id ? 'on' : ''} aria-pressed={mode === item.id} title={item.hint} onClick={() => store.setAutomationMode(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      )}
      {tab === 'Recording' && (
        <div className="menu-pills" role="group" aria-label="Recording">
          <button type="button" className={record.loop ? 'on' : ''} aria-pressed={record.loop} title="Repeat the loop while recording." onClick={() => store.setRecord({ loop: !record.loop })}>Cycle</button>
          <button type="button" className={record.punchEnabled ? 'on' : ''} aria-pressed={record.punchEnabled} title="Record only between In and Out." onClick={() => store.setRecord({ punchEnabled: !record.punchEnabled, quick: false })}>Punch</button>
          <button type="button" title="Set the punch in at the playhead." onClick={() => store.setRecord({ punchIn: Math.round(engine.currentTimelineSample()) })}>In</button>
          <button type="button" title="Set the punch out at the playhead." onClick={() => store.setRecord({ punchOut: Math.round(engine.currentTimelineSample()) })}>Out</button>
          <button type="button" title="Punch in right now, and out when you press it again." onClick={onQuickPunch}>Quick punch</button>
          <label className="menu-field" title="Count this much before the record starts.">
            Pre-roll
            <input aria-label="Pre-roll" inputMode="decimal" value={record.preRoll} onChange={(event) => store.setRecord({ preRoll: Number(event.target.value) || 0 })} />
          </label>
          {audio && (
            <label className="menu-field" title="Which input this track records.">
              Input
              <select aria-label="Record input" value={audio.input} onChange={(event) => store.updateTrack(audio.id, { input: event.target.value })}>
                <option value="mic">Mic</option>
                <option value="none">No input</option>
                {session.state.participants.filter((person) => person.id !== session.state.selfId).map((person) => (
                  <option key={person.id} value={`remote:${person.id}`}>{person.name}</option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {tab === 'Markers' && (
        <div className="menu-markers">
          <div className="menu-pills">
            <button type="button" disabled={store.remoteFollow} onClick={() => store.addSection('verse', playBeat())}>Add section</button>
            <button type="button" disabled={store.remoteFollow} onClick={() => store.addSection('marker', playBeat())}>Add marker</button>
          </div>
          <div className="menu-rows">
            {(project.sections ?? []).map((section) => (
              <div className="menu-row" key={section.id}>
                <input
                  aria-label={`Rename ${section.name}`}
                  value={section.name}
                  disabled={store.remoteFollow}
                  onChange={(event) => store.renameSection(section.id, event.target.value)}
                />
                <button type="button" onClick={() => onSeek(projectBeatSample(project, section.startBeat))}>Jump</button>
              </div>
            ))}
            {(project.sections ?? []).length === 0 && <p className="menu-hint">No markers yet. Add one at the playhead.</p>}
          </div>
        </div>
      )}
    </div>
  )
}

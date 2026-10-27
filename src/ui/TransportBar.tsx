import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { formatBarsBeats, formatTimecode } from '../model/time'
import type { ProjectStore } from '../state/store'

export function TransportBar({
  store,
  engine,
  syncLabel,
  onPlay,
  onStop,
  onRecord,
  onSeek,
  onSession,
  onArrange,
}: {
  store: ProjectStore
  engine: AudioEngine
  syncLabel?: string
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onSeek: (sample: number) => void
  onSession?: () => void
  onArrange?: () => void
}) {
  const project = store.project
  const [position, setPosition] = useState(engine.positionSamples)
  const [status, setStatus] = useState(engine.status)
  useEffect(
    () =>
      engine.subscribe(() => {
        setPosition(engine.positionSamples)
        setStatus(engine.status)
      }),
    [engine],
  )
  return (
    <div className="transport">
      <div className="t-buttons">
        <button className="t-btn" onClick={() => onSeek(0)} title="Return to start">
          ⏮
        </button>
        <button className={`t-btn play ${status === 'playing' || status === 'recording' ? 'on' : ''}`} onClick={onPlay} title="Play">
          ▶
        </button>
        <button className="t-btn stop" onClick={onStop} title="Stop" disabled={status === 'stopped'}>
          Stop
        </button>
        <button className={`t-btn rec ${status === 'recording' || status === 'counting-in' ? 'on' : ''}`} onClick={onRecord} title="Record">
          ●
        </button>
      </div>
      <div className="lcd-wrap">
        <div className="lcd">
          <div className="bars">{formatBarsBeats(position, project.sampleRate, project.tempo, project.timeSignature)}</div>
          <div className="tc">
            {formatTimecode(position, project.sampleRate)} · {status}
          </div>
        </div>
        <label className="field">
          BPM
          <input
            type="number"
            min={40}
            max={300}
            value={project.tempo}
            disabled={store.remoteFollow}
            onChange={(event) => store.setTempo(Number(event.target.value))}
          />
        </label>
        <label className="field">
          Sig
          <select
            value={`${project.timeSignature.numerator}/${project.timeSignature.denominator}`}
            disabled={store.remoteFollow}
            onChange={(event) => {
              const [n, d] = event.target.value.split('/').map(Number)
              store.setTimeSignature(n, d)
            }}
          >
            {['4/4', '3/4', '6/8', '5/4', '7/8'].map((sig) => (
              <option key={sig}>{sig}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="t-toggles">
        <label className="toggle">
          <input type="checkbox" checked={project.metronomeEnabled} disabled={store.remoteFollow} onChange={() => store.toggle('metronomeEnabled')} /> Click
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.countIn} disabled={store.remoteFollow} onChange={() => store.toggle('countIn')} /> Count-in
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.loopEnabled} disabled={store.remoteFollow} onChange={() => store.toggle('loopEnabled')} /> Loop
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.snap} disabled={store.remoteFollow} onChange={() => store.toggle('snap')} /> Snap
        </label>
        <button
          type="button"
          className={`mode-btn ${store.transportMode === 'session' ? 'on' : ''}`}
          disabled={store.remoteFollow}
          onClick={() => (store.transportMode === 'session' ? (onArrange ?? (() => store.backToArrangement()))() : (onSession ?? (() => store.enterSession()))())}
        >
          {store.transportMode === 'session' ? 'Session' : 'Arrange'}
        </button>
        {store.transportMode === 'session' && (
          <button type="button" className="mode-btn" disabled={store.remoteFollow} onClick={() => (onArrange ?? (() => store.backToArrangement()))()}>
            Back
          </button>
        )}
        <button type="button" className="mode-btn" disabled={store.remoteFollow} onClick={() => store.captureToArrangement()}>
          Capture
        </button>
        {syncLabel && <span className="sync-pill">{syncLabel}</span>}
      </div>
    </div>
  )
}

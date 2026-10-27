import type { AudioClip, StretchMode } from '../model/types'
import { sourceSamplesOf } from '../audio/stretch/engine'
import type { ProjectStore } from '../state/store'

const MODES: { id: StretchMode; label: string }[] = [
  { id: 'pro', label: 'Pro' },
  { id: 'beats', label: 'Beats' },
  { id: 'tonal', label: 'Tonal' },
  { id: 'voice', label: 'Voice' },
  { id: 'speech', label: 'Speech' },
  { id: 'tape', label: 'Tape' },
]

export function ClipSheet({ store, trackId, clip, onClose }: { store: ProjectStore; trackId: string; clip: AudioClip; onClose: () => void }) {
  const project = store.project
  const stretch = clip.stretch
  const source = sourceSamplesOf(clip)
  const percent = Math.round((clip.durationSamples / Math.max(1, source)) * 1000) / 10
  return (
    <div className="clip-sheet" role="dialog" aria-label="Clip">
      <header>
        <strong>{clip.name}</strong>
        <button type="button" className="text-btn" onClick={onClose}>Close</button>
      </header>
      <div className="row">
        <label>
          %
          <input
            aria-label="Stretch"
            type="number"
            min={12.5}
            max={800}
            step={0.1}
            value={percent}
            onChange={(event) => store.setStretchRatio(trackId, clip.id, Number(event.target.value))}
          />
        </label>
        <label>
          st
          <input
            aria-label="Semitones"
            type="number"
            min={-24}
            max={24}
            step={1}
            value={stretch?.semitones ?? 0}
            onChange={(event) => store.setClipStretch(trackId, clip.id, { semitones: Number(event.target.value) })}
          />
        </label>
        <label>
          ct
          <input
            aria-label="Cents"
            type="number"
            min={-100}
            max={100}
            step={1}
            value={stretch?.cents ?? 0}
            onChange={(event) => store.setClipStretch(trackId, clip.id, { cents: Number(event.target.value) })}
          />
        </label>
        <select
          aria-label="Mode"
          value={stretch?.mode ?? 'pro'}
          onChange={(event) => store.setClipStretch(trackId, clip.id, { mode: event.target.value as StretchMode })}
        >
          {MODES.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`text-btn ${stretch?.formant ? 'on' : ''}`}
          aria-pressed={stretch?.formant ?? false}
          onClick={() => store.setClipStretch(trackId, clip.id, { formant: !stretch?.formant })}
        >
          Formant
        </button>
        <button
          type="button"
          className={`text-btn ${stretch?.followTempo ? 'on' : ''}`}
          aria-pressed={stretch?.followTempo ?? false}
          onClick={() => store.setClipStretch(trackId, clip.id, { followTempo: !stretch?.followTempo })}
        >
          Tempo
        </button>
        <label>
          BPM
          <input
            aria-label="BPM"
            type="number"
            min={40}
            max={300}
            step={0.1}
            value={stretch?.sourceBpm ?? ''}
            placeholder={String(project.tempo)}
            onChange={(event) => {
              const bpm = Number(event.target.value)
              store.setClipStretch(trackId, clip.id, { sourceBpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null })
            }}
          />
        </label>
        <button type="button" className="text-btn" onClick={() => store.autoWarpMarkers(trackId, clip.id)}>
          Auto
        </button>
        <button type="button" className="text-btn" aria-label="Add marker" onClick={() => store.addWarpMarker(trackId, clip.id)}>
          +
        </button>
      </div>
      {(stretch?.markers ?? []).map((marker) => (
        <div className="row" key={marker.id}>
          <input
            aria-label="Marker source"
            type="number"
            value={Math.round(marker.source)}
            onChange={(event) => store.moveWarpMarker(trackId, clip.id, marker.id, { source: Number(event.target.value) })}
          />
          <input
            aria-label="Marker beat"
            type="number"
            step={0.01}
            value={Math.round(marker.target * 1000) / 1000}
            onChange={(event) => store.moveWarpMarker(trackId, clip.id, marker.id, { target: Number(event.target.value) })}
          />
          <button type="button" className="text-btn" aria-label="Delete marker" onClick={() => store.removeWarpMarker(trackId, clip.id, marker.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

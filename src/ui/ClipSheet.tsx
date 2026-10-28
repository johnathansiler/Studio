import type { AudioClip, StretchMode } from '../model/types'
import { sourceSamplesOf } from '../audio/stretch/engine'
import { selectClip } from '../state/select'
import type { ProjectStore } from '../state/store'
import './songMap.css'

const MODES: { id: StretchMode; label: string }[] = [
  { id: 'pro', label: 'Pro' },
  { id: 'beats', label: 'Beats' },
  { id: 'tonal', label: 'Tonal' },
  { id: 'voice', label: 'Voice' },
  { id: 'speech', label: 'Speech' },
  { id: 'tape', label: 'Tape' },
]

export function ClipSheet({ store, trackId, clip, onClose }: { store: ProjectStore; trackId: string; clip: AudioClip; onClose: () => void }) {
  const live = selectClip(store, trackId, clip.id)
  const shown = live.clip ?? clip
  const project = live.project
  const stretch = shown.stretch
  const source = sourceSamplesOf(shown)
  const percent = Math.round((shown.durationSamples / Math.max(1, source)) * 1000) / 10
  return (
    <div className="clip-sheet" role="dialog" aria-label="Clip">
      <header>
        <strong>{shown.name}</strong>
        <button type="button" className="text-btn" title="Play as instrument. Pitch this recording across the keyboard." onClick={() => {
          const asset = store.buffers.get(shown.bufferId)
          const midi = store.project.tracks.find((item) => item.id === store.selectedTrackId && item.type === 'midi')
            || store.project.tracks.find((item) => item.type === 'midi')
          if (!asset || !midi) {
            store.toast('Add an instrument track to play this as keys.', 'warn')
            return
          }
          store.loadSamplerSound(midi.id, { ...asset, name: shown.name })
          onClose()
        }}>As keys</button>
        <button type="button" className="text-btn" title="Spectrogram. Select a spot and remove clicks, hum, or noise." onClick={() => store.openSpectral(trackId, shown.id)}>Repair</button>
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
            onChange={(event) => store.setStretchRatio(trackId, shown.id, Number(event.target.value))}
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
            onChange={(event) => store.setClipStretch(trackId, shown.id, { semitones: Number(event.target.value) })}
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
            onChange={(event) => store.setClipStretch(trackId, shown.id, { cents: Number(event.target.value) })}
          />
        </label>
        <select
          aria-label="Mode"
          value={stretch?.mode ?? 'pro'}
          onChange={(event) => store.setClipStretch(trackId, shown.id, { mode: event.target.value as StretchMode })}
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
          onClick={() => store.setClipStretch(trackId, shown.id, { formant: !stretch?.formant })}
        >
          Formant
        </button>
        <button
          type="button"
          className={`text-btn ${stretch?.followTempo ? 'on' : ''}`}
          aria-pressed={stretch?.followTempo ?? false}
          onClick={() => store.setClipStretch(trackId, shown.id, { followTempo: !stretch?.followTempo })}
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
              store.setClipStretch(trackId, shown.id, { sourceBpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null })
            }}
          />
        </label>
        <button type="button" className="text-btn" onClick={() => store.autoWarpMarkers(trackId, shown.id)}>
          Auto
        </button>
        <button type="button" className="text-btn" aria-label="Add marker" onClick={() => store.addWarpMarker(trackId, shown.id)}>
          +
        </button>
      </div>
      <div className="smart-row">
        <span>{stretch?.sourceBpm ? `${stretch.sourceBpm.toFixed(1)} BPM in this clip` : 'No tempo in this clip yet'}</span>
        <button type="button" title="Set the song tempo to this clip" disabled={stretch?.sourceBpm == null} onClick={() => store.adaptClipTempo(trackId, clip.id)}>
          Use for song
        </button>
        <button type="button" title="Stretch this clip to the song tempo without changing its pitch" disabled={stretch?.sourceBpm == null} onClick={() => store.conformClipTempo(trackId, clip.id)}>
          Fit to song
        </button>
      </div>
      {(stretch?.markers ?? []).map((marker) => (
        <div className="row" key={marker.id}>
          <input
            aria-label="Marker source"
            type="number"
            value={Math.round(marker.source)}
            onChange={(event) => store.moveWarpMarker(trackId, shown.id, marker.id, { source: Number(event.target.value) })}
          />
          <input
            aria-label="Marker beat"
            type="number"
            step={0.01}
            value={Math.round(marker.target * 1000) / 1000}
            onChange={(event) => store.moveWarpMarker(trackId, shown.id, marker.id, { target: Number(event.target.value) })}
          />
          <button type="button" className="text-btn" aria-label="Delete marker" onClick={() => store.removeWarpMarker(trackId, shown.id, marker.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

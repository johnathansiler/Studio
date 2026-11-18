import { useState, useSyncExternalStore } from 'react'
import {
  CLIP_TEMPO_LABEL,
  CLIP_TEMPO_MODES,
  clampLockBpm,
  clipTempoMode,
  effectiveClipBpm,
  formatBpm,
} from '../model/clipTempo'
import type { ClipTempoMode } from '../model/types'
import type { ProjectStore } from '../state/store'
import './clipTempo.css'

const HINT: Record<ClipTempoMode, string> = {
  follow: 'Play this clip at the song tempo. The pitch stays put.',
  half: 'Play at half the song tempo. At 160, this clip plays at 80, and it still follows tempo changes.',
  double: 'Play at double the song tempo. At 80, this clip plays at 160, and it still follows tempo changes.',
  lock: 'Keep this clip at a fixed tempo when the song tempo changes.',
}

/**
 * Follow, half, double, and lock for the selected audio clip.
 * Mounted in the clip's own row, never as a floating control.
 */
export function ClipTempoControl({ store, trackId, clipId }: { store: ProjectStore; trackId: string; clipId: string }) {
  const clip = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.track(trackId)?.clips.find((item) => item.id === clipId) ?? null,
    () => store.track(trackId)?.clips.find((item) => item.id === clipId) ?? null,
  )
  const projectBpm = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.project.tempo,
    () => store.project.tempo,
  )
  const [bpmText, setBpmText] = useState<string | null>(null)
  if (!clip) return null
  const stretch = clip.stretch
  const mode = clipTempoMode(stretch)
  const source = stretch?.sourceBpm ?? null
  const plays = effectiveClipBpm({
    mode,
    projectBpm,
    sourceBpm: source,
    lockBpm: stretch?.lockBpm,
    sourceSamples: stretch?.sourceSamples,
    durationSamples: clip.durationSamples,
  })
  const modeName = mode === 'free' ? 'Original' : CLIP_TEMPO_LABEL[mode]
  const sourceText = source ? `Source ${formatBpm(source)}` : 'No source tempo'
  const playsText = plays != null ? `Plays ${formatBpm(plays)}` : 'Plays with the file'
  const summary = mode === 'free'
    ? `Original. ${sourceText}. ${playsText}. Pick Follow, half, double, or Lock.`
    : `${modeName}. ${sourceText}. ${playsText}.`

  function choose(next: ClipTempoMode) {
    if (next === 'lock' && mode !== 'lock') {
      const bpm = plays ?? source ?? projectBpm
      store.setClipStretch(trackId, clipId, { tempoMode: 'lock', lockBpm: clampLockBpm(bpm) })
      return
    }
    store.setClipStretch(trackId, clipId, { tempoMode: next })
  }

  return (
    <div className="clip-tempo" role="group" aria-label={`Clip tempo. ${summary}`} data-clip-tempo={mode}>
      {CLIP_TEMPO_MODES.map((id) => (
        <button
          key={id}
          type="button"
          data-tempo-mode={id}
          aria-pressed={mode === id}
          title={HINT[id]}
          onClick={() => choose(id)}
        >
          {CLIP_TEMPO_LABEL[id]}
        </button>
      ))}
      {mode === 'lock' && (
        <label className="clip-tempo-bpm">
          BPM
          <input
            aria-label="Locked BPM"
            type="number"
            inputMode="decimal"
            min={10}
            max={960}
            step={0.1}
            value={bpmText ?? (stretch?.lockBpm != null ? formatBpm(stretch.lockBpm) : '')}
            onChange={(event) => {
              const text = event.target.value
              setBpmText(text)
              const bpm = readyLockBpm(text)
              if (bpm == null) return
              store.setClipStretch(trackId, clipId, { tempoMode: 'lock', lockBpm: bpm })
            }}
            onBlur={() => setBpmText(null)}
          />
        </label>
      )}
      <span className="clip-tempo-readout">{sourceText} · {playsText}</span>
    </div>
  )
}

/** A finished tempo. "8" is still being typed on the way to 80. */
function readyLockBpm(text: string): number | null {
  if (!/^\d+(\.\d)?$/.test(text)) return null
  const bpm = Number(text)
  if (!Number.isFinite(bpm) || bpm < 10 || bpm > 960) return null
  return bpm
}

import { useState, useSyncExternalStore } from 'react'
import { isRecordedClip } from '../audio/recordTake'
import { altReadout, keyReadout } from '../model/clipHearing'
import { keyShiftReadout, songKeyChip } from '../model/keyFit'
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
import { clipShiftPlan, runKeyShift } from './offerKeyShift'
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
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const keyPolicy = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.project.keyShift ?? 'ask',
    () => store.project.keyShift ?? 'ask',
  )
  const songKey = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => songKeyChip(store.scaleState()) ?? '',
    () => songKeyChip(store.scaleState()) ?? '',
  )
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
  const hearing = clip.hearing
  const recorded = isRecordedClip(clip)
  const keyLine = recorded ? null : keyShiftReadout(clip)
  const shift = recorded ? null : clipShiftPlan(store, trackId, clipId)
  const summary = mode === 'free'
    ? `Original. ${sourceText}. ${playsText}. Pick Follow, half, double, or Lock. Detect reads the key and the scale.`
    : `${modeName}. ${sourceText}. ${playsText}. Detect reads the key and the scale.`

  async function detect() {
    if (!clip) return
    const asset = store.buffers.get(clip.bufferId)
    const channels = asset?.channels ?? []
    if (!asset || !channels.some((channel) => channel.length > 0)) {
      setNote('This clip has no audio to read.')
      return
    }
    setBusy(true)
    setNote('')
    try {
      const { detectClipHearing } = await import('../analysis/clipJob')
      const hearing = await detectClipHearing({
        channels,
        sampleRate: asset.sampleRate,
        clip,
        project: store.project,
      })
      store.rememberClipHearing(trackId, clipId, hearing)
    } catch (caught) {
      setNote(caught instanceof Error ? caught.message : 'Could not read this clip.')
    } finally {
      setBusy(false)
    }
  }

  function choose(next: ClipTempoMode) {
    if (next === 'lock' && mode !== 'lock') {
      const bpm = plays ?? source ?? projectBpm
      store.setClipStretch(trackId, clipId, { tempoMode: 'lock', lockBpm: clampLockBpm(bpm) })
      return
    }
    store.setClipStretch(trackId, clipId, { tempoMode: next })
  }

  return (
    <div className="clip-tempo" role="group" aria-label={`Clip tempo. ${recorded ? 'Recorded take. It stays at the speed you sang.' : summary}`} data-clip-tempo={recorded ? 'recorded' : mode}>
      {recorded ? <span className="clip-tempo-readout">Recorded. Plays as sung.</span> : CLIP_TEMPO_MODES.map((id) => (
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
      <button
        type="button"
        data-clip-detect=""
        aria-busy={busy}
        disabled={busy}
        title={busy ? 'Reading the key and the scale.' : 'Detect the key and the scale of this clip. It does not change the song tempo.'}
        onClick={() => void detect()}
      >
        {busy ? 'Detecting…' : 'Detect'}
      </button>
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
      {!recorded && keyPolicy !== 'ask' ? (
        <button
          type="button"
          data-key-shift-policy="ask"
          title={keyPolicy === 'keep'
            ? 'New loops stay in their original key. Ask again next time.'
            : 'New loops shift into the project key. Ask again next time.'}
          onClick={() => store.setKeyShiftPolicy('ask')}
        >
          Ask each time
        </button>
      ) : null}
      {note ? <p className="clip-tempo-note">{note}</p> : null}
      {songKey ? <p className="clip-tempo-readout" data-song-key={songKey}>Song key: {songKey}</p> : null}
      {keyLine ? (
        <div className="clip-hearing" data-key-shift-dock="" role="region" aria-label="Shifted key">
          <p data-key-shift-readout="">{keyLine}</p>
          <button type="button" data-key-revert="" title="Put this loop back on its original pitch." onClick={() => store.revertKeyShift(trackId, clipId)}>
            Revert to original
          </button>
        </div>
      ) : shift ? (
        <div className="clip-hearing" data-key-shift-dock="" role="region" aria-label="Shift to the song key">
          <button
            type="button"
            data-shift-to-song=""
            title={`Pitch this loop into the song key, ${shift.to}. The original file stays put.`}
            onClick={() => { void runKeyShift(store, shift, false) }}
          >
            {`Shift to song key (${shift.to})`}
          </button>
        </div>
      ) : null}
      {hearing?.clearKey ? (
        <div className="clip-hearing" data-clip-hearing="" role="region" aria-label="Detected key and scale">
          <p data-hearing-key="">{keyReadout(hearing)}</p>
          <p data-hearing-scale="">{`Scale: ${hearing.scale === 'aeolian' ? 'natural minor' : 'major'}`}</p>
          {hearing.alt ? <p data-hearing-alt="">{altReadout(hearing)}</p> : null}
          <button
            type="button"
            className="primary"
            data-set-song-key=""
            title={`Set the song key to ${hearing.key}. The song tempo stays put. Auto-Tune follows this key.`}
            onClick={() => store.useDetectedKey(trackId, clipId)}
          >
            {`Set song key to ${hearing.key}`}
          </button>
        </div>
      ) : null}
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

import type { ProjectStore } from '../state/store'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import './renderAudio.css'

const PLACES = [
  { id: 'mute' as const, label: 'Mute original', hint: 'Keep the MIDI and silence it. One undo brings it back.' },
  { id: 'replace' as const, label: 'Replace', hint: 'Remove the MIDI and leave the audio.' },
  { id: 'keep' as const, label: 'Keep both', hint: 'Leave the MIDI playing next to the new audio.' },
]

/** Bounce options, progress, and the peak warning. Every control commits or cancels. */
export function RenderAudioSheet({ store }: { store: ProjectStore }) {
  const job = store.renderAudio
  if (!job) return null
  const busy = job.running
  const warn = job.warnDb != null
  return (
    <ArrangeBottomSheet
      id="render-audio"
      label="Render to audio"
      title="Render to audio"
      detail={job.name}
      onClose={() => store.cancelRenderAudio()}
    >
      <div className="render-audio-sheet" data-render-audio="sheet">
        {warn ? (
          <div className="render-warn" data-render-audio="warn">
            <p>Peaks at {job.warnDb!.toFixed(1)} dB. That is above 0 dBFS, so the 24-bit file will clip.</p>
            <button type="button" data-render-audio="place-anyway" onClick={() => store.confirmRendered(false)}>
              Place anyway
            </button>
            <button type="button" data-render-audio="normalize-place" onClick={() => store.confirmRendered(true)}>
              Normalize and place
            </button>
          </div>
        ) : (
          <>
            <div className="render-switches" role="group" aria-label="Render options">
              <button
                type="button"
                aria-pressed={job.includeEffects}
                data-render-audio="effects"
                disabled={busy}
                title="Run the track's insert effects. The master bus stays out."
                onClick={() => store.setRenderChoice({ includeEffects: !job.includeEffects })}
              >
                Include track effects
                <span>{job.includeEffects ? 'On' : 'Off'}</span>
              </button>
              <button
                type="button"
                aria-pressed={job.normalize}
                data-render-audio="normalize"
                disabled={busy}
                title="Peak-normalize to -0.1 dB. Off leaves the instrument level, and warns if it exceeds 0 dB."
                onClick={() => store.setRenderChoice({ normalize: !job.normalize })}
              >
                Normalize
                <span>{job.normalize ? 'On' : 'Off'}</span>
              </button>
            </div>
            <div className="render-places" role="group" aria-label="What happens to the original">
              {PLACES.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  aria-pressed={job.place === place.id}
                  data-render-place={place.id}
                  disabled={busy}
                  title={place.hint}
                  onClick={() => store.setRenderChoice({ place: place.id })}
                >
                  {place.label}
                </button>
              ))}
            </div>
            {job.error ? <p className="render-error" data-render-audio="error">{job.error}</p> : null}
            {busy ? (
              <div className="render-progress" data-render-audio="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)} aria-label="Rendering">
                <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
                <em>{Math.round(job.progress * 100)}%</em>
              </div>
            ) : (
              <button type="button" className="render-go" data-render-audio="run" title="Render through the current preset and place the audio below." onClick={() => void store.runRenderAudio()}>
                Render
              </button>
            )}
          </>
        )}
      </div>
    </ArrangeBottomSheet>
  )
}

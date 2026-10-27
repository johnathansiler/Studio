import { useState } from 'react'
import { etaSeconds, formatBytes, formatEta, modeAllowed, modelFor, stemBudget, type StemMode, type StemQuality } from '../audio/stems/engine'
import { cancelStems, resumeStems, startStems } from '../audio/stems/job'
import type { ProjectStore } from '../state/store'

const MODES: { mode: StemMode; label: string }[] = [
  { mode: 'vocals', label: 'Vocals' },
  { mode: '2', label: '2-stem' },
  { mode: '4', label: '4-stem' },
  { mode: '6', label: '6-stem' },
  { mode: 'instrumental', label: 'Remove vocals' },
  { mode: 'sampler', label: 'Sampler' },
]

export function StemSheet({ store }: { store: ProjectStore }) {
  const trackId = store.stemTrackId
  const clipId = store.stemClipId
  if (!trackId || !clipId) return null
  const found = store.findClip(clipId)
  const phone = window.matchMedia('(max-width: 940px)').matches
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory
  const budget = stemBudget(memory, phone, 'gpu' in navigator)
  const [quality, setQuality] = useState<StemQuality>('fast')
  const clip = found?.clip
  const asset = clip ? store.buffers.get(clip.bufferId) : undefined
  const seconds = clip && asset ? etaSeconds(clip.durationSamples, asset.sampleRate, quality === 'high' && budget.allowHigh ? 2 : 0) : 0
  const idle = `${formatBytes(modelFor('2').bytes)} · ${formatEta(seconds)}`
  const run = (mode: StemMode) => {
    if (!modeAllowed(mode, budget)) return
    startStems(store, { trackId, clipId, mode, quality: quality === 'high' && budget.allowHigh ? 'high' : 'fast' })
  }
  return (
    <div className="stem-sheet" role="dialog" aria-label="Stems">
      <header>
        <strong>Stems</strong>
        <button type="button" className="text-btn" onClick={() => store.closeStems()}>×</button>
      </header>
      {store.stemStatus ? (
        <div className="row">
          <progress value={store.stemStatus.ratio} max={1} aria-label="Progress" />
          <span className="readout">{store.stemStatus.line}</span>
          <button type="button" className="text-btn" onClick={() => cancelStems()}>Cancel</button>
        </div>
      ) : (
        <>
          <div className="row">
            {MODES.map((item) => (
              <button
                key={item.mode}
                type="button"
                className="text-btn"
                disabled={!modeAllowed(item.mode, budget)}
                onClick={() => run(item.mode)}
              >
                {item.label}
              </button>
            ))}
            <button type="button" className={`text-btn ${quality === 'fast' ? 'on' : ''}`} onClick={() => setQuality('fast')}>Fast</button>
            <button type="button" className={`text-btn ${quality === 'high' ? 'on' : ''}`} disabled={!budget.allowHigh} onClick={() => setQuality('high')}>High</button>
            {store.stemPaused && <button type="button" className="text-btn" onClick={() => resumeStems(store)}>Resume</button>}
          </div>
          <div className="readout">{idle}</div>
        </>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { drumIndex, DRUM_PADS } from '../model/drums'
import { DRUM_PAGE, drumRows, hitAt, stepCount } from '../model/drumLanes'
import { projectSampleBeat } from '../model/tempoMap'
import { displayedPlayhead } from '../model/transportSync'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'

export function DrumEditor({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const { track, clip, editor, project } = selectMidiEditor(store)
  const [now, setNow] = useState(-1)
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!clip) return
      if (engine.status !== 'playing' && engine.status !== 'recording') {
        setNow(-1)
        return
      }
      const beat = projectSampleBeat(project, displayedPlayhead(engine.positionSamples, project)) - clip.startBeat
      setNow(Math.floor(beat / 0.25))
    }, 80)
    return () => window.clearInterval(timer)
  }, [clip, engine, project])

  if (!track || !clip) return <p className="me-empty">Open a MIDI clip to edit drum lanes.</p>
  const rows = drumRows(clip.notes)
  const steps = stepCount(clip.durationBeats)
  const pages = Math.max(1, Math.ceil(steps / DRUM_PAGE))
  const page = Math.min(editor.page, pages - 1)
  const from = page * DRUM_PAGE
  const to = Math.min(steps, from + DRUM_PAGE)
  const selected = clip.notes.find((note) => note.id === store.selectedNoteId)
  const indexes = Array.from({ length: to - from }, (_, index) => from + index)
  return (
    <div className="me-drums">
      <div className="me-bar">
        <TipButton label="‹" hint="Show the previous 16 steps." disabled={page <= 0} onClick={() => store.setMidiEditor({ page: page - 1 })} />
        <span className="me-place">Steps {from + 1}–{to}</span>
        <TipButton label="›" hint="Show the next 16 steps." disabled={page >= pages - 1} onClick={() => store.setMidiEditor({ page: page + 1 })} />
        <label className="me-vel">
          Swing
          <input
            aria-label="Swing. Push the off-beats late when this clip plays."
            title="Push the off-beats late when this clip plays."
            type="range"
            min={0}
            max={0.6}
            step={0.01}
            value={clip.swing ?? 0}
            onChange={(event) => store.setClipSwing(track.id, clip.id, Number(event.target.value), true)}
            onPointerUp={() => store.endDraft()}
            onPointerCancel={() => store.endDraft()}
          />
        </label>
        {selected && (
          <>
            <label className="me-vel">
              Hit
              <input
                aria-label="Hit velocity. How hard this drum hit plays."
                title="How hard this drum hit plays."
                type="range"
                min={0.05}
                max={1}
                step={0.01}
                value={selected.velocity}
                onChange={(event) => {
                  const step = Math.round(selected.startBeat / 0.25)
                  store.setDrumHit(track.id, clip.id, selected.pitch, step, { velocity: Number(event.target.value) }, true)
                }}
                onPointerUp={() => store.endDraft()}
                onPointerCancel={() => store.endDraft()}
              />
            </label>
            <TipButton
              label="Flam"
              hint="Add a quiet grace hit just before this one."
              pressed={!!selected.flam}
              onClick={() => {
                const step = Math.round(selected.startBeat / 0.25)
                store.setDrumHit(track.id, clip.id, selected.pitch, step, { flam: !selected.flam })
              }}
            />
            <select
              aria-label="Roll. Repeat this hit inside the step."
              title="Repeat this hit inside the step."
              value={String(selected.roll ?? 1)}
              onChange={(event) => {
                const step = Math.round(selected.startBeat / 0.25)
                store.setDrumHit(track.id, clip.id, selected.pitch, step, { roll: Number(event.target.value) })
              }}
            >
              <option value="1">Hit</option>
              <option value="2">Double</option>
              <option value="3">Triple</option>
              <option value="4">Roll</option>
            </select>
            <TipButton
              label="Delete"
              hint="Remove this hit."
              onClick={() => {
                const step = Math.round(selected.startBeat / 0.25)
                store.setDrumHit(track.id, clip.id, selected.pitch, step, { on: false })
              }}
            />
          </>
        )}
      </div>
      <div className="me-lanes" role="grid" aria-label="Drum lanes. Each row is a pad. Tap a cell to add a hit.">
        {rows.map((row) => (
          <div className="me-lane" key={row.pitch} role="row">
            <span className="me-pad" title={`${row.name}. This row edits that pad.`}>{row.name}</span>
            {indexes.map((step) => {
              const hit = hitAt(clip.notes, row.pitch, step)
              const picked = hit && hit.id === store.selectedNoteId
              return (
                <button
                  key={step}
                  type="button"
                  role="gridcell"
                  data-pitch={row.pitch}
                  data-step={step}
                  className={`me-cell ${hit ? 'on' : ''} ${picked ? 'picked' : ''} ${hit?.flam ? 'flam' : ''} ${now === step ? 'now' : ''}`}
                  data-roll={hit?.roll || undefined}
                  style={hit ? { opacity: 0.35 + hit.velocity * 0.65 } : undefined}
                  aria-label={`${row.name}, step ${step + 1}. ${hit ? 'Has a hit.' : 'Empty.'} ${hit ? 'Tap to edit it.' : 'Tap to add a hit.'}`}
                  onClick={() => {
                    if (!hit) {
                      engine.unlock()
                      engine.liveNoteOn(row.pitch, editor.velocity, drumIndex(row.pitch, DRUM_PADS))
                      store.setDrumHit(track.id, clip.id, row.pitch, step, { on: true, velocity: editor.velocity })
                      return
                    }
                    store.selectNote(hit.id)
                  }}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

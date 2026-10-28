import { useRef, useState } from 'react'
import { SECTION_KINDS } from '../model/sections'
import type { SectionKind } from '../model/types'
import {
  meterAtSample,
  projectBeatSample,
  projectSampleBeat,
  projectTempoMap,
  pxAtBeat,
  tempoAtBeat,
  tempoAtSample,
} from '../model/tempoMap'
import type { ProjectStore } from '../state/store'
import './songMap.css'

const METERS = ['4/4', '3/4', '6/8', '5/4', '7/8']

function watch(move: (event: PointerEvent) => void, up: (event: PointerEvent) => void) {
  const end = (event: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    up(event)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
}

export function SmartTempoBar({ store }: { store: ProjectStore }) {
  const offer = store.smartTempo
  if (!offer) return null
  return (
    <div className="smart-tempo" role="group" aria-label="Smart tempo">
      <span>This clip is about {offer.bpm.toFixed(1)} BPM.</span>
      <button type="button" title="Set the song tempo to this clip" onClick={() => store.adaptClipTempo(offer.trackId, offer.clipId)}>
        Use for song
      </button>
      <button type="button" title="Stretch this clip to the song tempo without changing its pitch" onClick={() => store.conformClipTempo(offer.trackId, offer.clipId)}>
        Fit to song
      </button>
      <button type="button" title="Leave the song tempo and the clip as they are" onClick={() => store.dismissSmartTempo()}>
        Not now
      </button>
    </div>
  )
}

export function SongMapHead({ store, position }: { store: ProjectStore; position: number }) {
  const project = store.project
  const section = project.sections?.find((item) => item.id === store.sectionId) ?? null
  const point = (project.tempoMap ?? []).find((item) => store.tempoPointBeat != null && Math.abs(item.beat - store.tempoPointBeat) < 0.04)
  const meter = meterAtSample(project, position)
  const playBeat = () => projectSampleBeat(project, position)
  return (
    <div className="map-head">
      <div className="row">
        <button type="button" title="Add a named section at the playhead" aria-label="Add section" disabled={store.remoteFollow} onClick={() => store.addSection('verse', playBeat())}>
          Sec
        </button>
        <button type="button" title="Drop a marker at the playhead" aria-label="Add marker" disabled={store.remoteFollow} onClick={() => store.addSection('marker', playBeat())}>
          Mark
        </button>
        <button
          type="button"
          title="Add a tempo change at the playhead"
          aria-label="Add tempo change"
          disabled={store.remoteFollow}
          onClick={() => store.addTempoPoint(project.snap ? Math.round(playBeat()) : playBeat(), tempoAtSample(project, position))}
        >
          BPM
        </button>
      </div>
      {section ? (
        <div className="row">
          <input
            aria-label="Section name"
            title="Name this section"
            value={section.name}
            disabled={store.remoteFollow}
            onChange={(event) => store.renameSection(section.id, event.target.value)}
          />
          <select
            aria-label="Section type"
            title="Intro, verse, chorus, and the other parts of the song"
            value={section.kind}
            disabled={store.remoteFollow}
            onChange={(event) => store.recolorSection(section.id, event.target.value as SectionKind)}
          >
            {SECTION_KINDS.map((kind) => (
              <option key={kind.id} value={kind.id}>{kind.name}</option>
            ))}
          </select>
          <button type="button" title="Copy this section and everything inside it" aria-label="Duplicate section" disabled={store.remoteFollow} onClick={() => store.duplicateSection(section.id)}>
            Copy
          </button>
          <button type="button" title="Remove this section and close the gap" aria-label="Delete section" disabled={store.remoteFollow} onClick={() => store.deleteSection(section.id)}>
            Del
          </button>
        </div>
      ) : (
        <div className="row">
          <select
            aria-label="Time signature at the playhead"
            title="Time signature starting at this bar"
            value={`${meter.numerator}/${meter.denominator}`}
            disabled={store.remoteFollow}
            onChange={(event) => {
              const [numerator, denominator] = event.target.value.split('/').map(Number)
              store.setMeterAt(playBeat(), numerator, denominator)
            }}
          >
            {METERS.map((sig) => (
              <option key={sig}>{sig}</option>
            ))}
          </select>
          {point && (
            <button
              type="button"
              className={point.ramp ? 'on' : ''}
              aria-pressed={!!point.ramp}
              title="Glide into this tempo instead of jumping"
              disabled={store.remoteFollow}
              onClick={() => store.moveTempoPoint(point.beat, { ramp: !point.ramp })}
            >
              Ramp
            </button>
          )}
          {point && point.beat > 1e-3 && (
            <button type="button" title="Remove this tempo change" aria-label="Delete tempo change" disabled={store.remoteFollow} onClick={() => store.removeTempoPoint(point.beat)}>
              Del
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export function SongMap({ store, px, width, onSeek }: { store: ProjectStore; px: number; width: number; onSeek: (sample: number) => void }) {
  const project = store.project
  const mapRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ id: string; beat: number; duration: number } | null>(null)
  const [pointDrag, setPointDrag] = useState<{ from: number; beat: number; bpm: number } | null>(null)
  const tempo = projectTempoMap(project)
  const maxBeat = Math.max(4, projectSampleBeat(project, (width / Math.max(1, px)) * project.sampleRate))

  function beatFromClient(clientX: number) {
    const rect = mapRef.current?.getBoundingClientRect()
    if (!rect) return 0
    const sample = ((clientX - rect.left) / px) * project.sampleRate
    const beat = Math.max(0, projectSampleBeat(project, sample))
    return project.snap ? Math.round(beat) : beat
  }

  function bpmFromClient(clientY: number) {
    const lane = mapRef.current?.querySelector('.tempo-lane')?.getBoundingClientRect()
    if (!lane) return project.tempo
    const t = 1 - (clientY - lane.top) / Math.max(1, lane.height)
    return Math.max(30, Math.min(300, Math.round((40 + Math.max(0, Math.min(1, t)) * 240) * 10) / 10))
  }

  function yOf(bpm: number) {
    const t = (Math.max(40, Math.min(280, bpm)) - 40) / 240
    return 30 - t * 24
  }

  const curve: string[] = []
  const steps = Math.min(360, Math.max(24, Math.ceil(maxBeat * 2)))
  for (let index = 0; index <= steps; index++) {
    const beat = (maxBeat * index) / steps
    curve.push(`${pxAtBeat(project, beat, px)},${yOf(tempoAtBeat(beat, project.tempo, tempo))}`)
  }

  return (
    <div className="song-map" ref={mapRef} style={{ width }}>
      <div
        className="section-lane"
        role="group"
        aria-label="Song sections"
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('.section-block')) return
          event.stopPropagation()
          store.selectSection(null)
          store.selectTempoPoint(null)
          onSeek(Math.max(0, projectBeatSample(project, beatFromClient(event.clientX))))
        }}
      >
        {(project.sections ?? []).map((section) => {
          const shown = drag?.id === section.id ? { ...section, startBeat: drag.beat, durationBeats: drag.duration } : section
          const left = pxAtBeat(project, shown.startBeat, px)
          const marker = shown.durationBeats <= 0 || shown.kind === 'marker'
          const right = marker ? left + 14 : pxAtBeat(project, shown.startBeat + shown.durationBeats, px)
          return (
            <button
              key={section.id}
              type="button"
              className={`section-block ${marker ? 'marker' : ''} ${store.sectionId === section.id ? 'on' : ''}`}
              style={{ left, width: Math.max(marker ? 14 : 28, right - left), background: marker ? undefined : section.color, ['--mark' as string]: section.color }}
              title={marker ? `${section.name} marker. Drag to move it.` : `${section.name}. Drag to move this part and everything in it.`}
              aria-label={section.name}
              onPointerDown={(event) => {
                event.stopPropagation()
                if (store.remoteFollow) return
                store.selectSection(section.id)
                const edge = (event.target as HTMLElement).dataset.edge === 'end'
                const originBeat = section.startBeat
                let beat = originBeat
                let duration = section.durationBeats
                watch(
                  (ev) => {
                    if (edge) duration = Math.max(0.25, beatFromClient(ev.clientX) - originBeat)
                    else beat = beatFromClient(ev.clientX)
                    setDrag({ id: section.id, beat, duration })
                  },
                  () => {
                    setDrag(null)
                    if (edge) {
                      if (Math.abs(duration - section.durationBeats) > 0.01) store.resizeSection(section.id, duration)
                      return
                    }
                    if (Math.abs(beat - originBeat) > 0.01) store.moveSection(section.id, beat)
                  },
                )
              }}
            >
              {marker ? '' : section.name}
              {!marker && <span className="section-edge" data-edge="end" title="Change how long this section is" />}
            </button>
          )
        })}
      </div>
      <div
        className="tempo-lane"
        role="group"
        aria-label="Tempo track"
        title="Tempo changes along the song. Tap an empty spot to add a change. Drag a point to move it."
        onPointerDown={(event) => {
          event.stopPropagation()
          if (store.remoteFollow || (event.target as HTMLElement).closest('.tempo-point')) return
          const beat = beatFromClient(event.clientX)
          const bpm = bpmFromClient(event.clientY)
          const originX = event.clientX
          const originY = event.clientY
          watch(
            () => undefined,
            (ev) => {
              if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 6) return
              store.addTempoPoint(beat, bpm)
            },
          )
        }}
      >
        <svg className="tempo-curve" viewBox={`0 0 ${Math.max(1, width)} 34`} preserveAspectRatio="none" aria-hidden>
          <polyline points={curve.join(' ')} />
        </svg>
        {(project.meterMap ?? []).map((change) => (
          <span key={change.beat} className="meter-flag" style={{ left: pxAtBeat(project, change.beat, px) }}>
            {change.numerator}/{change.denominator}
          </span>
        ))}
        {tempo.map((point) => {
          const live = pointDrag && Math.abs(pointDrag.from - point.beat) < 0.04 ? pointDrag : null
          const beat = live?.beat ?? point.beat
          const bpm = live?.bpm ?? point.bpm
          const selected = store.tempoPointBeat != null && Math.abs((store.tempoPointBeat ?? 0) - point.beat) < 0.04
          return (
            <button
              key={`${point.beat}-${point.bpm}`}
              type="button"
              className={`tempo-point ${point.ramp ? 'ramp' : ''} ${selected ? 'on' : ''}`}
              style={{ left: pxAtBeat(project, beat, px), top: yOf(bpm) }}
              aria-label={`${bpm} BPM at beat ${beat.toFixed(1)}`}
              title={point.ramp ? `${bpm} BPM, gliding in. Drag to reshape.` : `${bpm} BPM. Drag to move this tempo change.`}
              onPointerDown={(event) => {
                event.stopPropagation()
                if (store.remoteFollow) return
                store.selectTempoPoint(point.beat)
                const from = point.beat
                let beatNext = point.beat
                let bpmNext = point.bpm
                watch(
                  (ev) => {
                    beatNext = from <= 1e-3 ? 0 : beatFromClient(ev.clientX)
                    bpmNext = bpmFromClient(ev.clientY)
                    setPointDrag({ from, beat: beatNext, bpm: bpmNext })
                  },
                  () => {
                    setPointDrag(null)
                    if (Math.abs(bpmNext - point.bpm) < 0.05 && Math.abs(beatNext - from) < 0.01) return
                    const explicit = (store.project.tempoMap ?? []).some((item) => Math.abs(item.beat - from) < 0.04)
                    if (!explicit && from <= 1e-3) store.setTempo(bpmNext)
                    else if (!explicit) store.addTempoPoint(beatNext, bpmNext)
                    else store.moveTempoPoint(from, { beat: beatNext, bpm: bpmNext })
                  },
                )
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

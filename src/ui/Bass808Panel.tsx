import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { bassPadPitches } from '../audio/bass808/pattern'
import { BASS808_SHOTS } from '../audio/bass808/shots'
import { bassDevice } from '../audio/bass808/track'
import { activeDevicePreset, DEVICE_PARAMS, FACTORY_PRESETS } from '../model/rack'
import { samplesToBeats } from '../model/time'
import type { ProjectStore } from '../state/store'
import { Knob } from './kit/controls'
import './bass808.css'

const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']
const KNOBS = ['glide', 'drop', 'attack', 'decay', 'sustain', 'tone', 'drive', 'sub', 'click', 'level'] as const

function noteLabel(midi: number) {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  return `${NAMES[pc]}${Math.floor(midi / 12) - 1}`
}

export function Bass808Panel({
  store,
  engine,
  trackId,
  onClose,
  onRecord,
  onStop,
  onPlay,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  onClose: () => void
  onRecord: () => void
  onStop: () => void
  onPlay: () => void
}) {
  const [, setTick] = useState(0)
  const [tab, setTab] = useState<'tone' | 'play'>('tone')
  const [shot, setShot] = useState('')
  const [busy, setBusy] = useState(false)
  const held = useRef(new Set<number>())
  const takes = useRef(new Map<number, { clipId: string; noteId: string; start: number }>())
  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
  const track = store.track(trackId)
  const device = bassDevice(track)
  const params = device?.params
  const specs = DEVICE_PARAMS.bass808
  const scale = store.project.scale
  const pads = bassPadPitches(scale?.root ?? 0, scale?.scale)
  const wide = typeof window !== 'undefined' && window.innerWidth >= 720
  const zone = device?.zones[0]
  const loadedShot = BASS808_SHOTS.find((item) => item.name === (zone ? store.buffers.get(zone.bufferId)?.name : ''))?.id ?? ''
  useEffect(() => { setShot(loadedShot) }, [loadedShot])

  function setParam(id: string, value: number) {
    if (!device) return
    const spec = specs.find((item) => item.id === id)
    const rolling = engine.status === 'playing' || engine.status === 'recording'
    store.setAutomated(
      { trackId, target: 'instrument', param: id, deviceId: device.id, min: spec?.min ?? 0, max: spec?.max ?? 1 },
      value,
      rolling,
      engine.currentTimelineSample(),
    )
  }

  function down(pitch: number) {
    if (!track) return
    const slide = held.current.size > 0
    held.current.add(pitch)
    engine.unlock()
    engine.playThrough(track.id, pitch, 0.9)
    if (engine.status !== 'recording') return
    const beat = samplesToBeats(engine.currentTimelineSample(), engine.sampleRate || store.project.sampleRate, store.project.tempo)
    let clip = store.track(track.id)?.midiClips[0]
    if (!clip) {
      store.addMidiClip(track.id, Math.max(0, beat))
      clip = store.track(track.id)?.midiClips.at(-1)
    }
    if (!clip) return
    const start = Math.max(0, beat - clip.startBeat)
    store.addNote(track.id, clip.id, {
      pitch,
      startBeat: start,
      durationBeats: 0.25,
      velocity: 0.9,
      ...(slide ? { slide: true } : {}),
    })
    const noteId = store.selectedNoteId
    if (noteId) takes.current.set(pitch, { clipId: clip.id, noteId, start })
  }

  function up(pitch: number) {
    held.current.delete(pitch)
    const take = takes.current.get(pitch)
    takes.current.delete(pitch)
    if (take && engine.status === 'recording') {
      const beat = samplesToBeats(engine.currentTimelineSample(), engine.sampleRate || store.project.sampleRate, store.project.tempo)
      const clip = store.track(trackId)?.midiClips.find((item) => item.id === take.clipId)
      if (clip) {
        const duration = Math.max(0.05, beat - clip.startBeat - take.start)
        store.updateNote(trackId, take.clipId, take.noteId, { durationBeats: duration })
      }
    }
    engine.releaseThrough(trackId, pitch)
  }

  if (!track || !device || !params) return null
  const preset = activeDevicePreset('bass808', params)
  const knobs = KNOBS.map((id) => specs.find((item) => item.id === id)).filter((item): item is NonNullable<typeof item> => !!item)

  return (
    <div className="bass808" data-bass808="open" data-screen-overlay="" data-tab={wide ? 'both' : tab} role="dialog" aria-label="808 Bass">
      <header className="bass808-bar">
        <h2>808 Bass</h2>
        <button type="button" className="bass-quiet bass-close" onClick={onClose}>Close</button>
      </header>
      <div className="plugin-transport" data-plugin-transport="open" aria-label="Transport">
        <button type="button" aria-label="Record" onClick={onRecord}>Record</button>
        <button type="button" aria-label="Stop" onClick={onStop}>Stop</button>
        <button type="button" aria-label="Play" onClick={onPlay}>Play</button>
      </div>
      <div className="bass808-tabs" role="tablist" aria-label="808 Bass pages">
        <button type="button" role="tab" aria-selected={tab === 'tone'} onClick={() => setTab('tone')}>Tone</button>
        <button type="button" role="tab" aria-selected={tab === 'play'} onClick={() => setTab('play')}>Play</button>
      </div>
      <div className="bass808-body">
        <section className="bass-tone" aria-label="Tone">
          <div className="bass-presets" role="group" aria-label="Presets">
            {FACTORY_PRESETS.bass808.map((item) => (
              <button
                key={item.name}
                type="button"
                className={`bass-quiet${preset === item.name ? ' on' : ''}`}
                aria-pressed={preset === item.name}
                onClick={() => store.applyDevicePreset(track.id, device.id, item.name)}
              >
                {item.name}
              </button>
            ))}
          </div>
          <div
            className="bass-knobs"
            onPointerDown={() => store.beginAutomationTouch()}
            onPointerUp={() => store.endAutomationTouch()}
            onPointerCancel={() => store.endAutomationTouch()}
          >
            {knobs.map((spec) => (
              <Knob
                key={spec.id}
                label={spec.name}
                min={spec.min}
                max={spec.max}
                value={params[spec.id] ?? spec.default}
                fallback={spec.default}
                unit={spec.unit}
                onChange={(value) => setParam(spec.id, value)}
              />
            ))}
          </div>
          <div className="bass-modes" role="group" aria-label="Glide mode">
            <button type="button" className={`bass-quiet${(params.gmode ?? 1) < 0.5 ? ' on' : ''}`} aria-pressed={(params.gmode ?? 1) < 0.5} onClick={() => setParam('gmode', 0)}>Always</button>
            <button type="button" className={`bass-quiet${(params.gmode ?? 1) >= 0.5 ? ' on' : ''}`} aria-pressed={(params.gmode ?? 1) >= 0.5} onClick={() => setParam('gmode', 1)}>Legato only</button>
            <button type="button" className={`bass-quiet${(params.source ?? 0) < 0.5 ? ' on' : ''}`} aria-pressed={(params.source ?? 0) < 0.5} onClick={() => setParam('source', 0)}>Synth</button>
            <button type="button" className={`bass-quiet${(params.source ?? 0) >= 0.5 ? ' on' : ''}`} aria-pressed={(params.source ?? 0) >= 0.5} onClick={() => setParam('source', 1)}>Sample</button>
          </div>
          <label className="bass-sample">
            <span className="bass-quiet">808 shot</span>
            <select
              aria-label="808 one-shot"
              value={shot}
              disabled={busy}
              onChange={(event) => {
                const id = event.target.value
                setShot(id)
                if (!id) {
                  setParam('source', 0)
                  return
                }
                setBusy(true)
                void store.loadBassShot(track.id, id).finally(() => setBusy(false))
              }}
            >
              <option value="">Synthesized body</option>
              {BASS808_SHOTS.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </label>
        </section>
        <section className="bass-play" aria-label="Play">
          <button
            type="button"
            className="bass-quiet"
            onClick={() => store.insertBassPattern(track.id, 0)}
          >
            Drill/Trap pattern
          </button>
          <div className="bass-pads">
            {pads.map((pitch) => (
              <button
                key={pitch}
                type="button"
                className="bass-pad"
                aria-label={`Pad ${noteLabel(pitch)}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  down(pitch)
                  event.currentTarget.classList.add('on')
                  try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
                }}
                onPointerUp={(event) => {
                  up(pitch)
                  event.currentTarget.classList.remove('on')
                }}
                onPointerCancel={(event) => {
                  up(pitch)
                  event.currentTarget.classList.remove('on')
                }}
              >
                {noteLabel(pitch)}
              </button>
            ))}
          </div>
          <div className="bass-keys" aria-label="Keys">
            {Array.from({ length: 13 }, (_, index) => 36 + index).filter((pitch) => ![1, 3, 6, 8, 10].includes(pitch % 12)).map((pitch) => (
              <button
                key={pitch}
                type="button"
                aria-label={`Key ${noteLabel(pitch)}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  down(pitch)
                  event.currentTarget.classList.add('on')
                  try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
                }}
                onPointerUp={(event) => {
                  up(pitch)
                  event.currentTarget.classList.remove('on')
                }}
                onPointerCancel={(event) => {
                  up(pitch)
                  event.currentTarget.classList.remove('on')
                }}
              >
                {pitch % 12 === 0 ? noteLabel(pitch) : ''}
              </button>
            ))}
            {Array.from({ length: 13 }, (_, index) => 36 + index).filter((pitch) => [1, 3, 6, 8, 10].includes(pitch % 12)).map((pitch) => {
              const whiteBefore = [0, 2, 4, 5, 7, 9, 11, 12].filter((pc) => pc < (pitch - 36)).length
              return (
                <button
                  key={pitch}
                  type="button"
                  className="black"
                  aria-label={`Key ${noteLabel(pitch)}`}
                  style={{ left: `calc(${whiteBefore} * 12.5% - 9px)` }}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    down(pitch)
                    event.currentTarget.classList.add('on')
                    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
                  }}
                  onPointerUp={(event) => {
                    up(pitch)
                    event.currentTarget.classList.remove('on')
                  }}
                  onPointerCancel={(event) => {
                    up(pitch)
                    event.currentTarget.classList.remove('on')
                  }}
                />
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}

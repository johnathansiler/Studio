import { useEffect, useRef, useState } from 'react'
import { Performer, pointerVelocity, type PerformTarget } from '../audio/performer'
import type { AudioEngine } from '../audio/engine'
import { DRUM_PADS, stepIndex } from '../model/drums'
import type { RepeatRate } from '../model/midiClock'
import { NOTE_NAMES, SCALES, type ScaleId } from '../model/scale'
import type { ProjectStore } from '../state/store'
import type { SessionClient } from '../remote/session'

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const BLACK = [1, 3, 6, 8, 10]
const KEYBOARD: Record<string, number> = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71 }

export function PerformPop({
  mode,
  store,
  engine,
  session,
  onRecord,
  onClose,
}: {
  mode: 'keys' | 'drums'
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onRecord: () => void
  onClose: () => void
}) {
  const drums = mode === 'drums'
  const board = useRef<HTMLDivElement>(null)
  const performer = useRef<Performer | null>(null)
  const target = useRef<PerformTarget | null>(null)
  const [octave, setOctave] = useState(0)
  const [repeat, setRepeat] = useState<RepeatRate | null>(null)
  const [triplet, setTriplet] = useState(false)
  const [latency, setLatency] = useState(() => Math.round(engine.roundTripMs))
  const [focus, setFocus] = useState(engine.performanceMode)
  const scale = store.scaleState()
  const record = store.recordSettings()
  const clip = currentClip(store)

  if (!performer.current) {
    performer.current = new Performer(
      engine,
      () => target.current,
      (aimed, notes) => store.addPerformedNotes(aimed.trackId, aimed.clipId, notes),
      () => engine.status === 'recording',
    )
  }

  useEffect(() => {
    target.current = ensureTarget(store, drums)
    performer.current?.setScale(scale.snap, scale.root, scale.scale, octave)
    performer.current?.setRepeat(repeat, triplet)
    performer.current?.setQuantize(record.quantizeBeats || 0)
  })

  useEffect(() => {
    engine.unlock()
    setLatency(Math.round(engine.roundTripMs))
    void engine.resume().then(async () => {
      const measured = await engine.measureLiveHit()
      setLatency(Math.round(measured.graphMs >= 0 ? measured.roundTripMs : engine.roundTripMs))
    })
    const timer = window.setInterval(() => setLatency(Math.round(engine.roundTripMs)), 1000)
    return () => window.clearInterval(timer)
  }, [engine])

  useEffect(() => {
    const root = board.current
    const play = performer.current
    if (!root || !play) return
    const pointers = new Map<number, HTMLElement>()
    const down = (event: PointerEvent) => {
      const key = (event.target as HTMLElement).closest?.('[data-pitch]') as HTMLElement | null
      if (!key || !root.contains(key)) return
      event.preventDefault()
      const pitch = Number(key.dataset.pitch)
      play.down(pitch, pointerVelocity(event, key.getBoundingClientRect()), event.timeStamp, event.pointerId)
      key.classList.add('lit')
      pointers.set(event.pointerId, key)
    }
    const up = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return
      pointers.get(event.pointerId)?.classList.remove('lit')
      pointers.delete(event.pointerId)
      play.up(event.pointerId, event.timeStamp)
    }
    root.addEventListener('pointerdown', down, { passive: false })
    root.addEventListener('pointerup', up)
    root.addEventListener('pointercancel', up)
    return () => {
      root.removeEventListener('pointerdown', down)
      root.removeEventListener('pointerup', up)
      root.removeEventListener('pointercancel', up)
    }
  }, [drums])

  useEffect(() => {
    const play = performer.current
    if (!play || drums) return
    const downKeys = new Set<string>()
    const down = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return
      const tag = (event.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const pitch = KEYBOARD[event.key.toLowerCase()]
      if (pitch == null || downKeys.has(event.key)) return
      event.preventDefault()
      downKeys.add(event.key)
      play.down(pitch, 0.8, event.timeStamp, 2000 + pitch)
    }
    const up = (event: KeyboardEvent) => {
      const pitch = KEYBOARD[event.key.toLowerCase()]
      if (pitch == null || !downKeys.has(event.key)) return
      downKeys.delete(event.key)
      play.up(2000 + pitch, event.timeStamp)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [drums])

  useEffect(() => {
    if (drums || !navigator.requestMIDIAccess) return
    let dead = false
    const play = performer.current
    void navigator.requestMIDIAccess().then((access) => {
      if (dead || !play) return
      const bind = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            if (!event.data) return
            play.midi(event.data, event.timeStamp, window.performance.now())
          }
        }
      }
      bind()
      access.onstatechange = bind
    }).catch(() => undefined)
    return () => {
      dead = true
    }
  }, [drums])

  const base = 60
  return (
    <div className={`perform-pop ${drums ? 'drums' : 'keys'}`} role="dialog" aria-label={drums ? 'Drum machine' : 'Piano roll'}>
      <header>
        <strong>{drums ? 'Drums' : 'Keys'}</strong>
        <button type="button" className={engine.status === 'recording' ? 'on' : ''} onClick={onRecord}>Rec</button>
        {!drums && (
          <>
            <button type="button" onClick={() => setOctave((value) => Math.max(-3, value - 1))} aria-label="Octave down">−</button>
            <span className="octave">{NOTE_NAMES[(base + octave * 12) % 12]}{Math.floor((base + octave * 12) / 12) - 1}</span>
            <button type="button" onClick={() => setOctave((value) => Math.min(3, value + 1))} aria-label="Octave up">+</button>
            <button type="button" className={scale.snap ? 'on' : ''} onClick={() => store.setScale({ snap: !scale.snap })}>Scale</button>
          </>
        )}
        {(['1/8', '1/16', '1/32'] as RepeatRate[]).map((rate) => (
          <button key={rate} type="button" className={repeat === rate ? 'on' : ''} onClick={() => setRepeat((value) => (value === rate ? null : rate))}>{rate}</button>
        ))}
        <button type="button" className={triplet ? 'on' : ''} onClick={() => setTriplet((value) => !value)}>Triplet</button>
        <select aria-label="Record quantize" value={record.quantizeBeats || 0} onChange={(event) => store.setRecord({ quantizeBeats: Number(event.target.value) })}>
          <option value={0}>Quantize off</option>
          <option value={1}>1/4</option>
          <option value={0.5}>1/8</option>
          <option value={0.25}>1/16</option>
        </select>
        <button type="button" className={focus ? 'on' : ''} onClick={() => {
          const next = !engine.performanceMode
          engine.performanceMode = next
          setFocus(next)
        }}>Focus</button>
        <span className="latency" aria-label="Monitoring latency">{latency} ms</span>
        <button type="button" onClick={() => void session.calibrate()}>Calibrate</button>
        <button type="button" onClick={onClose} aria-label="Close">×</button>
      </header>
      {!drums && (
        <div className="scale-row">
          <select aria-label="Key" value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
            {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <select aria-label="Scale" value={scale.scale} onChange={(event) => store.setScale({ scale: event.target.value as ScaleId })}>
            {SCALES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
      )}
      <div className="perform-body">
        <div className="perform-play" ref={board}>
          {drums ? (
            <div className="drum-pads">
              {DRUM_PADS.map((pad) => (
                <button key={pad.pitch} type="button" data-pitch={pad.pitch}>{pad.name}</button>
              ))}
            </div>
          ) : (
            <div className="play-keys">
              {WHITE.map((pc) => {
                const pitch = base + pc
                return <button key={pitch} type="button" className="white" data-pitch={pitch}>{NOTE_NAMES[pc]}</button>
              })}
              <div className="blacks">
                {BLACK.map((pc) => (
                  <button key={pc} type="button" className="black" data-pitch={base + pc} style={{ left: `${((WHITE.indexOf(pc - 1) + 1) / WHITE.length) * 100}%` }} />
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="perform-edit">
          {drums && clip ? (
            <div className="step-grid" role="grid" aria-label="Step grid">
              {DRUM_PADS.map((pad) => (
                <div className="step-row" key={pad.pitch}>
                  <span>{pad.name}</span>
                  {Array.from({ length: 16 }, (_, step) => {
                    const on = clip.notes.some((note) => note.pitch === pad.pitch && stepIndex(note.startBeat) === step && note.startBeat < 4)
                    return (
                      <button
                        key={step}
                        type="button"
                        className={on ? 'on' : ''}
                        aria-label={`${pad.name} step ${step + 1}`}
                        onClick={() => store.toggleDrumStep(clip.trackId, clip.clipId, pad.pitch, step)}
                      />
                    )
                  })}
                </div>
              ))}
            </div>
          ) : clip ? (
            <div className="roll-grid" aria-label="Piano roll">
              {clip.notes.map((note) => (
                <i key={note.id} style={{ left: `${note.startBeat * 48}px`, width: `${Math.max(8, note.durationBeats * 48)}px`, top: `${(84 - note.pitch) * 8}px` }} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function currentClip(store: ProjectStore) {
  for (const track of store.project.tracks) {
    const clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId) || (track.type === 'midi' ? track.midiClips[0] : undefined)
    if (clip && (store.selectedMidiClipId === clip.id || track.id === store.selectedTrackId)) {
      return { trackId: track.id, clipId: clip.id, notes: clip.notes }
    }
  }
  const track = store.project.tracks.find((item) => item.type === 'midi')
  const clip = track?.midiClips[0]
  return clip && track ? { trackId: track.id, clipId: clip.id, notes: clip.notes } : null
}

function ensureTarget(store: ProjectStore, drums: boolean): PerformTarget | null {
  let track = store.project.tracks.find((item) => item.type === 'midi' && (item.id === store.selectedTrackId || item.midiClips.some((clip) => clip.id === store.selectedMidiClipId)))
  if (!track) track = store.project.tracks.find((item) => item.type === 'midi')
  if (!track) {
    store.addTrack('midi')
    track = store.project.tracks.find((item) => item.type === 'midi')
  }
  if (!track) return null
  let clip = track.midiClips.find((item) => item.id === store.selectedMidiClipId) || track.midiClips[0]
  if (!clip) {
    store.addMidiClip(track.id, 0)
    clip = track.midiClips[track.midiClips.length - 1]
    if (clip && drums) clip.name = 'Drums'
  }
  if (!clip) return null
  return { trackId: track.id, clipId: clip.id, drums }
}

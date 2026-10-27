import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { emptyTap, pushTap, scaleTempo, tempoFromTaps, roundTempo, type TapMemory } from '../model/tap'
import { formatBarsBeats, formatTimecode } from '../model/time'
import type { ProjectStore } from '../state/store'

export function TransportBar({
  store,
  engine,
  syncLabel,
  onPlay,
  onStop,
  onRecord,
  onSeek,
  onPiano,
}: {
  store: ProjectStore
  engine: AudioEngine
  syncLabel?: string
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onSeek: (sample: number) => void
  onPiano?: (trackId: string) => void
}) {
  const project = store.project
  const midiTrack = project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
  const [position, setPosition] = useState(engine.positionSamples)
  const [status, setStatus] = useState(engine.status)
  const [tapOpen, setTapOpen] = useState(false)
  const [shown, setShown] = useState<number | null>(null)
  const [whole, setWhole] = useState(false)
  const memory = useRef<TapMemory>(emptyTap())
  const hold = useRef(0)
  const held = useRef(false)
  useEffect(
    () =>
      engine.subscribe(() => {
        setPosition(engine.positionSamples)
        setStatus(engine.status)
      }),
    [engine],
  )

  function register(at: number) {
    if (store.remoteFollow) return
    const result = pushTap(memory.current, at)
    memory.current = result.memory
    if (result.live != null) setShown(result.live)
    if (result.commit != null) store.setTempo(result.commit, true)
    setTapOpen(true)
  }

  function closeTap() {
    setTapOpen(false)
    setShown(null)
    memory.current = emptyTap(memory.current.whole)
    store.endTempoGroup()
  }

  function nudge(factor: number) {
    if (store.remoteFollow) return
    const next = scaleTempo(store.project.tempo, factor, whole)
    memory.current = { ...memory.current, taps: [] }
    setShown(next)
    store.setTempo(next, true)
    setTapOpen(true)
  }

  useEffect(() => {
    const onTap = (event: Event) => {
      if (store.remoteFollow || store.keyboardMidi) return
      register((event as CustomEvent<number>).detail)
    }
    window.addEventListener('cueharbor-tap', onTap)
    return () => window.removeEventListener('cueharbor-tap', onTap)
  })

  useEffect(() => {
    if (!tapOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTap()
    }
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.tap-pad, .bpm-readout')) return
      closeTap()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointer)
    }
  }, [tapOpen])

  const readout = (shown ?? project.tempo).toFixed(whole || shown == null && Number.isInteger(project.tempo) ? 0 : 1)
  return (
    <div className="transport">
      <div className="t-buttons">
        <button className="t-btn" onClick={() => onSeek(0)} title="Return to start">
          ⏮
        </button>
        <button className={`t-btn play ${status === 'playing' || status === 'recording' ? 'on' : ''}`} onClick={onPlay} title="Play">
          ▶
        </button>
        <button className="t-btn stop" onClick={onStop} title="Stop" disabled={status === 'stopped'}>
          Stop
        </button>
        <button className={`t-btn rec ${status === 'recording' || status === 'counting-in' ? 'on' : ''}`} onClick={onRecord} title="Record">
          ●
        </button>
        {midiTrack && onPiano && (
          <button type="button" className={`t-btn piano-btn ${store.selectedMidiClipId ? 'on' : ''}`} onClick={() => onPiano(midiTrack.id)}>Piano</button>
        )}
      </div>
      <div className="lcd-wrap">
        <div className="lcd">
          <div className="bars">{formatBarsBeats(position, project.sampleRate, project.tempo, project.timeSignature)}</div>
          <div className="tc">
            {formatTimecode(position, project.sampleRate)} · {status}
          </div>
        </div>
        {tapOpen ? (
          <div className="tap-pad">
            <button
              type="button"
              className="bpm-readout"
              aria-label="Tap tempo"
              onPointerDown={(event) => register(event.timeStamp)}
            >
              {readout}
            </button>
            <button type="button" aria-label="Half tempo" onClick={() => nudge(0.5)}>½</button>
            <button type="button" aria-label="Double tempo" onClick={() => nudge(2)}>2×</button>
            <button
              type="button"
              aria-label="Whole BPM"
              className={whole ? 'on' : ''}
              onClick={() => {
                const next = !whole
                setWhole(next)
                memory.current = { ...memory.current, whole: next }
                const raw = tempoFromTaps(memory.current.taps)
                if (raw == null) return
                const rounded = roundTempo(raw, next)
                setShown(rounded)
                if (memory.current.taps.length >= 3) store.setTempo(rounded, true)
              }}
            >
              {whole ? '1' : '.1'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="field bpm-readout"
            aria-label="BPM"
            disabled={store.remoteFollow}
            onPointerDown={() => {
              held.current = false
              window.clearTimeout(hold.current)
              hold.current = window.setTimeout(() => {
                held.current = true
                setTapOpen(true)
              }, 450)
            }}
            onPointerUp={(event) => {
              window.clearTimeout(hold.current)
              if (!held.current) register(event.timeStamp)
              held.current = false
            }}
            onPointerLeave={() => window.clearTimeout(hold.current)}
          >
            {readout}
          </button>
        )}
        <label className="field">
          Sig
          <select
            value={`${project.timeSignature.numerator}/${project.timeSignature.denominator}`}
            disabled={store.remoteFollow}
            onChange={(event) => {
              const [n, d] = event.target.value.split('/').map(Number)
              store.setTimeSignature(n, d)
            }}
          >
            {['4/4', '3/4', '6/8', '5/4', '7/8'].map((sig) => (
              <option key={sig}>{sig}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="t-toggles">
        <label className="toggle">
          <input type="checkbox" checked={project.metronomeEnabled} disabled={store.remoteFollow} onChange={() => store.toggle('metronomeEnabled')} /> Click
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.countIn} disabled={store.remoteFollow} onChange={() => store.toggle('countIn')} /> Count-in
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.loopEnabled} disabled={store.remoteFollow} onChange={() => store.toggle('loopEnabled')} /> Loop
        </label>
        <label className="toggle">
          <input type="checkbox" checked={project.snap} disabled={store.remoteFollow} onChange={() => store.toggle('snap')} /> Snap
        </label>
        {syncLabel && <span className="sync-pill">{syncLabel}</span>}
      </div>
    </div>
  )
}

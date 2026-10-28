import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { emptyTap, pushTap, scaleTempo, tempoFromTaps, roundTempo, type TapMemory } from '../model/tap'
import { formatMapBars } from '../model/tempoMap'
import { formatTimecode } from '../model/time'
import type { ProjectStore } from '../state/store'

export function TransportBar({
  store,
  engine,
  syncLabel,
  onPlay,
  onStop,
  onRecord,
  onSeek,
}: {
  store: ProjectStore
  engine: AudioEngine
  syncLabel?: string
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onSeek: (sample: number) => void
}) {
  const project = store.project
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
  const playing = status === 'playing' || status === 'recording'
  return (
    <div className="transport">
      <div className="t-buttons">
        <button type="button" className="t-btn" onClick={() => onSeek(0)} aria-label="Return to start">
          <SkipBackIcon />
        </button>
        <button type="button" className={`t-btn play ${playing ? 'on' : ''}`} onClick={onPlay} aria-label="Play">
          <PlayIcon />
        </button>
        <button type="button" className="t-btn stop" onClick={onStop} aria-label="Stop" disabled={status === 'stopped'}>
          <StopIcon />
        </button>
        <button type="button" className={`t-btn rec ${status === 'recording' || status === 'counting-in' ? 'on' : ''}`} onClick={onRecord} aria-label="Record">
          <RecIcon />
        </button>
      </div>
      <div className="lcd" aria-live="polite">
        <div className="bars">{formatMapBars(project, position)}</div>
        <div className="tc">{formatTimecode(position, project.sampleRate)} · {status}</div>
      </div>
      {tapOpen ? (
        <div className="tap-pad">
          <button type="button" className="bpm-readout" aria-label="Tap tempo" onPointerDown={(event) => register(event.timeStamp)}>
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
          className="bpm-readout"
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
      <button
        type="button"
        className={`t-btn loop ${project.loopEnabled ? 'on' : ''}`}
        aria-label="Loop"
        aria-pressed={project.loopEnabled}
        disabled={store.remoteFollow}
        onClick={() => store.toggle('loopEnabled')}
      >
        <LoopIcon />
      </button>
      {syncLabel && <span className="sync-pill">{syncLabel}</span>}
    </div>
  )
}

function SkipBackIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 3.2v9.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M13 3.4 5.6 8 13 12.6V3.4Z" fill="currentColor" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M5.2 3.1v9.8L13 8 5.2 3.1Z" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.2" fill="currentColor" />
    </svg>
  )
}

function RecIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="4" fill="currentColor" />
    </svg>
  )
}

function LoopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4.2 6.2h6.6a1.8 1.8 0 0 1 1.8 1.8V11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M6.2 4.1 3.8 6.2l2.4 2.1" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.8 9.8H5.2A1.8 1.8 0 0 1 3.4 8V5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M9.8 12 12.2 9.9 9.8 7.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

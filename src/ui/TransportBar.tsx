import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { emptyTap, pushTap, scaleTempo, tempoFromTaps, roundTempo, type TapMemory } from '../model/tap'
import { formatBarsBeats, formatTimecode } from '../model/time'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AutomationFollow } from './AutomationLane'
import { TRANSPORT_COPY, copyOf } from './chrome'
import { TipButton } from './Hint'

export function TransportBar({
  store,
  engine,
  syncLabel,
  onPlay,
  onStop,
  onRecord,
  onSeek,
  simple = false,
  takeProgress = null,
}: {
  store: ProjectStore
  engine: AudioEngine
  syncLabel?: string
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onSeek: (sample: number) => void
  /** Phone: keep play, stop, record, and tempo. To-start and loop live in the menu. */
  simple?: boolean
  /** 0–1 while a full-quality guest take is moving to the host. */
  takeProgress?: number | null
}) {
  const project = selectTransport(store).project
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
  const transport = (id: string) => copyOf(TRANSPORT_COPY, id)
  return (
    <div className="transport">
      <AutomationFollow store={store} engine={engine} />
      <div className="t-buttons">
        {!simple && (
          <TipButton className="t-btn" label={transport('to-start').label} hint={transport('to-start').hint} onClick={() => onSeek(0)}>
            <SkipBackIcon />
          </TipButton>
        )}
        <TipButton className={`t-btn play ${playing ? 'on' : ''}`} label={transport('play').label} hint={transport('play').hint} pressed={playing} onClick={onPlay}>
          <PlayIcon />
        </TipButton>
        <TipButton className="t-btn stop" label={transport('stop').label} hint={transport('stop').hint} disabled={status === 'stopped'} onClick={onStop}>
          <StopIcon />
        </TipButton>
        <TipButton className={`t-btn rec ${status === 'recording' || status === 'counting-in' ? 'on' : ''}`} label={transport('record').label} hint={transport('record').hint} pressed={status === 'recording' || status === 'counting-in'} onClick={onRecord}>
          <RecIcon />
        </TipButton>
      </div>
      <div className="lcd" aria-live="polite">
        <div className="bars">{formatBarsBeats(position, project.sampleRate, project.tempo, project.timeSignature)}</div>
        <div className="tc">
          {formatTimecode(position, project.sampleRate)} · {status}
          {takeProgress != null ? ` · HQ ${Math.round(takeProgress * 100)}%` : ''}
        </div>
      </div>
      {takeProgress != null && (
        <div
          className="hq-take"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(takeProgress * 100)}
          aria-valuetext={`Full-quality take ${Math.round(takeProgress * 100)} percent`}
          title="Full-quality take replacing the live guide"
        >
          <i style={{ width: `${Math.round(takeProgress * 100)}%` }} />
        </div>
      )}
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
          title={transport('tempo').hint}
          aria-label={`${transport('tempo').label}. ${transport('tempo').hint}`}
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
      {!simple && (
        <TipButton
          className={`t-btn loop ${project.loopEnabled ? 'on' : ''}`}
          label={transport('loop').label}
          hint={transport('loop').hint}
          pressed={project.loopEnabled}
          disabled={store.remoteFollow}
          onClick={() => store.toggle('loopEnabled')}
        >
          <LoopIcon />
        </TipButton>
      )}
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

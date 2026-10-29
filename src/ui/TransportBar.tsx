import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { formatLoopReadout } from '../model/loopEdit'
import { emptyTap, formatTempo, noteTapRelease, pushTap, roundTempo, type TapMemory, type TapSource } from '../model/tap'
import { formatMapBars } from '../model/tempoMap'
import { formatTimecode } from '../model/time'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AutomationFollow } from './AutomationLane'
import { TRANSPORT_COPY, copyOf } from './chrome'
import { TipButton } from './Hint'
import { loopFineSnap, setLoopFineSnap, subscribeLoopFine } from './loopFine'
import './loopRegion.css'

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
  const [live, setLive] = useState<number | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [flash, setFlash] = useState(false)
  const memory = useRef<TapMemory>(emptyTap())
  const fieldRef = useRef<HTMLInputElement>(null)
  const written = useRef<number | null>(null)
  const shown = useRef(project.tempo)
  const draftRef = useRef<string | null>(null)
  const drag = useRef<{ y: number; origin: number; moved: boolean } | null>(null)
  const suppressFocus = useRef(false)
  const tapping = useRef(false)
  const flashTimer = useRef(0)
  const tempo = live ?? project.tempo
  const tempoCopy = copyOf(TRANSPORT_COPY, 'tempo')
  const tapCopy = copyOf(TRANSPORT_COPY, 'tap')

  useEffect(
    () =>
      engine.subscribe(() => {
        setPosition(engine.positionSamples)
        setStatus(engine.status)
      }),
    [engine],
  )

  useEffect(() => {
    const writtenTempo = written.current
    if (writtenTempo != null && project.tempo === writtenTempo) return
    if (writtenTempo != null) {
      written.current = null
      setLive(null)
      memory.current = emptyTap()
      store.endTempoGroup()
    }
    if (draftRef.current == null) shown.current = project.tempo
  }, [project.tempo, store])

  function typedBase() {
    const text = draftRef.current
    if (text == null) return null
    const trimmed = text.trim()
    if (!trimmed || trimmed === '-' || trimmed === '.' || trimmed === '-.') return null
    const value = Number(trimmed)
    return Number.isFinite(value) ? value : null
  }

  function publish(bpm: number, group: boolean) {
    const next = roundTempo(bpm, false)
    shown.current = next
    written.current = next
    draftRef.current = null
    setLive(next)
    setDraft(null)
    if (next !== store.project.tempo) store.setTempo(next, group)
  }

  function bump(delta: number) {
    memory.current = emptyTap()
    const typed = typedBase()
    publish((typed ?? shown.current) + delta, true)
  }

  const bumpRef = useRef(bump)
  bumpRef.current = bump

  function pulse() {
    setFlash(true)
    window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlash(false), 160)
  }

  function applyTap(at: number, source: TapSource) {
    if (store.remoteFollow) return null
    const result = pushTap(memory.current, at, source)
    memory.current = result.memory
    if (result.ignored) return result
    tapping.current = true
    fieldRef.current?.blur()
    tapping.current = false
    draftRef.current = null
    setDraft(null)
    if (result.reset) {
      setLive(null)
      written.current = null
      shown.current = store.project.tempo
      store.endTempoGroup()
    }
    if (result.bpm != null) publish(result.bpm, true)
    return result
  }

  const applyRef = useRef(applyTap)
  applyRef.current = applyTap

  useEffect(() => {
    const onTap = (event: Event) => {
      if (store.remoteFollow || store.keyboardMidi) return
      const detail = (event as CustomEvent<number>).detail
      const at = typeof detail === 'number' && Number.isFinite(detail) ? detail : performance.now()
      applyRef.current(at, 'key')
      setFlash(true)
      window.clearTimeout(flashTimer.current)
      flashTimer.current = window.setTimeout(() => setFlash(false), 160)
    }
    window.addEventListener('cueharbor-tap', onTap)
    return () => window.removeEventListener('cueharbor-tap', onTap)
  }, [store])

  useEffect(() => () => {
    window.clearTimeout(flashTimer.current)
    store.endTempoGroup()
  }, [store])

  useEffect(() => {
    const node = fieldRef.current
    if (!node) return
    const onWheel = (event: WheelEvent) => {
      if (store.remoteFollow) return
      if (event.deltaY === 0) return
      event.preventDefault()
      const step = (event.deltaY < 0 ? 0.1 : -0.1) * (event.shiftKey ? 10 : 1)
      bumpRef.current(step)
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [store])

  function commitDraft(text: string) {
    if (tapping.current || drag.current?.moved || suppressFocus.current) return
    draftRef.current = null
    setDraft(null)
    const trimmed = text.trim()
    if (!trimmed) return
    const value = Number(trimmed)
    if (!Number.isFinite(value)) return
    const next = roundTempo(value, false)
    if (next === store.project.tempo && next === shown.current) return
    memory.current = emptyTap()
    store.endTempoGroup()
    publish(value, false)
  }

  function onTempoPointerDown(event: ReactPointerEvent<HTMLInputElement>) {
    if (store.remoteFollow || event.button !== 0) return
    drag.current = { y: event.clientY, origin: typedBase() ?? shown.current, moved: false }
  }

  function onTempoPointerMove(event: ReactPointerEvent<HTMLInputElement>) {
    const state = drag.current
    if (!state || store.remoteFollow) return
    const dy = state.y - event.clientY
    if (!state.moved) {
      if (Math.abs(dy) < 4) return
      state.moved = true
      suppressFocus.current = true
      memory.current = emptyTap()
      store.endTempoGroup()
      setDraft(null)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.currentTarget.blur()
    }
    publish(state.origin + dy * 0.2, true)
  }

  function onTempoPointerUp() {
    const moved = drag.current?.moved ?? false
    drag.current = null
    if (!moved) return
    store.endTempoGroup()
    window.setTimeout(() => {
      suppressFocus.current = false
    }, 0)
  }

  const playing = status === 'playing' || status === 'recording'
  const transport = (id: string) => copyOf(TRANSPORT_COPY, id)
  const loopRead = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const fine = useSyncExternalStore(subscribeLoopFine, loopFineSnap, loopFineSnap)
  return (
    <div className="transport">
      <AutomationFollow store={store} engine={engine} />
      <div className="t-buttons">
        {!simple && (
          <TipButton className="t-btn" label={transport('to-start').label} hint={transport('to-start').hint} onClick={() => onSeek(0)}>
            <SkipBackIcon />
            <span className="t-word">Start</span>
          </TipButton>
        )}
        <TipButton className={`t-btn play ${playing ? 'on' : ''}`} label={transport('play').label} hint={transport('play').hint} pressed={playing} onPress={() => engine.unlock()} onClick={onPlay}>
          <PlayIcon />
          <span className="t-word">Play</span>
        </TipButton>
        <TipButton className="t-btn stop" label={transport('stop').label} hint={transport('stop').hint} disabled={status === 'stopped'} onClick={onStop}>
          <StopIcon />
          <span className="t-word">Stop</span>
        </TipButton>
        <TipButton className={`t-btn rec ${status === 'recording' || status === 'counting-in' ? 'on' : ''}`} label={transport('record').label} hint={transport('record').hint} pressed={status === 'recording' || status === 'counting-in'} onPress={() => engine.unlock()} onClick={onRecord}>
          <RecIcon />
          <span className="t-word">Rec</span>
        </TipButton>
      </div>
      <div className="lcd" aria-live="polite">
        <div className="bars">{formatMapBars(project, position)}</div>
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
      <div className="tempo-cluster" role="group" aria-label="Tempo">
        <input
          ref={fieldRef}
          className="bpm-readout"
          type="number"
          inputMode="decimal"
          min={30}
          max={300}
          step={0.1}
          title={tempoCopy.hint}
          aria-label={`${tempoCopy.label}. ${tempoCopy.hint}`}
          disabled={store.remoteFollow}
          value={draft ?? formatTempo(tempo)}
          onFocus={(event) => {
            if (suppressFocus.current) {
              event.currentTarget.blur()
              return
            }
            draftRef.current = event.currentTarget.value
            setDraft(event.currentTarget.value)
            event.currentTarget.select()
          }}
          onChange={(event) => {
            draftRef.current = event.currentTarget.value
            setDraft(event.currentTarget.value)
          }}
          onBlur={(event) => commitDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur()
              return
            }
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const delta = (event.shiftKey ? 1 : 0.1) * (event.key === 'ArrowUp' ? 1 : -1)
            bump(delta)
          }}
          onPointerDown={onTempoPointerDown}
          onPointerMove={onTempoPointerMove}
          onPointerUp={onTempoPointerUp}
          onPointerCancel={onTempoPointerUp}
        />
        <button
          type="button"
          className={`tap-tempo${flash ? ' on' : ''}`}
          title={tapCopy.hint}
          aria-label={`${tapCopy.label}. ${tapCopy.hint}`}
          disabled={store.remoteFollow}
          onKeyDown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
          }}
          onPointerDown={(event) => {
            if (event.button !== 0 || store.remoteFollow) return
            event.preventDefault()
            try {
              event.currentTarget.setPointerCapture(event.pointerId)
            } catch {
              /* The pointer can already be gone. */
            }
            pulse()
            applyTap(performance.now(), 'pointer')
          }}
          onPointerUp={() => {
            memory.current = noteTapRelease(memory.current, performance.now())
          }}
          onPointerCancel={() => {
            memory.current = noteTapRelease(memory.current, performance.now())
          }}
          onClick={() => {
            const result = applyTap(performance.now(), 'click')
            if (result && !result.ignored) pulse()
          }}
        >
          Tap
        </button>
      </div>
      <div className="loop-cluster">
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
            <span className="t-word">Loop</span>
          </TipButton>
        )}
        <span
          className={`loop-readout${project.loopEnabled ? '' : ' off'}`}
          data-loop-readout="transport"
          data-loop-length={loopRead.length}
          data-loop-span={loopRead.span}
          title={loopRead.text}
        >
          <span className="loop-len">{loopRead.length}</span>
          <span className="loop-span">{loopRead.span}</span>
        </span>
        <button
          type="button"
          className={`loop-fine${fine ? ' on' : ''}`}
          aria-pressed={fine}
          title="Drag the loop without snapping to the grid. Hold Alt for the same thing."
          onClick={() => setLoopFineSnap(!fine)}
        >
          Fine
        </button>
      </div>
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

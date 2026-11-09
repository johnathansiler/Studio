import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { AnchoredMenu } from './AnchoredMenu'
import type { AudioEngine } from '../audio/engine'
import { formatLoopReadout } from '../model/loopEdit'
import { emptyTap, formatTempo, noteTapRelease, pushTap, roundTempo, shouldOpenExactTempo, type TapMemory, type TapSource } from '../model/tap'
import { tempoDragIntent, tempoFromDrag } from '../model/tempoDrag'
import { formatMapBars } from '../model/tempoMap'
import { countInBarsOf, countInCaption, formatTimecode } from '../model/time'
import { recordButtonOn } from '../model/transport'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { AssetStatus } from '../remote/assets'
import type { SessionClient } from '../remote/session'
import { RecordBar } from './RecordBar'
import { AutomationFollow } from './AutomationLane'
import { AssetTransfers } from './AssetTransfers'
import { TRANSPORT_COPY, copyOf } from './chrome'
import { TipButton } from './Hint'
import './loopRegion.css'
import './remoteFixes.css'

export function TransportBar({
  store,
  engine,
  syncLabel,
  onPlay,
  onStop,
  onRecord,
  onSeek,
  onReset,
  onQuickPunch,
  onMidi,
  session,
  roomRole,
  simple = false,
  takeProgress = null,
  recordHint = '',
  assetTransfers = [],
}: {
  store: ProjectStore
  engine: AudioEngine
  syncLabel?: string
  onPlay: () => void
  onStop: () => void
  onRecord: () => void
  onSeek: (sample: number) => void
  onReset?: () => void
  onQuickPunch?: () => void
  onMidi?: () => void
  session?: SessionClient
  /** Solo and host can reset. A guest sees a disabled Host only control. */
  roomRole?: 'host' | 'guest'
  /** Phone uses the same transport controls, with text labels. */
  simple?: boolean
  /** 0–1 while a full-quality guest take is moving to the host. */
  takeProgress?: number | null
  recordHint?: string
  /** Shared wavs moving on a direct peer connection. */
  assetTransfers?: AssetStatus[]
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
  const drag = useRef<{
    id: number
    x: number
    y: number
    at: number
    origin: number
    mode: 'pending' | 'drag' | 'ignore'
    tap: boolean
    stopScroll: (() => void) | null
  } | null>(null)
  const suppressFocus = useRef(false)
  const tapping = useRef(false)
  const flashTimer = useRef(0)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    const close = () => setMenuOpen(false)
    document.addEventListener('cueharbor-close-transport-menu', close)
    return () => document.removeEventListener('cueharbor-close-transport-menu', close)
  }, [])
  const menuButton = useRef<HTMLButtonElement>(null)
  const [editingTempo, setEditingTempo] = useState(false)
  const editTimer = useRef(0)
  const tempoWrap = useRef<HTMLDivElement>(null)
  const tempo = live ?? project.tempo
  const tempoCopy = copyOf(TRANSPORT_COPY, 'tempo')

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
    window.clearTimeout(editTimer.current)
    drag.current?.stopScroll?.()
    delete document.documentElement.dataset.tempoDrag
    store.endTempoGroup()
  }, [store])

  useEffect(() => {
    if (!editingTempo) return
    const node = fieldRef.current
    node?.focus()
    node?.select()
  }, [editingTempo])

  useEffect(() => {
    const node = tempoWrap.current
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

  function endTempoScroll(state: { stopScroll: (() => void) | null } | null) {
    state?.stopScroll?.()
    if (state) state.stopScroll = null
    delete document.documentElement.dataset.tempoDrag
  }

  function onTempoDown(event: ReactPointerEvent, tap: boolean) {
    if (store.remoteFollow || event.button !== 0) return
    endTempoScroll(drag.current)
    const node = event.currentTarget
    const pointerId = event.pointerId
    const state = {
      id: pointerId,
      x: event.clientX,
      y: event.clientY,
      at: performance.now(),
      origin: typedBase() ?? shown.current,
      mode: 'pending' as 'pending' | 'drag' | 'ignore',
      tap,
      stopScroll: null as (() => void) | null,
    }
    drag.current = state
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      if (state.mode === 'ignore' || store.remoteFollow) return
      const dx = ev.clientX - state.x
      const dy = state.y - ev.clientY
      if (state.mode === 'pending') {
        const intent = tempoDragIntent(dx, dy)
        if (intent === 'pending') return
        if (intent === 'scroll') {
          state.mode = 'ignore'
          return
        }
        state.mode = 'drag'
        window.clearTimeout(editTimer.current)
        memory.current = emptyTap()
        store.endTempoGroup()
        suppressFocus.current = true
        draftRef.current = null
        setDraft(null)
        try { node.setPointerCapture(pointerId) } catch { /* The pointer can already be gone. */ }
        if (node instanceof HTMLElement) node.blur()
        document.documentElement.dataset.tempoDrag = '1'
        const block = (touch: Event) => { if (touch.cancelable) touch.preventDefault() }
        window.addEventListener('touchmove', block, { passive: false })
        const previous = state.stopScroll
        state.stopScroll = () => {
          previous?.()
          window.removeEventListener('touchmove', block)
        }
      }
      if (ev.cancelable) ev.preventDefault()
      publish(tempoFromDrag(state.origin, dy), true)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (drag.current !== state) return
      drag.current = null
      endTempoScroll(state)
      if (state.mode === 'drag') {
        if (ev.type === 'pointercancel') publish(state.origin, true)
        store.endTempoGroup()
        window.setTimeout(() => { suppressFocus.current = false }, 0)
        return
      }
      if (ev.type === 'pointercancel' || state.mode === 'ignore' || !state.tap) return
      pulse()
      armExactTempo(applyTap(state.at, 'pointer'))
      memory.current = noteTapRelease(memory.current, performance.now())
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    state.stopScroll = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }

  function commitDraft(text: string) {
    if (tapping.current || drag.current?.mode === 'drag' || suppressFocus.current) return
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

  const running = status === 'playing' || status === 'recording' || status === 'counting-in'
  void simple
  const transport = (id: string) => copyOf(TRANSPORT_COPY, id)
  const countBars = countInBarsOf(project)
  const countCaption = countInCaption(countBars)
  const guestRoom = roomRole === 'guest'
  const resetCopy = transport('reset')
  const loopRead = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const inSession = roomRole === 'host' || roomRole === 'guest'
  const menuHint = 'Metronome, loop, reset, playhead, and sounds.'
  function armExactTempo(result: { bpm: number | null; ignored: boolean } | null) {
    window.clearTimeout(editTimer.current)
    if (!shouldOpenExactTempo(result) || store.remoteFollow) return
    editTimer.current = window.setTimeout(() => setEditingTempo(true), 1500)
  }
  const tempoLabel = `${tempoCopy.label}. Tap to set tempo. Drag up or down to change the tempo. ${tempoCopy.hint}`
  const tempoField = editingTempo ? (
        <label className="bpm-readout tempo-edit">
          <span className="tempo-kicker">Tempo</span>
          <input
          ref={fieldRef}
          className="tempo-figure"
          type="number"
          inputMode="decimal"
          min={30}
          max={300}
          step={0.1}
          title={tempoCopy.hint}
          aria-label={`${tempoCopy.label}. Type an exact tempo.`}
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
          onBlur={(event) => {
            commitDraft(event.currentTarget.value)
            setEditingTempo(false)
          }}
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
          onPointerDown={(event) => onTempoDown(event, false)}
        />
        </label>
  ) : (
        <button
          type="button"
          className={`bpm-readout tempo-tap${flash ? ' flash' : ''}`}
          title="Tap to set tempo. Drag up or down to change it. Pause after one tap to type an exact tempo."
          aria-label={tempoLabel}
          disabled={store.remoteFollow}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
            event.preventDefault()
            const delta = (event.shiftKey ? 1 : 0.1) * (event.key === 'ArrowUp' ? 1 : -1)
            bump(delta)
          }}
          onPointerDown={(event) => onTempoDown(event, true)}
        >
          <span className="tempo-kicker">Tempo</span>
          <span className="tempo-figure">{formatTempo(tempo)}</span>
        </button>
  )
  const loopWord = project.loopEnabled ? `Loop ${loopRead.length}` : 'Loop'
  const loopControl = (
    <button
      type="button"
      className={`t-btn loop${project.loopEnabled ? ' on' : ''}`}
      data-loop-readout="transport"
      data-loop-length={loopRead.length}
      data-loop-span={loopRead.span}
      title={`${transport('loop').hint} ${loopRead.text}`}
      aria-label={`${loopWord}. ${transport('loop').hint}`}
      aria-pressed={project.loopEnabled}
      disabled={store.remoteFollow}
      onClick={() => store.toggle('loopEnabled')}
    >
      <span className="t-word">{loopWord}</span>
    </button>
  )
  const clickButton = (
        <TipButton
          id="transport-click"
          className={`t-btn click${project.metronomeEnabled ? ' on' : ''}`}
          label="Metronome"
          hint={transport('click').hint}
          pressed={project.metronomeEnabled}
          disabled={store.remoteFollow}
          onClick={() => store.toggle('metronomeEnabled')}
        >
          <span className="t-word">Metronome</span>
          <span className="t-state">{project.metronomeEnabled ? 'On' : 'Off'}</span>
        </TipButton>
  )
  const countButton = (
        <TipButton
          id="transport-count"
          className={`t-btn count${countBars > 0 ? ' on' : ''}`}
          label={transport('count-in').label}
          hint={`${transport('count-in').hint} Now ${countCaption}.`}
          pressed={countBars > 0}
          disabled={store.remoteFollow}
          onClick={() => store.cycleCountIn()}
        >
          <span className="t-word">Count</span>
          <span className="t-state">{countCaption}</span>
        </TipButton>
  )
  const resetButton = (
        <TipButton
          id="transport-reset"
          className="t-btn reset"
          label={guestRoom ? 'Host only' : resetCopy.label}
          hint={guestRoom ? 'Host only' : resetCopy.hint}
          disabled={guestRoom}
          onClick={() => onReset?.()}
        >
          <span className="t-word">{guestRoom ? 'Host only' : 'Reset'}</span>
        </TipButton>
  )
  const positionReadout = (
      <div className="lcd" aria-live="polite" aria-label="Position">
        <div className="bars">{formatMapBars(project, position)}</div>
        <div className="tc">
          {formatTimecode(position, project.sampleRate)} · {status}
          {takeProgress != null ? ` · HQ ${Math.round(takeProgress * 100)}%` : ''}
        </div>
      </div>
  )
  return (
    <div className="transport simple">
      <AutomationFollow store={store} engine={engine} />
      {inSession && syncLabel ? <span className="sync-pill">{syncLabel}</span> : null}
      <div className="t-main btn-tray">
        <TipButton className="t-btn" label={transport('to-start').label} hint={transport('to-start').hint} onClick={() => onSeek(0)}>
          <span className="t-word">Start</span>
        </TipButton>
        <TipButton
          className={`t-btn play${running ? ' on' : ''}`}
          label={running ? transport('stop').label : transport('play').label}
          hint={running ? transport('stop').hint : transport('play').hint}
          pressed={running}
          onPress={() => engine.unlock()}
          onClick={running ? onStop : onPlay}
        >
          <span className="t-word">{running ? 'Stop' : 'Play'}</span>
        </TipButton>
        <TipButton className={`t-btn rec ${recordButtonOn(status) ? 'on' : ''}`} label={transport('record').label} hint={transport('record').hint} pressed={recordButtonOn(status)} onPress={() => engine.unlock()} onClick={onRecord}>
          <span className="t-word">Record</span>
        </TipButton>
        <RecordBar
          dock
          store={store}
          engine={engine}
          session={session ?? ({ state: { participants: [], selfId: 'local' } } as unknown as SessionClient)}
          onQuickPunch={onQuickPunch ?? (() => undefined)}
          onMidi={onMidi}
        />
        <div className="tempo-cluster" role="group" aria-label="Tempo" ref={tempoWrap}>{tempoField}</div>
        <button
          ref={menuButton}
          type="button"
          className={`t-btn menu${menuOpen ? ' on' : ''}`}
          aria-expanded={menuOpen}
          aria-controls="transport-menu"
          title={menuHint}
          aria-label={`More. ${menuHint}`}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span className="t-word">More</span>
        </button>
      </div>
      <AnchoredMenu
        id="transport-menu"
        className="transport-drawer"
        fill
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        label="More"
        triggerRef={menuButton}
        prefer="down"
      >
        {loopControl}
        <div className="metro-combo" role="group" aria-label="Metronome">
          {clickButton}
          {countButton}
        </div>
        {resetButton}
        {positionReadout}
        <div id="transport-menu-extra" className="transport-menu-extra" />
      </AnchoredMenu>
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
      {recordHint && <p className="rec-hint" role="status">{recordHint}</p>}
      <AssetTransfers rows={assetTransfers} />
    </div>
  )
}



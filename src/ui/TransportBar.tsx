import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { AudioEngine } from '../audio/engine'
import { emptyTap, formatTempo, noteTapRelease, pushTap, roundTempo, shouldOpenExactTempo, type TapMemory, type TapSource } from '../model/tap'
import { dragNumeric } from '../model/dragNumeric'
import { tempoDragIntent, tempoFromDrag } from '../model/tempoDrag'
import { projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { quartersPerBar } from '../model/time'
import { recordButtonOn } from '../model/transport'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { AssetStatus } from '../remote/assets'
import type { SessionClient } from '../remote/session'
import { AutomationFollow } from './AutomationLane'
import { AssetTransfers } from './AssetTransfers'
import { TRANSPORT_COPY, copyOf } from './chrome'
import { ButtonTray } from './ButtonTray'
import { DeleteTrackConfirm, applyTrackDelete, arrangeEditTarget, eqCols } from './equalGrid'
import { TipButton } from './Hint'
import { armFinePress, markIntegerLand } from './integerTick'
import './loopRegion.css'
import './remoteFixes.css'

function shiftBars(project: { tempo: number; tempoMap?: { beat: number; bpm: number }[]; automation?: unknown[]; sampleRate: number; timeSignature: { numerator: number; denominator: number } }, samples: number, bars: number) {
  const beat = projectSampleBeat(project as never, Math.max(0, samples))
  const next = Math.max(0, beat + bars * quartersPerBar(project.timeSignature))
  return Math.max(0, Math.round(projectBeatSample(project as never, next)))
}

export function IdeasBulbIcon() {
  return (
    <svg className="ideas-bulb-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path className="ideas-rays" d="M12 1.4v1.6M4.4 5.2l1.1 1.1M19.6 5.2l-1.1 1.1M2.2 12H3.8M20.2 12h1.6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M9 18h6M10 21h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M12 3.2a5.6 5.6 0 0 0-3 10.3c.5.4.8 1 .8 1.6V17h4.4v-1.9c0-.6.3-1.2.8-1.6A5.6 5.6 0 0 0 12 3.2z" fill="currentColor" fillOpacity="0.22" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

export function ResetIcon() {
  return (
    <svg className="t-mark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path d="M4.2 9a4.8 4.8 0 1 0 1.4-3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <path d="M4 3.1v3.4h3.4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DeleteIcon() {
  return (
    <svg className="t-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.2 4.2h9.6M6.2 4.1V3h3.6v1.1M4.4 4.2l.6 8.2h5.9l.6-8.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function DuplicateIcon() {
  return (
    <svg className="t-ico" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="5.2" y="5.2" width="7.2" height="7.2" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10.6 5.2V3.6A1.4 1.4 0 0 0 9.2 2.2H3.6A1.4 1.4 0 0 0 2.2 3.6v5.6A1.4 1.4 0 0 0 3.6 10.6H5.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  )
}

/** Phone transport marks. One 18px drawing, no word. */
function TransportGlyph({ id }: { id: 'start' | 'rewind' | 'forward' | 'play' | 'stop' | 'record' }) {
  return (
    <svg className="t-icon" data-transport-icon={id} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {id === 'start' && (
        <g>
          <path d="M3.15 3.1v11.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M14.9 3.4 6 9l8.9 5.6V3.4z" fill="currentColor" />
        </g>
      )}
      {id === 'rewind' && <path d="M8.5 3.5 2.2 9l6.3 5.5V3.5zm7.3 0L9.5 9l6.3 5.5V3.5z" fill="currentColor" />}
      {id === 'forward' && <path d="M2.2 3.5 8.5 9 2.2 14.5V3.5zm7.3 0L15.8 9l-6.3 5.5V3.5z" fill="currentColor" />}
      {id === 'play' && <path d="M4.3 3.1v11.8L14.6 9 4.3 3.1z" fill="currentColor" />}
      {id === 'stop' && <rect x="4" y="4" width="10" height="10" rx="1.3" fill="currentColor" />}
      {id === 'record' && <circle cx="9" cy="9" r="5.1" fill="currentColor" />}
    </svg>
  )
}

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
  onIdeas,
  bulbOn = false,
  session,
  roomRole,
  simple = false,
  phone = false,
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
  onIdeas?: () => void
  bulbOn?: boolean
  session?: SessionClient
  /** Solo and host can reset. A guest sees a disabled Host only control. */
  roomRole?: 'host' | 'guest'
  /** Phone uses the same transport controls, with text labels. */
  simple?: boolean
  /** Phone metronome is the dock icon. The word Click stays off that transport. */
  phone?: boolean
  /** 0–1 while a full-quality guest take is moving to the host. */
  takeProgress?: number | null
  recordHint?: string
  /** Shared wavs moving on a direct peer connection. */
  assetTransfers?: AssetStatus[]
}) {
  const project = selectTransport(store).project
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
  const [editingTempo, setEditingTempo] = useState(false)
  const editTimer = useRef(0)
  const tempoWrap = useRef<HTMLDivElement>(null)
  const tempo = live ?? project.tempo
  const tempoCopy = copyOf(TRANSPORT_COPY, 'tempo')

  useEffect(
    () =>
      engine.subscribe(() => {
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
      const fine = event.shiftKey
      const current = shown.current
      const deltaPx = (event.deltaY < 0 ? 1 : -1) * (fine ? 4 : 10)
      const next = dragNumeric({ origin: current, deltaPx, min: 30, max: 300, fine, release: !fine })
      markIntegerLand(node, current, next)
      memory.current = emptyTap()
      publish(next, true)
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
      fine: false,
      applied: false,
      stopScroll: null as (() => void) | null,
      cancelFine: (() => undefined) as () => void,
    }
    drag.current = state
    state.cancelFine = armFinePress(event.pointerType, () => {
      if (drag.current !== state || state.mode === 'ignore') return
      state.fine = true
      state.origin = shown.current
      state.y = event.clientY
    })
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
          state.cancelFine()
          return
        }
        state.cancelFine()
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
      const fine = ev.shiftKey || state.fine
      if (fine !== state.applied) {
        state.applied = fine
        state.origin = shown.current
        state.y = ev.clientY
      }
      if (ev.cancelable) ev.preventDefault()
      const before = shown.current
      const next = tempoFromDrag(state.origin, state.y - ev.clientY, undefined, fine)
      publish(next, true)
      markIntegerLand(node, before, next)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      state.cancelFine()
      if (drag.current !== state) return
      drag.current = null
      endTempoScroll(state)
      if (state.mode === 'drag') {
        if (ev.type === 'pointercancel') publish(state.origin, true)
        else {
          const fine = ev.shiftKey || state.fine
          const before = shown.current
          const next = tempoFromDrag(state.origin, state.y - ev.clientY, undefined, fine, true)
          publish(next, true)
          markIntegerLand(node, before, next)
        }
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
  const inSession = roomRole === 'host' || roomRole === 'guest'
  void onReset
  void onQuickPunch
  void onMidi
  void session
  function armExactTempo(result: { bpm: number | null; ignored: boolean } | null) {
    window.clearTimeout(editTimer.current)
    if (!shouldOpenExactTempo(result) || store.remoteFollow) return
    editTimer.current = window.setTimeout(() => setEditingTempo(true), 1500)
  }
  const tempoLabel = `${tempoCopy.label}. Tap to set tempo. Drag up or down to change the tempo. ${tempoCopy.hint}`
  const tempoField = editingTempo ? (
        <label className="t-btn bpm-readout tempo-edit">
          <span className="tempo-kicker">{phone ? 'Tap' : 'Tempo'}</span>
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
          className={`t-btn bpm-readout tempo-tap${flash ? ' flash' : ''}`}
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
          <span className="tempo-kicker">{phone ? 'Tap' : 'Tempo'}</span>
          <span className="tempo-figure">{formatTempo(tempo)}</span>
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
          <span className="t-word">Click</span>
        </TipButton>
  )
  const countButton = (
        <TipButton
          id="transport-count"
          className={`t-btn count${project.countIn ? ' on' : ''}`}
          label="Count-in"
          hint={transport('count-in').hint}
          pressed={project.countIn}
          disabled={store.remoteFollow}
          onClick={() => store.toggle('countIn')}
        >
          <span className="t-word">1-2</span>
        </TipButton>
  )
  const editTarget = arrangeEditTarget(store)
  const [trackDelete, setTrackDelete] = useState<{ id: string; name: string } | null>(null)
  const editDisabled = editTarget.kind === 'none' || store.remoteFollow
  function runDelete() {
    if (editTarget.kind === 'clip') {
      store.deleteArrangeClips()
      return
    }
    if (editTarget.kind === 'track') setTrackDelete({ id: editTarget.id, name: editTarget.name })
  }
  function runDuplicate() {
    if (editTarget.kind === 'clip') store.duplicateArrangeClips()
    else if (editTarget.kind === 'track') store.duplicateTrack(editTarget.id)
  }
  const deleteButton = (
        <TipButton
          id="transport-delete"
          className="t-btn delete"
          label="Delete"
          hint={editTarget.kind === 'clip' ? 'Remove the selected clip.' : editTarget.kind === 'track' ? `Delete track "${editTarget.name}".` : 'Select a clip or a track.'}
          disabled={editDisabled}
          onClick={runDelete}
        >
          <DeleteIcon />
          <span className="t-word">Delete</span>
        </TipButton>
  )
  const duplicateButton = (
        <TipButton
          id="transport-duplicate"
          className="t-btn duplicate"
          label="Duplicate"
          hint={editTarget.kind === 'clip' ? 'Copy the selected clip and place it just after.' : editTarget.kind === 'track' ? 'Copy this track onto the lane below.' : 'Select a clip or a track.'}
          disabled={editDisabled}
          onClick={runDuplicate}
        >
          <DuplicateIcon />
          <span className="t-word">Duplicate</span>
        </TipButton>
  )
  const [extrasHost, setExtrasHost] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const pick = () => {
      const node = document.getElementById('transport-extras')
      setExtrasHost(node instanceof HTMLElement ? node : null)
    }
    pick()
    const observer = new MutationObserver(pick)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  function nudge(bars: number) {
    const at = typeof engine.currentTimelineSample === 'function' ? engine.currentTimelineSample() : engine.positionSamples
    onSeek(shiftBars(project, at, bars))
  }
  const extras = (
    <div className="transport-extras eq-grid" style={eqCols(phone ? 3 : 5)} role="group" aria-label="Delete, tempo, and duplicate">
      {deleteButton}
      <div className="tempo-cluster" role="group" aria-label="Tempo" ref={tempoWrap}>{tempoField}</div>
      {phone ? null : clickButton}
      {phone ? null : countButton}
      {duplicateButton}
    </div>
  )
  return (
    <div className="transport simple">
      <AutomationFollow store={store} engine={engine} />
      {inSession && syncLabel ? <span className="sync-pill">{syncLabel}</span> : null}
      <ButtonTray className="t-main">
        <TipButton className="t-btn" label="Go to Start" hint={transport('to-start').hint} onClick={() => onSeek(0)}>
          {phone ? <TransportGlyph id="start" /> : <span className="t-word">Start</span>}
        </TipButton>
        <TipButton className="t-btn" label="Rewind" hint="Jump the playhead back one bar." onClick={() => nudge(-1)}>
          {phone ? <TransportGlyph id="rewind" /> : <span className="t-word">Rewind</span>}
        </TipButton>
        <TipButton className="t-btn" label="Fast Forward" hint="Jump the playhead forward one bar." onClick={() => nudge(1)}>
          {phone ? <TransportGlyph id="forward" /> : <span className="t-word">Forward</span>}
        </TipButton>
        <TipButton
          className={`t-btn play${running ? ' on' : ''}`}
          label={running ? transport('stop').label : transport('play').label}
          hint={running ? transport('stop').hint : transport('play').hint}
          pressed={running}
          onPress={() => engine.unlock()}
          onClick={running ? onStop : onPlay}
        >
          {phone ? <TransportGlyph id={running ? 'stop' : 'play'} /> : <span className="t-word">{running ? 'Stop' : 'Play'}</span>}
        </TipButton>
        <TipButton className={`t-btn rec ${recordButtonOn(status) ? 'on' : ''}`} label={transport('record').label} hint={transport('record').hint} pressed={recordButtonOn(status)} onPress={() => engine.unlock()} onClick={onRecord}>
          {phone ? <TransportGlyph id="record" /> : <span className="t-word">Record</span>}
        </TipButton>
        <button
          type="button"
          className={`t-btn ideas-bulb${bulbOn ? ' on' : ''}`}
          aria-label="Ideas"
          title="Ideas"
          aria-pressed={bulbOn}
          disabled={!onIdeas || store.remoteFollow}
          onClick={() => onIdeas?.()}
        >
          <IdeasBulbIcon />
        </button>
      </ButtonTray>
      {extrasHost ? createPortal(extras, extrasHost) : extras}
      {trackDelete ? createPortal(
        <DeleteTrackConfirm
          name={trackDelete.name}
          onChoose={(choice) => {
            applyTrackDelete(store, trackDelete.id, choice)
            setTrackDelete(null)
          }}
        />,
        document.body,
      ) : null}
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



import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { formatLoopReadout } from '../model/loopEdit'
import { emptyTap, formatTempo, noteTapRelease, pushTap, roundTempo, type TapMemory, type TapSource } from '../model/tap'
import { formatMapBars, projectBeatSample, projectSampleBeat } from '../model/tempoMap'
import { countInBarsOf, countInCaption, formatTimecode, quartersPerBar } from '../model/time'
import { recordButtonOn } from '../model/transport'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { AssetStatus } from '../remote/assets'
import { AutomationFollow } from './AutomationLane'
import { AssetTransfers } from './AssetTransfers'
import { TRANSPORT_COPY, copyOf } from './chrome'
import { KeyboardToggle } from './KeyboardDock'
import { TipButton } from './Hint'
import './loopRegion.css'
import './remoteFixes.css'

const LOOP_CHOICES = [1, 2, 4, 8] as const

function loopMatchesBars(project: ProjectStore['project'], bars: number) {
  const span = projectSampleBeat(project, project.loopEndSample) - projectSampleBeat(project, project.loopStartSample)
  return Math.abs(span - bars * quartersPerBar(project.timeSignature)) < 0.02
}

function applyLoopBars(store: ProjectStore, bars: number) {
  const project = store.project
  const startBeat = projectSampleBeat(project, project.loopStartSample)
  const end = projectBeatSample(project, startBeat + bars * quartersPerBar(project.timeSignature))
  store.setLoop(project.loopEnabled, project.loopStartSample, end)
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
  const drag = useRef<{ y: number; origin: number; moved: boolean } | null>(null)
  const suppressFocus = useRef(false)
  const tapping = useRef(false)
  const flashTimer = useRef(0)
  const [moreOpen, setMoreOpen] = useState(false)
  const [lengthOpen, setLengthOpen] = useState(false)
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

  const playing = status === 'playing'
  const running = status === 'playing' || status === 'recording' || status === 'counting-in'
  const transport = (id: string) => copyOf(TRANSPORT_COPY, id)
  const countBars = countInBarsOf(project)
  const countCaption = countInCaption(countBars)
  const guestRoom = roomRole === 'guest'
  const resetCopy = transport('reset')
  const loopRead = formatLoopReadout(project, project.loopStartSample, project.loopEndSample)
  const inSession = roomRole === 'host' || roomRole === 'guest'
  const moreHint = 'Metronome, tap tempo, loop, reset, on-screen piano, playhead, and sounds.'
  const tempoField = (
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
  )
  const tapButton = (
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
  )
  const loopControl = (
    <>
      <div className={`loop-combo${project.loopEnabled ? ' on' : ''}`} role="group" aria-label="Loop">
        <button
          type="button"
          className={`t-btn loop${project.loopEnabled ? ' on' : ''}`}
          data-loop-readout="transport"
          data-loop-length={loopRead.length}
          data-loop-span={loopRead.span}
          title={`${transport('loop').hint} ${loopRead.text}`}
          aria-label={`Loop ${loopRead.length}. ${transport('loop').hint}`}
          aria-pressed={project.loopEnabled}
          disabled={store.remoteFollow}
          onClick={() => store.toggle('loopEnabled')}
        >
          <span className="t-word">Loop {loopRead.length}</span>
        </button>
        <button
          type="button"
          className={`t-btn loop-length${lengthOpen ? ' on' : ''}`}
          aria-expanded={lengthOpen}
          aria-controls="loop-length-choices"
          title="Choose 1, 2, 4, or 8 bars. The loop stays where it is."
          aria-label="Loop length. Choose 1, 2, 4, or 8 bars."
          disabled={store.remoteFollow}
          onClick={() => setLengthOpen((open) => !open)}
        >
          <span className="t-word">Length</span>
        </button>
      </div>
      {lengthOpen && (
        <div id="loop-length-choices" className="inline-choices loop-lengths" role="group" aria-label="Loop length">
          {LOOP_CHOICES.map((bars) => {
            const chosen = loopMatchesBars(project, bars)
            const label = bars === 1 ? '1 bar' : `${bars} bars`
            return (
              <button
                key={bars}
                type="button"
                className={chosen ? 'on' : ''}
                aria-pressed={chosen}
                title={`Set the loop to ${label}.`}
                onClick={() => applyLoopBars(store, bars)}
              >
                {label}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
  const clickButton = (
        <TipButton
          id="transport-click"
          className={`t-btn click${project.metronomeEnabled ? ' on' : ''}`}
          label={simple ? 'Metronome' : transport('click').label}
          hint={transport('click').hint}
          pressed={project.metronomeEnabled}
          disabled={store.remoteFollow}
          onClick={() => store.toggle('metronomeEnabled')}
        >
          <span className="t-word">{simple ? 'Metronome' : 'Click'}</span>
          {simple && <span className="t-state">{project.metronomeEnabled ? 'On' : 'Off'}</span>}
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
    <div className={`transport${simple ? ' simple' : ''}`}>
      <AutomationFollow store={store} engine={engine} />
      {inSession && syncLabel ? <span className="sync-pill">{syncLabel}</span> : null}
      {simple ? (
        <>
          <div className="t-main">
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
            {tempoField}
            <button
              type="button"
              className={`t-btn more${moreOpen ? ' on' : ''}`}
              aria-expanded={moreOpen}
              aria-controls="transport-more"
              title={moreHint}
              aria-label={`More. ${moreHint}`}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <span className="t-word">More</span>
            </button>
          </div>
          <div id="transport-more" className="transport-drawer" hidden={!moreOpen} data-open={moreOpen ? 'true' : 'false'}>
            {loopControl}
            <div className="metro-combo" role="group" aria-label="Metronome">
              {clickButton}
              {countButton}
            </div>
            {tapButton}
            {resetButton}
            <KeyboardToggle store={store} engine={engine} word="On-screen Piano" hint="Show or hide the on-screen piano. Play notes on the keys." />
            {positionReadout}
            <div id="transport-more-extra" className="transport-more-extra" />
          </div>
        </>
      ) : (
      <>
      <div className="t-buttons">
        <TipButton className="t-btn" label={transport('to-start').label} hint={transport('to-start').hint} onClick={() => onSeek(0)}>
          <span className="t-word">Start</span>
        </TipButton>
        <TipButton className={`t-btn play ${playing ? 'on' : ''}`} label={playing ? transport('pause').label : transport('play').label} hint={playing ? transport('pause').hint : transport('play').hint} pressed={playing} onPress={() => engine.unlock()} onClick={onPlay}>
          <span className="t-word">{playing ? 'Pause' : 'Play'}</span>
        </TipButton>
        <TipButton className="t-btn stop" label={transport('stop').label} hint={transport('stop').hint} onClick={onStop}>
          <span className="t-word">Stop</span>
        </TipButton>
        <TipButton className={`t-btn rec ${recordButtonOn(status) ? 'on' : ''}`} label={transport('record').label} hint={transport('record').hint} pressed={recordButtonOn(status)} onPress={() => engine.unlock()} onClick={onRecord}>
          <span className="t-word">Rec</span>
        </TipButton>
        {clickButton}
        {countButton}
        {resetButton}
        <KeyboardToggle store={store} engine={engine} />
      </div>
      {positionReadout}
      <div className="tempo-cluster" role="group" aria-label="Tempo">
        {tempoField}
        {tapButton}
      </div>
      {loopControl}
      </>
      )}
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



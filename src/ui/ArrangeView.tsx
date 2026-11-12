import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react'
import { useScreenOverlay } from './screenOverlay'
import { browserWidthFor, usePushPhase } from './dockPush'
import { createPortal } from 'react-dom'
import type { AudioEngine } from '../audio/engine'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { activeComp } from '../model/comp'
import { clipPlayRatio, snapClipTimeline } from '../audio/clipSnap'
import { sourceSamplesOf, stretchEdge } from '../audio/stretch/engine'
import { trimAudioClip } from '../model/clips'
import { rectsHit } from '../model/edit'
import { SCALER_MIME, parseScalerDrag } from '../instruments/scaler/model'
import { patternHostId } from '../model/steps'
import { loopGridBeats } from '../model/loopEdit'
import { gridBackground, gridPaint } from '../model/gridLines'
import { activeGridBeats, edgeFromPointer, lengthReadout, moveFromPointer, positionReadout, subdivisionFor } from '../model/snapGrid'
import { quartersPerBar } from '../model/time'
import { editorForGesture, hasStepSequencer } from '../model/editorOpen'
import { showsOnscreenPiano } from '../model/onscreenPiano'
import { showsOpenBeatMachine } from '../instruments/pads/identity'
import { holdMeter } from './levels'
import { patternToMidiNotes } from '../model/patternMidi'
import { panelChoice, rememberPanel } from './panelMemory'
import { arrangementEndSample, gridMarks, mapIsLinear, projectBeatSample, projectSampleBeat, pxAtBeat, snapSampleToMap } from '../model/tempoMap'
import { displayedPlayhead } from '../model/transportSync'
import { SongMap, SongMapHead, SmartTempoBar } from './SongMap'
import type { AudioClip } from '../model/types'
import { ClipSheet } from './ClipSheet'
import { selectArrange } from '../state/select'
import type { ProjectStore } from '../state/store'
import { activeTool, EDITOR_TOOL_KEYS, subscribeTools, toolClaimsGesture } from '../state/tools'
import { StemSheet } from './StemSheet'
import type { SessionClient } from '../remote/session'
import { PlaylistBrowser, type BrowserTab } from './PlaylistBrowser'
import { readBrowsePlace, writeBrowsePlace } from './browsePlace'
import { AutomationOverlay, LanePicker, MixFlags } from './AutomationLane'
import { AutoTuneLaneMark } from './AutoTuneFace'
import { AddTrackButton } from './AddTrack'
import { OpenBeatMachineButton } from './BeatMachineButton'
import { KeyboardToggle } from './KeyboardDock'
import type { TrackChoice } from '../model/addTrack'
import { ArrangeBottomSheet } from './ArrangeBottomSheet'
import { UtilitySheets } from './UtilitySheets'
import { TrackOptions, trackKindLabel } from './TrackOptions'
import { ARRANGE_SHEET_EVENT, popSheetHistory, publishArrangeSheet, rememberSheetHistory, sheetHistoryKey, type UtilitySheet } from './arrangePanel'
import { BROWSER_TAB_EVENT, CLOSE_ARRANGE_SHEETS } from './phoneContext'
import { setPhoneFocus } from './phoneFocus'
import { PluginsDrawer } from './PluginsDrawer'
import { TRACK_ROW, copyOf } from './chrome'
import { useFormFactor } from './form'
import './guideSheet.css'
import { TipButton } from './Hint'
import { AnchoredMenu } from './AnchoredMenu'
import { RemoteTimeline, TrackPresence, remoteClipMark, useRemotePeers } from './presenceMarks'
import { coarsePointer, patternHoldOpensMenu, patternMenuPoint, patternPointerIntent, trimZone } from './touchEdit'
import { clipReleaseAction, clipTapAction, laneDoubleClickAddsClip } from './clipKeys'
import { arrangeOutline } from '../audio/wave/render'
import { LoopRegion } from './LoopRegion'
import { TimelineOverview } from './OverviewScrollbar'
import { laneScaleAttr, clampTimelinePx } from './overviewScroll'
import { WaveformView } from './WaveformView'
import { sampleAtX, type WaveSpan } from './waveZoom'
import { CommentControl, CommentPins } from './timelineComments'
import { TrackViewfinder } from './TrackViewfinder'


function ArrangeChrome({ browserOpen, setupOpen, pluginsOpen, onBrowser, onSetup, onPlugins, setupButton, menu, showPlugins = true }: { browserOpen: boolean; setupOpen: boolean; pluginsOpen: boolean; onBrowser: () => void; onSetup: () => void; onPlugins: () => void; setupButton: RefObject<HTMLButtonElement | null>; menu?: ReactNode; showPlugins?: boolean }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const pick = () => {
      const actions = document.querySelector('.command-strip .clip-actions')
      setHost((actions instanceof HTMLElement ? actions : null) || document.getElementById('command-strip') || document.getElementById('tool-slot'))
    }
    pick()
    const observer = new MutationObserver(pick)
    observer.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', pick)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', pick)
    }
  }, [])
  const buttons = (
    <div className="arrange-panels">
      {menu}
      <button
        type="button"
        className={`cap-btn${browserOpen ? ' on' : ''}`}
        aria-pressed={browserOpen}
        title="Sounds and loops. Open sounds, instruments, and loops."
        onClick={onBrowser}
      >
        <strong>Browser</strong>
        <small>Sounds and loops</small>
      </button>
      <button
        ref={setupButton}
        type="button"
        className={`cap-btn${setupOpen ? ' on' : ''}`}
        aria-expanded={setupOpen}
        aria-controls="arrange-setup"
        title="Automation and markers."
        onClick={onSetup}
      >
        <strong>Setup</strong>
        <small>Automation and markers</small>
      </button>
      {showPlugins && (
        <button
          type="button"
          className={`cap-btn${pluginsOpen ? ' on' : ''}`}
          aria-pressed={pluginsOpen}
          aria-expanded={pluginsOpen}
          aria-controls="arrange-plugins"
          data-arrange-plugins="toggle"
          title="Effects on this track."
          onClick={onPlugins}
        >
          <strong>Plugins</strong>
          <small>Effects on this track</small>
        </button>
      )}
    </div>
  )
  if (host) return createPortal(buttons, host)
  return <div className="arrange-setup">{buttons}</div>
}

function TrackTitle({
  name,
  onSelect,
  onRename,
}: {
  name: string
  onSelect: () => void
  onRename: (next: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const skipSave = useRef(false)
  useEffect(() => {
    if (!editing) setDraft(name)
  }, [editing, name])
  if (editing) {
    return (
      <input
        className="track-title"
        aria-label={`Rename ${name}`}
        value={draft}
        autoFocus
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (skipSave.current) {
            skipSave.current = false
            setEditing(false)
            setDraft(name)
            return
          }
          onRename(draft.trim() || name)
          setEditing(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            skipSave.current = true
            setDraft(name)
            event.currentTarget.blur()
          }
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="track-title"
      title={name}
      aria-label={`${name}. Double tap to rename.`}
      onClick={(event) => {
        event.stopPropagation()
        onSelect()
      }}
      onDoubleClick={(event) => {
        event.stopPropagation()
        setDraft(name)
        setEditing(true)
      }}
    >
      {name}
    </button>
  )
}

export function ArrangeView({
  store,
  engine,
  session,
  onSeek,
  onOpenPiano,
  onOpenSteps,
  onOpenKeyboard,
  onImportInstrument,
  onPerform,
  onOpenBeatMachine,
  onTrackAdded,
  onQuickPunch,
  onReset,
  onMidi,
  onAnalyze,
  libraryTab,
  onLibraryClose,
  browserDock,
  onBrowserDock,
  pluginsDrawer,
  pluginsMenu,
  phoneBar,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onSeek: (sample: number) => void
  onOpenPiano: (trackId: string, clipId?: string) => void
  onOpenSteps?: (trackId: string) => void
  onOpenKeyboard?: (trackId: string) => void
  onImportInstrument?: (trackId: string, files: FileList) => void
  onPerform: (mode: 'keys' | 'drums') => void
  onOpenBeatMachine?: (trackId: string) => void
  onTrackAdded?: (id: string, choice: TrackChoice) => void
  onQuickPunch: () => void
  onReset?: () => void
  onMidi?: () => void
  onAnalyze: (trackId: string) => void
  /** Menu asks the Arrange browser to open on this tab. */
  libraryTab?: BrowserTab | null
  onLibraryClose?: () => void
  /** Shared with Mix and Collab so the dock stays open when the view changes. */
  browserDock?: boolean
  onBrowserDock?: (open: boolean) => void
  /** Force the plugins drawer open. Omit to leave it closed until the Plugins button opens it. */
  pluginsDrawer?: boolean
  /** Open the add list with the drawer. */
  pluginsMenu?: boolean
  /** Phone Arrange keeps the Ideas bulb beside Add Track. Undo and Redo live in the dock. */
  phoneBar?: { menu?: ReactNode; history?: ReactNode; ideas?: ReactNode } | null
}) {
  const project = selectArrange(store).project
  const remotes = useRemotePeers()
  const [px, setPx] = useState(90)
  const pxRef = useRef(px)
  pxRef.current = px
  const [position, setPosition] = useState(engine.positionSamples)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [midiOn, setMidiOn] = useState<Record<string, boolean>>({})
  const [nudge, setNudge] = useState<{ audio: Record<string, number>; midi: Record<string, number>; pattern: Record<string, number> } | null>(null)
  const [patternMenu, setPatternMenu] = useState<{ x: number; y: number } | null>(null)
  const form = useFormFactor()
  const [dragView, setDragView] = useState<null | {
    trackId: string
    clipId: string
    rawStart: number
    rawLength: number
    snapLeft: number
    snapWidth: number
    line: number
    label: string
  }>(null)
  const phone = form === 'phone'
  const touch = form !== 'desk'
  const [pluginsOpen, setPluginsOpen] = useState(() => pluginsDrawer === true)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [ghost, setGhost] = useState<{ trackId: string; left: number; width: number } | null>(null)
  const [tool, setToolState] = useState(activeTool)
  const scroller = useRef<HTMLDivElement>(null)
  const secondsRef = useRef(16)
  const [laneZoom, setLaneZoom] = useState(1)
  const laneZoomRef = useRef(laneZoom)
  laneZoomRef.current = laneZoom
  const zoomScroll = useRef<{ left: number | null; top: number | null }>({ left: null, top: null })
  const clampPx = (value: number) => clampTimelinePx(value, scroller.current?.clientWidth ?? 0, secondsRef.current)
  const lastClipTap = useRef({ id: '', at: 0 })
  const headsRef = useRef<HTMLDivElement>(null)
  const finderRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = finderRef.current
    const arrange = node?.closest('.arrange') as HTMLElement | null
    if (!node || !arrange) return
    const apply = () => arrange.style.setProperty('--viewfinder-h', `${Math.round(node.getBoundingClientRect().height)}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    if (!phone) return
    const heads = headsRef.current
    const arrange = heads?.closest('.arrange') as HTMLElement | null
    if (!heads || !arrange) return
    const apply = () => {
      const width = Math.round(heads.getBoundingClientRect().width)
      if (width > 0) arrange.style.setProperty('--track-head-w', `${width}px`)
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(heads)
    return () => observer.disconnect()
  }, [phone, project.tracks.length])
  const innerRef = useRef<HTMLDivElement>(null)
  const coastRef = useRef(0)
  function onTouchpadDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const body = scroller.current
    const heads = headsRef.current
    if (!body) return
    event.preventDefault()
    event.stopPropagation()
    cancelAnimationFrame(coastRef.current)
    const pointerId = event.pointerId
    let x = event.clientX
    let y = event.clientY
    let stamp = performance.now()
    let vx = 0
    let vy = 0
    const apply = (left: number, top: number) => {
      body.scrollLeft = left
      body.scrollTop = top
      if (heads && heads.scrollTop !== body.scrollTop) heads.scrollTop = body.scrollTop
    }
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      const now = performance.now()
      const dx = ev.clientX - x
      const dy = ev.clientY - y
      const dt = Math.max(8, now - stamp)
      vx = dx / dt
      vy = dy / dt
      x = ev.clientX
      y = ev.clientY
      stamp = now
      apply(body.scrollLeft - dx, body.scrollTop - dy)
    }
    const up = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const step = () => {
        vx *= 0.9
        vy *= 0.9
        if (Math.hypot(vx, vy) < 0.02) return
        apply(body.scrollLeft - vx * 16, body.scrollTop - vy * 16)
        coastRef.current = requestAnimationFrame(step)
      }
      coastRef.current = requestAnimationFrame(step)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  useEffect(() => subscribeTools(() => setToolState(activeTool())), [])
  useEffect(() => engine.subscribe(() => setPosition(engine.positionSamples)), [engine])
  useEffect(() => {
    let frame = 0
    const holds: Record<string, { value: number; at: number }> = {}
    let painted: Record<string, number> = {}
    const tick = (now: number) => {
      const next = engine.levels?.()
      if (next) {
        const peaks: Record<string, number> = {}
        let changed = false
        const ids = new Set([...Object.keys(holds), ...Object.keys(next.tracks)])
        for (const id of ids) {
          const hold = holds[id] ?? (holds[id] = { value: 0, at: now })
          const shown = holdMeter(hold, next.tracks[id] ?? 0, now)
          if (shown <= 0) delete holds[id]
          peaks[id] = shown
          if (Math.abs((painted[id] ?? 0) - shown) >= 0.015) changed = true
        }
        if (changed) {
          painted = peaks
          setLevels(peaks)
        }
      }
      const midi = engine.midiActivity?.()
      if (midi) setMidiOn(midi)
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [engine])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const next = EDITOR_TOOL_KEYS[event.key]
      if (next && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault()
        store.setTool(next)
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd' && !event.shiftKey) {
        event.preventDefault()
        store.duplicateSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  useEffect(() => {
    const onZoom = (event: Event) => {
      const factor = (event as CustomEvent<number>).detail
      setPx((value) => clampPx(value * factor))
    }
    window.addEventListener('cueharbor-zoom', onZoom)
    return () => window.removeEventListener('cueharbor-zoom', onZoom)
  }, [])
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const points = new Map<number, { x: number; y: number }>()
    let pinch: { dist: number; px: number; left: number; top: number; x: number; y: number } | null = null
    const pair = () => [...points.values()]
    const down = (event: PointerEvent) => {
      points.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (points.size !== 2) return
      const [a, b] = pair()
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        px: pxRef.current,
        left: el.scrollLeft,
        top: el.scrollTop,
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      }
    }
    const move = (event: PointerEvent) => {
      if (!points.has(event.pointerId)) return
      points.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (!pinch || points.size < 2) return
      event.preventDefault()
      const [a, b] = pair()
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const midX = (a.x + b.x) / 2
      const midY = (a.y + b.y) / 2
      setPx(clampPx(pinch.px * (dist / pinch.dist)))
      el.scrollLeft = pinch.left - (midX - pinch.x)
      el.scrollTop = pinch.top - (midY - pinch.y)
    }
    const up = (event: PointerEvent) => {
      points.delete(event.pointerId)
      if (points.size < 2) pinch = null
    }
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      setPx((value) => clampPx(value * (event.deltaY > 0 ? 0.9 : 1.1)))
    }
    el.addEventListener('pointerdown', down, true)
    el.addEventListener('wheel', wheel, { passive: false })
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      el.removeEventListener('wheel', wheel)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (zoomScroll.current.left != null) {
      el.scrollLeft = zoomScroll.current.left
      zoomScroll.current.left = null
    }
    if (zoomScroll.current.top != null) {
      el.scrollTop = zoomScroll.current.top
      zoomScroll.current.top = null
    }
  }, [px, laneZoom])

  const seconds = Math.max(
    16,
    arrangementEndSample(project) / project.sampleRate + 2,
    (project.loopEndSample / project.sampleRate) * 2,
    ...project.tracks.flatMap((t) => t.clips.map((c) => (c.startSample + c.durationSamples) / project.sampleRate + 2)),
  )
  secondsRef.current = seconds
  const width = seconds * px
  const linear = mapIsLinear(project)
  const beatPx = (60 / project.tempo) * px
  const paint = gridPaint(project, linear ? beatPx : 0)
  const laneGrid = linear ? gridBackground(paint, beatPx) : null
  const marks = gridMarks(project, projectSampleBeat(project, seconds * project.sampleRate) + 1)

  function sampleAt(clientX: number) {
    const inner = innerRef.current
    if (!inner) return 0
    return ((clientX - inner.getBoundingClientRect().left) / pxRef.current) * project.sampleRate
  }

  function laneAt(clientX: number, clientY: number) {
    const stack = document.elementsFromPoint(clientX, clientY)
    for (const node of stack) {
      const lane = node.closest('.lane')
      const id = lane?.getAttribute('data-track')
      if (id) return id
    }
    return null
  }

  function pointAt(clientX: number, clientY: number) {
    const inner = innerRef.current
    if (!inner) return { x: 0, y: 0 }
    const rect = inner.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const passive = tool === 'box' || tool === 'pencil' || tool === 'pan' || tool === 'zoom'

  function watch(move: (event: PointerEvent) => void, up: (event: PointerEvent) => void, capture?: { id: number; node: HTMLElement }) {
    try { capture?.node.setPointerCapture(capture.id) } catch { /* already gone */ }
    let frame = 0
    let last: PointerEvent | null = null
    const onMove = (event: PointerEvent) => {
      last = event
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        if (last) move(last)
      })
    }
    const end = (event: PointerEvent) => {
      if (frame) window.cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      up(event)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  function showEdge(trackId: string, clipId: string, start: number, end: number, rawStart: number, rawEnd: number, edge: 'start' | 'end', label?: string) {
    const pxNow = pxRef.current
    const left = pxAtBeat(project, start, pxNow)
    const right = pxAtBeat(project, end, pxNow)
    const line = edge === 'end' ? right : left
    setDragView({
      trackId,
      clipId,
      rawStart,
      rawLength: Math.max(0.05, rawEnd - rawStart),
      snapLeft: left,
      snapWidth: Math.max(8, right - left),
      line,
      label: label ?? lengthReadout(start, end, quartersPerBar(project.timeSignature)),
    })
  }

  function beginErase(event: ReactPointerEvent) {
    event.stopPropagation()
    event.preventDefault()
    const gone = new Set<string>()
    const drop = (x: number, y: number) => {
      const node = document.elementFromPoint(x, y)?.closest('[data-clip]') as HTMLElement | null
      const id = node?.dataset.clip
      const trackId = node?.dataset.track
      if (!id || !trackId || gone.has(id)) return
      gone.add(id)
      store.selectClip(trackId, id, node.dataset.midi === '1', false, false)
      store.deleteSelectedClip()
    }
    drop(event.clientX, event.clientY)
    watch((ev) => drop(ev.clientX, ev.clientY), () => undefined)
  }

  function onTimelineDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (patternMenu) setPatternMenu(null)
    if (event.button !== 0 && event.pointerType !== 'touch') return
    const current = activeTool()
    const target = event.target as HTMLElement
    if (target.closest('.song-map, .smart-tempo, .map-head')) return
    if (phone && !target.closest('.clip, .ruler, .playhead-strip, .loop-host')) setPhoneFocus('none')
    if (target.closest('.clip') && !passive) return
    if (target.closest('.ruler') && current !== 'pan' && current !== 'zoom') return
    if (toolClaimsGesture(current)) event.preventDefault()
    if (current === 'pan') {
      const el = scroller.current
      if (!el) return
      const originX = event.clientX
      const originY = event.clientY
      const left = el.scrollLeft
      const top = el.scrollTop
      watch(
        (ev) => {
          el.scrollLeft = left - (ev.clientX - originX)
          el.scrollTop = top - (ev.clientY - originY)
        },
        () => undefined,
      )
      return
    }
    if (current === 'zoom') {
      const originX = event.clientX
      const start = pxRef.current
      watch(
        (ev) => setPx(clampPx(start * Math.pow(1.004, ev.clientX - originX))),
        () => undefined,
      )
      return
    }
    if (current === 'box') {
      const origin = pointAt(event.clientX, event.clientY)
      let box = { left: origin.x, top: origin.y, width: 0, height: 0 }
      watch(
        (ev) => {
          const next = pointAt(ev.clientX, ev.clientY)
          box = { left: Math.min(origin.x, next.x), top: Math.min(origin.y, next.y), width: Math.abs(next.x - origin.x), height: Math.abs(next.y - origin.y) }
          setMarquee(box)
        },
        (ev) => {
          setMarquee(null)
          const inner = innerRef.current
          if (!inner) return
          const rect = inner.getBoundingClientRect()
          const end = pointAt(ev.clientX, ev.clientY)
          const hit = {
            left: rect.left + Math.min(origin.x, end.x),
            right: rect.left + Math.max(origin.x, end.x),
            top: rect.top + Math.min(origin.y, end.y),
            bottom: rect.top + Math.max(origin.y, end.y),
          }
          const audio: string[] = []
          const midi: string[] = []
          let trackId: string | null = null
          for (const node of inner.querySelectorAll<HTMLElement>('[data-clip]')) {
            if (!rectsHit(hit, node.getBoundingClientRect())) continue
            const id = node.dataset.clip
            if (!id) continue
            trackId = node.dataset.track || trackId
            if (node.dataset.midi === '1') midi.push(id)
            else audio.push(id)
          }
          store.selectRegion(audio, midi, trackId, ev.shiftKey)
        },
      )
      return
    }
    if (current === 'pencil') {
      const lane = target.closest('.lane') as HTMLElement | null
      const trackId = lane?.dataset.track
      if (!trackId) return
      const origin = sampleAt(event.clientX)
      watch(
        (ev) => {
          const a = Math.min(origin, sampleAt(ev.clientX))
          const b = Math.max(origin, sampleAt(ev.clientX))
          setGhost({ trackId, left: (a / project.sampleRate) * pxRef.current, width: ((b - a) / project.sampleRate) * pxRef.current })
        },
        (ev) => {
          setGhost(null)
          store.drawRegion(trackId, origin, sampleAt(ev.clientX))
        },
      )
      return
    }
    if (current === 'select' && !target.closest('.clip')) {
      const trackId = (target.closest('.lane') as HTMLElement | null)?.dataset.track || store.selectedTrackId || project.tracks[0]?.id
      if (trackId) store.selectClip(trackId, null, false, false)
    }
  }

  function trimPattern(event: ReactPointerEvent, clipId: string, edge: 'start' | 'end') {
    event.stopPropagation()
    event.preventDefault()
    const clip = project.patternClips?.find((item) => item.id === clipId)
    if (!clip) return
    const trackId = clip.trackId || ''
    const grid = activeGridBeats(project)
    const apply = (clientX: number) => {
      const beat = projectSampleBeat(project, Math.max(0, sampleAt(clientX)))
      const snapped = edgeFromPointer(clip.startBeat, clip.startBeat + clip.lengthBeats, beat, edge, grid)
      const rawEnd = edge === 'end' ? Math.max(clip.startBeat + 0.05, beat) : clip.startBeat + clip.lengthBeats
      const rawStart = edge === 'start' ? Math.max(0, Math.min(beat, rawEnd - 0.05)) : clip.startBeat
      showEdge(trackId, clipId, snapped.start, snapped.end, rawStart, rawEnd, edge)
      return snapped
    }
    apply(event.clientX)
    watch(
      (ev) => { apply(ev.clientX) },
      (ev) => {
        const snapped = apply(ev.clientX)
        setDragView(null)
        store.resizePatternClip(clipId, edge, edge === 'end' ? snapped.end : snapped.start)
      },
      { id: event.pointerId, node: event.currentTarget as HTMLElement },
    )
  }

  function trimMidi(event: ReactPointerEvent, trackId: string, clipId: string, edge: 'start' | 'end', stretch: boolean) {
    event.stopPropagation()
    event.preventDefault()
    const clip = project.tracks.find((track) => track.id === trackId)?.midiClips.find((item) => item.id === clipId)
    if (!clip) return
    const grid = activeGridBeats(project)
    const apply = (clientX: number) => {
      const beat = projectSampleBeat(project, Math.max(0, sampleAt(clientX)))
      const snapped = edgeFromPointer(clip.startBeat, clip.startBeat + clip.durationBeats, beat, edge, grid)
      const rawEnd = edge === 'end' ? Math.max(clip.startBeat + 0.05, beat) : clip.startBeat + clip.durationBeats
      const rawStart = edge === 'start' ? Math.max(0, Math.min(beat, rawEnd - 0.05)) : clip.startBeat
      showEdge(trackId, clipId, snapped.start, snapped.end, rawStart, rawEnd, edge)
      return snapped
    }
    apply(event.clientX)
    watch(
      (ev) => { apply(ev.clientX) },
      (ev) => {
        const snapped = apply(ev.clientX)
        setDragView(null)
        store.resizeMidiClip(trackId, clipId, edge, edge === 'end' ? snapped.end : snapped.start, stretch)
      },
      { id: event.pointerId, node: event.currentTarget as HTMLElement },
    )
  }

  function focusTimeline() {
    const node = scroller.current
    if (!node) return
    if (document.activeElement !== node) node.focus({ preventScroll: true })
  }

  function openClipEditor(kind: 'audio' | 'midi' | 'pattern', trackId: string, clipId: string) {
    if (kind === 'audio') {
      const audio = project.tracks.find((item) => item.id === trackId)?.clips.find((item) => item.id === clipId)
      if (audio?.folder) store.selectClip(trackId, clipId, false, true)
      else store.openWaveEditor(trackId, clipId)
      return
    }
    const track = project.tracks.find((item) => item.id === trackId)
    const surface = editorForGesture('edit-notes', track?.type ?? '', track)
    if (surface === 'steps') onOpenSteps?.(trackId)
    else if (kind === 'midi') onOpenPiano(trackId, clipId)
  }

  function noteClipTap(kind: 'audio' | 'midi' | 'pattern', trackId: string, clipId: string) {
    const now = performance.now()
    const since = clipId === lastClipTap.current.id ? now - lastClipTap.current.at : Number.POSITIVE_INFINITY
    const track = project.tracks.find((item) => item.id === trackId)
    const action = clipTapAction({
      moved: false,
      sinceLastMs: since,
      kind,
      sequencer: (kind === 'pattern' || kind === 'midi') && hasStepSequencer(track),
    })
    if (action === 'edit') {
      lastClipTap.current = { id: '', at: 0 }
      openClipEditor(kind, trackId, clipId)
      return
    }
    lastClipTap.current = { id: clipId, at: now }
  }

  function revealTrack(trackId: string, gesture: 'select-track' | 'tap-clip', clipId?: string) {
    const track = project.tracks.find((item) => item.id === trackId)
    const surface = editorForGesture(gesture, track?.type ?? '', track)
    if (surface === 'pads') onOpenBeatMachine?.(trackId)
    else if (surface === 'steps') onOpenSteps?.(trackId)
    else if (surface === 'keyboard') onOpenKeyboard?.(trackId)
    else if (surface === 'piano') onOpenPiano(trackId, clipId)
  }

  function moveSelection(event: ReactPointerEvent, kind: 'audio' | 'midi' | 'pattern', trackId: string, clipId: string) {
    event.stopPropagation()
    focusTimeline()
    if (kind === 'pattern') setPatternMenu(null)
    const onSequencer = hasStepSequencer(project.tracks.find((item) => item.id === trackId))
    const scrollAware = kind === 'pattern' || (kind === 'midi' && onSequencer)
    if (!scrollAware && (touch || event.pointerType === 'touch')) event.preventDefault()
    const additive = event.shiftKey || event.metaKey || event.ctrlKey
    const selected = kind === 'audio' ? store.selectedClipIds : kind === 'midi' ? store.selectedMidiClipIds : store.selectedPatternClipIds
    const wasIn = selected.includes(clipId)
    const ids = !additive ? (wasIn ? [...selected] : [clipId]) : wasIn ? [...selected] : [...selected, clipId]
    if (additive) {
      if (!wasIn) store.selectClip(trackId, clipId, kind === 'midi', false, true)
    } else if (!wasIn) store.selectClip(trackId, clipId, kind === 'midi', false, false)
    const origins = new Map<string, { trackId: string; at: number }>()
    for (const track of project.tracks) {
      if (kind === 'audio') {
        for (const clip of track.clips) if (ids.includes(clip.id)) origins.set(clip.id, { trackId: track.id, at: clip.startSample })
      } else if (kind === 'midi') {
        for (const clip of track.midiClips) if (ids.includes(clip.id)) origins.set(clip.id, { trackId: track.id, at: clip.startBeat })
      }
    }
    if (kind === 'pattern') {
      for (const clip of project.patternClips ?? []) {
        if (ids.includes(clip.id) && clip.scene == null) origins.set(clip.id, { trackId: clip.trackId || trackId, at: clip.startBeat })
      }
    }
    const originX = event.clientX
    const originY = event.clientY
    const started = performance.now()
    const grid = activeGridBeats(project)
    const barBeats = quartersPerBar(project.timeSignature)
    const grabBeat = projectSampleBeat(project, Math.max(0, sampleAt(event.clientX)))
    const primary = origins.get(clipId)
    const lengthOf = (id: string) => {
      if (kind === 'midi') {
        for (const track of project.tracks) {
          const found = track.midiClips.find((item) => item.id === id)
          if (found) return found.durationBeats
        }
      }
      if (kind === 'audio') {
        for (const track of project.tracks) {
          const found = track.clips.find((item) => item.id === id)
          if (found) return projectSampleBeat(project, found.durationSamples)
        }
      }
      if (kind === 'pattern') return project.patternClips?.find((item) => item.id === id)?.lengthBeats ?? 1
      return 1
    }
    const deltas = new Map<string, number>()
    let travel = 0
    let intent: 'wait' | 'drag' | 'scroll' = 'wait'
    const preview = (clientX: number) => {
      const pointerBeat = projectSampleBeat(project, Math.max(0, sampleAt(clientX)))
      const patch: Record<string, number> = {}
      const deltaBeat = primary && kind !== 'audio' ? moveFromPointer(primary.at, grabBeat, pointerBeat, grid) - primary.at : 0
      for (const [id, item] of origins) {
        if (kind === 'audio') {
          const originBeat = projectSampleBeat(project, item.at)
          const snappedBeat = moveFromPointer(originBeat, grabBeat, pointerBeat, grid)
          patch[id] = projectBeatSample(project, snappedBeat) - item.at
        } else {
          const start = grid > 0 ? moveFromPointer(item.at, item.at, item.at + deltaBeat, grid) : Math.max(0, item.at + deltaBeat)
          patch[id] = start - item.at
        }
        deltas.set(id, patch[id])
      }
      if (primary) {
        const start = kind === 'audio'
          ? projectSampleBeat(project, Math.max(0, primary.at + (deltas.get(clipId) ?? 0)))
          : Math.max(0, primary.at + (deltas.get(clipId) ?? 0))
        const length = lengthOf(clipId)
        showEdge(trackId, clipId, start, start + length, start, start + length, 'start', positionReadout(start, barBeats))
      }
      setNudge(kind === 'audio' ? { audio: patch, midi: {}, pattern: {} } : kind === 'midi' ? { audio: {}, midi: patch, pattern: {} } : { audio: {}, midi: {}, pattern: patch })
    }
    watch(
      (ev) => {
        const dx = ev.clientX - originX
        const dy = ev.clientY - originY
        travel = Math.max(travel, Math.hypot(dx, dy))
        if (scrollAware) {
          intent = patternPointerIntent(dx, dy, event.pointerType)
          if (intent !== 'drag') return
        }
        preview(ev.clientX)
      },
      (ev) => {
        if (scrollAware && (intent === 'scroll' || ev.type === 'pointercancel')) {
          setNudge(null)
          setDragView(null)
          return
        }
        preview(ev.clientX)
        setNudge(null)
        setDragView(null)
        if (kind === 'pattern' && patternHoldOpensMenu(touch, performance.now() - started, travel)) {
          store.selectClip(trackId, clipId, false, false)
          setPatternMenu(patternMenuPoint(originX, originY, 168, 56, window.innerWidth, window.innerHeight))
          return
        }
        const host = kind === 'pattern' ? patternHostId(project.tracks, laneAt(ev.clientX, ev.clientY)) : null
        const moved = [...deltas.values()].some((value) => Math.abs(value) >= (kind === 'audio' ? 1 : 0.01))
        const retargeted = !!host && [...origins.values()].some((item) => item.trackId !== host)
        if (clipReleaseAction({
          travel,
          moved,
          retargeted,
          touch: event.pointerType === 'touch',
        }) === 'tap') {
          if (additive && wasIn) store.selectClip(trackId, clipId, kind === 'midi', false, true)
          noteClipTap(kind, trackId, clipId)
          return
        }
        if (kind === 'audio') {
          store.placeAudioClips([...origins].map(([id, item]) => ({ trackId: item.trackId, clipId: id, startSample: Math.max(0, item.at + (deltas.get(id) ?? 0)) })))
        } else if (kind === 'midi') {
          store.placeMidiClips([...origins].map(([id, item]) => ({ trackId: item.trackId, clipId: id, startBeat: Math.max(0, item.at + (deltas.get(id) ?? 0)) })))
        } else {
          store.placePatternClips([...origins].map(([id, item]) => ({
            clipId: id,
            startBeat: Math.max(0, item.at + (deltas.get(id) ?? 0)),
            trackId: host && host !== item.trackId ? host : undefined,
          })))
        }
      },
    )
  }

  const [utility, setUtility] = useState<UtilitySheet | null>(null)
  const setupOpen = utility === 'setup'
  const setupButton = useRef<HTMLButtonElement | null>(null)
  const [browserOwned, setBrowserOwned] = useState(() => browserDock ?? panelChoice('arrangeBrowser') ?? form === 'desk')
  const browserOpen = browserDock ?? browserOwned
  function setBrowserOpen(next: boolean) {
    setBrowserOwned(next)
    onBrowserDock?.(next)
    rememberPanel('arrangeBrowser', next)
  }
  const browserPhase = usePushPhase(browserOpen)
  useEffect(() => {
    if (!phone || !browserOpen) return
    setPluginsOpen(false)
    if (!utilityRef.current && !trackRef.current) return
    popSheetHistory()
    setTrackSheet(null)
    setUtility(null)
  }, [phone, browserOpen])
  const pluginsPhase = usePushPhase(pluginsOpen)
  useScreenOverlay(() => setPluginsOpen(false), pluginsOpen)
  const [browserTab, setBrowserTab] = useState<BrowserTab>(readBrowsePlace().tab)
  const [browserWidth, setBrowserWidth] = useState(() => browserWidthFor(typeof window === 'undefined' ? 1440 : window.innerWidth, typeof window === 'undefined' ? 900 : window.innerHeight))
  useEffect(() => {
    if (phone) return
    setBrowserWidth(browserWidthFor(window.innerWidth, window.innerHeight))
  }, [phone])
  const [trackSheet, setTrackSheet] = useState<string | null>(null)
  const utilityRef = useRef(utility)
  const trackRef = useRef(trackSheet)
  utilityRef.current = utility
  trackRef.current = trackSheet
  const historyKey = sheetHistoryKey(trackSheet, utility)
  useScreenOverlay(() => closeSheets(), historyKey != null)
  function closeSheets() {
    if (trackRef.current || utilityRef.current) popSheetHistory()
    setTrackSheet(null)
    setUtility(null)
  }
  function toggleUtility(id: UtilitySheet) {
    const current = utilityRef.current
    const next = current === id ? null : id
    if (current && !next && !trackRef.current) popSheetHistory()
    if (next) {
      engine.stopPreview()
      setBrowserOpen(false)
      setPluginsOpen(false)
      setTrackSheet(null)
    }
    setUtility(next)
  }
  function toggleTrack(id: string) {
    if (trackRef.current === id) {
      popSheetHistory()
      setTrackSheet(null)
      return
    }
    engine.stopPreview()
    setBrowserOpen(false)
    setPluginsOpen(false)
    setUtility(null)
    setTrackSheet(id)
  }
  useEffect(() => {
    publishArrangeSheet(utility)
    return () => publishArrangeSheet(null)
  }, [utility])
  useEffect(() => {
    if (!historyKey) return
    rememberSheetHistory(historyKey)
    const onPop = () => {
      setTrackSheet(null)
      setUtility(null)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [historyKey])
  useEffect(() => {
    const onTab = (event: Event) => {
      const next = (event as CustomEvent<BrowserTab>).detail
      if (next) setBrowserTab(next)
    }
    const onClose = () => {
      if (trackRef.current || utilityRef.current) popSheetHistory()
      setTrackSheet(null)
      setUtility(null)
      setPluginsOpen(false)
    }
    document.addEventListener(BROWSER_TAB_EVENT, onTab)
    document.addEventListener(CLOSE_ARRANGE_SHEETS, onClose)
    return () => {
      document.removeEventListener(BROWSER_TAB_EVENT, onTab)
      document.removeEventListener(CLOSE_ARRANGE_SHEETS, onClose)
    }
  }, [])
  useEffect(() => {
    const onSheet = (event: Event) => {
      const id = (event as CustomEvent<UtilitySheet>).detail
      if (id !== 'setup' && id !== 'tools' && id !== 'snap') return
      toggleUtility(id)
    }
    document.addEventListener(ARRANGE_SHEET_EVENT, onSheet)
    return () => document.removeEventListener(ARRANGE_SHEET_EVENT, onSheet)
  })
  useEffect(() => {
    if (!libraryTab) return
    setBrowserOpen(true)
  }, [libraryTab])
  const selected = project.tracks.flatMap((track) => track.clips.filter((clip) => clip.id === store.selectedClipId).map((clip) => ({ track, clip })))[0]
  const sheetTrack = project.tracks.find((track) => track.id === trackSheet) || null

  function resizeBrowser(event: ReactPointerEvent) {
    event.preventDefault()
    const startX = event.clientX
    const start = browserWidth
    const frame = (event.currentTarget.parentElement as HTMLElement | null)
    frame?.setAttribute('data-push', 'dragging')
    const move = (ev: PointerEvent) => setBrowserWidth(Math.min(520, Math.max(220, start + (ev.clientX - startX))))
    const up = () => {
      frame?.setAttribute('data-push', 'on')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="arrange-wrap">
      <SmartTempoBar store={store} />
      {!phone && (
      <ArrangeChrome
        browserOpen={browserOpen}
        setupOpen={setupOpen}
        pluginsOpen={pluginsOpen}
        setupButton={setupButton}
        menu={phoneBar?.menu}
        showPlugins
        onPlugins={() => {
          if (!pluginsOpen) closeSheets()
          setPluginsOpen((open) => !open)
        }}
        onBrowser={() => {
          const next = !browserOpen
          if (next) closeSheets()
          if (!next) {
            engine.stopPreview()
            onLibraryClose?.()
          }
          setBrowserOpen(next)
        }}
        onSetup={() => toggleUtility('setup')}
      />
      )}
      <div className={`arrange-stage${pluginsPhase !== 'off' ? (phone ? ' plugins-bottom' : ' plugins-side') : ''}${phone && browserPhase !== 'off' ? ' browser-bottom' : ''}`} data-plugins-drawer={pluginsPhase !== 'off' ? (phone ? 'bottom' : 'side') : 'closed'} data-browser-sheet={phone ? (browserPhase !== 'off' ? 'bottom' : 'closed') : 'side'} data-push={pluginsPhase} data-browser-push={phone ? browserPhase : undefined} style={{ ['--push' as string]: '280px' }}>
      <div className={`playlist-frame ${!phone && browserPhase !== 'off' ? 'browser-open' : ''} ${phone ? 'phone-arrange' : ''}`} data-push={phone ? 'off' : browserPhase} style={{ ['--browser' as string]: `${browserWidth}px`, ['--push' as string]: `${browserWidth}px` }}>
      {!phone && browserPhase !== 'off' && (
        <>
          <PlaylistBrowser
            store={store}
            engine={engine}
            phone={phone}
            tab={browserTab}
            onTab={(next) => { setBrowserTab(next); writeBrowsePlace({ tab: next === 'patterns' || next === 'clips' ? next : 'library' }) }}
            onSeek={onSeek}
            onClose={() => { engine.stopPreview(); setBrowserOpen(false); rememberPanel('arrangeBrowser', false); onLibraryClose?.() }}
          />
          <button type="button" className="browser-resize" aria-label="Browser width. Drag to resize." title="Drag to resize the browser." onPointerDown={resizeBrowser} />
        </>
      )}
      <div className={`arrange ${phone ? 'phone-arrange' : ''}`} data-tool={tool} data-phone-arrange={phone ? 'compact' : 'full'} data-lane-scale={laneScaleAttr(laneZoom)} data-lane-compact={laneZoom <= 0.72 ? 'true' : undefined} style={{ ['--lane-zoom' as string]: String(laneZoom) }}>
      <div className="heads-col">
      {!phone && (
        <div className="track-viewfinder-slot" ref={finderRef}>
          <TrackViewfinder store={store} playheadSample={position} />
        </div>
      )}
      <div
        className="heads"
        ref={headsRef}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) return
          const body = scroller.current
          if (!body) return
          body.scrollTop += event.deltaY
        }}
      >
        <div
          className={`ruler-gap loop-gap${phone ? ' arrange-touchpad' : ''}`}
          data-arrange-touchpad={phone ? '' : undefined}
          role={phone ? 'application' : undefined}
          aria-label={phone ? 'Arrange touchpad. Drag to scroll the timeline.' : undefined}
          onPointerDown={phone ? onTouchpadDown : undefined}
        >
          <SongMapHead store={store} position={position} compact />
        </div>
        {project.tracks.map((track) => (
          <div className={`head${store.selectedTrackId === track.id ? ' is-selected' : ''}`} data-track={track.id} data-track-name={track.name} key={track.id} style={rowStyle(track, store.selectedClipId, !!store.openLanes[track.id])} onClick={() => { if (phone) { setPhoneFocus('track'); store.selectClip(track.id, null, false, false) }; store.selectTrack(track.id); revealTrack(track.id, 'select-track') }}>
            <div className="pl-head">
              <div className="track-meter-row">
                <span className="mini-meter" data-arrange-meter={track.id} aria-hidden>
                  <i style={{ transform: `scaleX(${levels[track.id] ?? 0})` }} />
                </span>
                <span className="track-live" data-track-live={track.id}>
                  <i
                    className="midi-activity"
                    data-midi-activity={track.id}
                    data-lit={midiOn[track.id] ? '1' : '0'}
                    role="img"
                    aria-label={midiOn[track.id] ? 'MIDI activity. Notes are playing.' : 'MIDI activity. Idle.'}
                  />
                </span>
                <TrackPresence trackId={track.id} />
              </div>
              <div className="track-title-slot">
                <TrackTitle
                  name={track.name}
                  onSelect={() => {
                    if (phone) { setPhoneFocus('track'); store.selectClip(track.id, null, false, false) }
                    store.selectTrack(track.id)
                    revealTrack(track.id, 'select-track')
                  }}
                  onRename={(next) => store.updateTrack(track.id, { name: next })}
                />
              </div>
              <div className="track-controls" data-track-controls="">
              <MixFlags store={store} trackId={track.id} compact />
              {(track.type === 'audio' || (track.type === 'midi' && hardwareMidiAllowed(navigator.userAgent))) && (
                <TipButton className={`mini ${track.armed ? 'on-r' : ''}`} label={copyOf(TRACK_ROW, 'arm').label} hint={track.type === 'midi' ? 'Record this instrument from its MIDI input.' : copyOf(TRACK_ROW, 'arm').hint} pressed={track.armed} onClick={() => store.updateTrack(track.id, { armed: !track.armed })}>
                  <span className="mini-mark">R</span>
                  <span className="mini-word">Arm</span>
                </TipButton>
              )}
              {track.type === 'midi' ? (
                <button
                  type="button"
                  className="piano-open"
                  data-piano={track.id}
                  aria-label="Piano roll"
                  title="Piano roll"
                  onClick={(event) => { event.stopPropagation(); onOpenPiano(track.id) }}
                >
                  <span>Roll</span>
                </button>
              ) : null}
              {showsOpenBeatMachine(track) ? (
                <OpenBeatMachineButton store={store} trackId={track.id} onOpen={onOpenBeatMachine} />
              ) : null}
              {store.selectedTrackId === track.id && showsOnscreenPiano(track) ? (
                <KeyboardToggle store={store} engine={engine} word="Piano" />
              ) : null}
              <TipButton className="mini track-more" label="Track" hint="Input, routing, inserts, and the rest of this track." onClick={(event) => { event.stopPropagation(); toggleTrack(track.id) }}>
                ⋮
              </TipButton>
              </div>
            </div>
            <LanePicker store={store} trackId={track.id} />
          </div>
        ))}
        <div className="track-add">
          <AddTrackButton store={store} prominent onAdded={onTrackAdded} />
        </div>
      </div>
      </div>
      <div className="timeline-col">
      <div className="timeline-add-spacer" aria-hidden="true" />
      <div className="timeline-stage">
      <div
        className="timeline-scroll"
        ref={scroller}
        tabIndex={-1}
        style={{ touchAction: toolClaimsGesture(tool) ? 'none' : 'pan-x pan-y' }}
        onScroll={() => {
          const heads = headsRef.current
          const body = scroller.current
          if (heads && body && heads.scrollTop !== body.scrollTop) heads.scrollTop = body.scrollTop
        }}
        onPointerDown={(event) => { focusTimeline(); onTimelineDown(event) }}
      >
        <div className="timeline-inner" ref={innerRef} data-px={px} style={{ width }}>
          <SongMap store={store} px={px} width={width} onSeek={onSeek} />
          <div className="ruler" style={laneGrid ?? undefined}>
            {paint.hint && <em className="grid-hint" role="status">{paint.hint}</em>}
            <LoopRegion
              store={store}
              project={project}
              view="arrange"
              gridBeats={loopGridBeats(project)}
              sampleAt={(clientX, rect) => ((clientX - rect.left) / px) * project.sampleRate}
              xAt={(sample) => (sample / project.sampleRate) * px}
              onSeek={(sample) => onSeek(snapSampleToMap(sample, project))}
              yieldEmpty={tool === 'pan' || tool === 'zoom'}
              followScroll
            />
            {marks.filter((mark) => mark.downbeat).map((mark) => (
              <span key={mark.beat} style={{ left: pxAtBeat(project, mark.beat, px) }}>
                {mark.bar}
              </span>
            ))}
            <CommentControl session={session} project={project} position={position} />
            <CommentPins session={session} project={project} px={px} onSeek={onSeek} />
          </div>
          {phone && (
            <div
              className="playhead-strip"
              data-playhead-strip=""
              role="slider"
              aria-label="Playhead. Tap or drag to move it."
              aria-valuemin={0}
              aria-valuenow={Math.round(position)}
              onPointerDown={(event) => {
                if (event.button !== 0 && event.pointerType !== 'touch') return
                event.stopPropagation()
                event.preventDefault()
                const node = event.currentTarget
                const seek = (clientX: number) => {
                  const rect = node.getBoundingClientRect()
                  const sample = Math.max(0, ((clientX - rect.left) / pxRef.current) * project.sampleRate)
                  onSeek(snapSampleToMap(sample, project, subdivisionFor(project)))
                }
                seek(event.clientX)
                const pointerId = event.pointerId
                const move = (ev: PointerEvent) => {
                  if (ev.pointerId !== pointerId) return
                  seek(ev.clientX)
                }
                const up = (ev: PointerEvent) => {
                  if (ev.pointerId !== pointerId) return
                  window.removeEventListener('pointermove', move)
                  window.removeEventListener('pointerup', up)
                }
                window.addEventListener('pointermove', move)
                window.addEventListener('pointerup', up)
              }}
            />
          )}
          <div className="bar-grid" aria-hidden>
            {marks.filter((mark) => mark.downbeat).map((mark) => (
              <i key={mark.beat} style={{ left: pxAtBeat(project, mark.beat, px) }} />
            ))}
          </div>
          {project.loopEnabled && (
            <div
              className="loop-band"
              style={{
                left: (project.loopStartSample / project.sampleRate) * px,
                width: ((project.loopEndSample - project.loopStartSample) / project.sampleRate) * px,
              }}
            />
          )}
          {project.tracks.map((track) => (
            <div
              className={`lane${store.selectedTrackId === track.id ? ' is-selected' : ''}`}
              data-track={track.id}
              key={track.id}
              style={{ ...(laneGrid ?? { backgroundImage: 'none' }), ...rowStyle(track, store.selectedClipId, !!store.openLanes[track.id]) }}
              onDoubleClick={(event) => {
                if (track.type !== 'midi') return
                if (!laneDoubleClickAddsClip(event.target)) return
                const bounds = event.currentTarget.getBoundingClientRect()
                const sample = ((event.clientX - bounds.left) / px) * project.sampleRate
                store.addMidiClip(track.id, Math.floor(projectSampleBeat(project, sample)))
              }}
              onDragOver={(event) => {
                if (track.type !== 'midi') return
                if (![...event.dataTransfer.types].includes(SCALER_MIME)) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                if (track.type === 'midi' && event.dataTransfer.files.length) {
                  event.preventDefault()
                  event.stopPropagation()
                  onImportInstrument?.(track.id, event.dataTransfer.files)
                  return
                }
                if (track.type !== 'midi') return
                const payload = parseScalerDrag(event.dataTransfer.getData(SCALER_MIME) || event.dataTransfer.getData('text/plain'))
                if (!payload) return
                event.preventDefault()
                event.stopPropagation()
                const sample = sampleAt(event.clientX)
                const beat = projectSampleBeat(project, sample)
                store.writeScalerClip(track.id, payload.notes, Math.max(0, beat), payload.name)
              }}
            >
              <AutoTuneLaneMark plugins={track.plugins} />
              {dragView?.trackId === track.id && (
                <>
                  <div className="snap-shadow" data-snap-shadow="1" style={{ left: dragView.snapLeft, width: dragView.snapWidth }} />
                  <i className="snap-line" style={{ left: dragView.line }} />
                  <em className="snap-read" style={{ left: dragView.line }}>{dragView.label}</em>
                </>
              )}
              {ghost?.trackId === track.id && (
                <div className="clip" data-draw="1" style={{ left: ghost.left, width: Math.max(8, ghost.width), opacity: 0.45, pointerEvents: 'none' }} />
              )}
              {track.clips.filter((clip) => !clip.slotOnly).map((clip) => (
                <ClipView
                  key={clip.id}
                  store={store}
                  clip={clip}
                  trackId={track.id}
                  px={px}
                  tool={tool}
                  shift={nudge?.audio[clip.id] ?? 0}
                  passive={passive}
                  remotes={remotes}
                  onSplitAt={(clientX) => store.splitAt(track.id, clip.id, sampleAt(clientX))}
                  onSplit={(enabled) => {
                    const at = engine.currentTimelineSample()
                    const channel = store.buffers.get(clip.bufferId)?.channels[0]
                    const next = enabled ? snapClipTimeline(clip, channel, at, true).sample : at
                    store.splitSelected(next)
                  }}
                  onErase={beginErase}
                  onMove={(event) => moveSelection(event, 'audio', track.id, clip.id)}
                />
              ))}
              <AutomationOverlay store={store} trackId={track.id} px={px} tool={tool} />
              {track.midiClips.filter((clip) => !clip.slotOnly && clip.scene == null).map((clip) => {
                const live = dragView?.clipId === clip.id ? dragView : null
                const beat = live ? live.rawStart : clip.startBeat + (nudge?.midi[clip.id] ?? 0)
                const lengthBeats = live ? live.rawLength : clip.durationBeats
                const left = pxAtBeat(project, beat, px)
                const widthPx = Math.max(8, pxAtBeat(project, beat + lengthBeats, px) - left)
                const picked = store.selectedMidiClipIds.includes(clip.id)
                const remote = remoteClipMark(remotes, clip.id)
                return (
                  <div key={clip.id} style={{ display: 'contents' }}>
                  <div
                    data-clip={clip.id}
                    data-midi="1"
                    data-track={track.id}
                    data-remote-select={remote?.id}
                    className={`clip ${picked ? 'selected' : ''}${remote ? ' remote-selected' : ''}`}
                    style={{ left, width: widthPx, background: track.color, pointerEvents: passive ? 'none' : undefined, touchAction: !passive && hasStepSequencer(track) ? 'pan-y' : undefined, ['--remote' as string]: remote?.color }}
                    onPointerDown={(event) => {
                      if (tool === 'erase') {
                        beginErase(event)
                        return
                      }
                      if (tool === 'split') {
                        event.stopPropagation()
                        event.preventDefault()
                        store.splitAt(track.id, clip.id, sampleAt(event.clientX))
                        return
                      }
                      if ((event.target as HTMLElement).closest('.edge')) return
                      if (tool === 'trim') {
                        event.stopPropagation()
                        event.preventDefault()
                        const bounds = event.currentTarget.getBoundingClientRect()
                        const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)
                        const zone = trimZone(ratio, coarsePointer(event.pointerType))
                        if (zone === 'start' || zone === 'end') trimMidi(event, track.id, clip.id, zone, event.altKey)
                        else store.selectClip(track.id, clip.id, true, false)
                        return
                      }
                      if (tool !== 'select') return
                      moveSelection(event, 'midi', track.id, clip.id)
                    }}
                    onDoubleClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      lastClipTap.current = { id: '', at: 0 }
                      store.selectClip(track.id, clip.id, true, false)
                      const surface = editorForGesture('tap-clip', track.type, track)
                      if (surface === 'steps') onOpenSteps?.(track.id)
                      else onOpenPiano(track.id, clip.id)
                    }}
                  >
                    <em>{clip.name}</em>
                    {picked && (
                      <button
                        type="button"
                        className="edit-notes"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation()
                          const surface = editorForGesture('edit-notes', track.type, track)
                          if (surface === 'steps') onOpenSteps?.(track.id)
                          else if (surface === 'piano') onOpenPiano(track.id, clip.id)
                        }}
                      >
                        Edit Notes
                      </button>
                    )}
                    <span className="clip-notes" aria-hidden>
                      {clip.notes.slice(0, 64).map((note) => {
                        const lo = Math.min(...clip.notes.map((item) => item.pitch))
                        const hi = Math.max(lo + 1, ...clip.notes.map((item) => item.pitch))
                        return (
                          <i
                            key={note.id}
                            style={{
                              left: `${(note.startBeat / Math.max(0.25, clip.durationBeats)) * 100}%`,
                              width: `${Math.max(2, (note.durationBeats / Math.max(0.25, clip.durationBeats)) * 100)}%`,
                              top: `${((hi - note.pitch) / (hi - lo)) * 72}%`,
                            }}
                          />
                        )
                      })}
                    </span>
                    {(tool === 'select' || tool === 'trim') && (
                      <ClipEdges
                        onStart={(event) => trimMidi(event, track.id, clip.id, 'start', event.altKey)}
                        onEnd={(event) => trimMidi(event, track.id, clip.id, 'end', event.altKey)}
                      />
                    )}
                  </div>
                  </div>
                )
              })}
              {(project.patternClips ?? [])
                  .filter((clip) => clip.scene == null && !clip.suppressed && clip.trackId === track.id)
                  .map((clip) => {
                    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
                    const live = dragView?.clipId === clip.id ? dragView : null
                    const beat = live ? live.rawStart : clip.startBeat + (nudge?.pattern[clip.id] ?? 0)
                    const lengthBeats = live ? live.rawLength : clip.lengthBeats
                    const left = pxAtBeat(project, beat, px)
                    const widthPx = Math.max(24, pxAtBeat(project, beat + lengthBeats, px) - left)
                    const previewNotes = pattern ? patternToMidiNotes(pattern) : []
                    const picked = store.selectedPatternClipIds.includes(clip.id)
                    const remote = remoteClipMark(remotes, clip.id)
                    const linked = (project.patternClips ?? []).filter((item) => item.scene == null && item.patternId === clip.patternId).length > 1
                    return (
                      <div key={clip.id} style={{ display: 'contents' }}>
                      <div
                        data-clip={clip.id}
                        data-pattern="1"
                        data-track={track.id}
                        data-remote-select={remote?.id}
                        className={`clip pattern ${picked ? 'selected' : ''}${remote ? ' remote-selected' : ''}`}
                        style={{ left, width: widthPx, background: pattern?.color || track.color, pointerEvents: passive ? 'none' : undefined, touchAction: passive ? undefined : 'pan-y', ['--remote' as string]: remote?.color }}
                        onContextMenu={(event) => event.preventDefault()}
                        onDoubleClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          const made = store.mirrorPatternClip(clip.id)
                          if (made) revealTrack(made.trackId, 'tap-clip')
                        }}
                        onPointerDown={(event) => {
                          if ((event.target as HTMLElement).closest('.edge')) return
                          if (tool === 'erase') {
                            beginErase(event)
                            return
                          }
                          if (tool === 'trim') {
                            event.stopPropagation()
                            event.preventDefault()
                            const bounds = event.currentTarget.getBoundingClientRect()
                            const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)
                            const zone = trimZone(ratio, coarsePointer(event.pointerType))
                            if (zone === 'start' || zone === 'end') trimPattern(event, clip.id, zone)
                            else store.selectClip(track.id, clip.id, false, false)
                            return
                          }
                          if (tool !== 'select') return
                          moveSelection(event, 'pattern', track.id, clip.id)
                        }}
                      >
                        <em>{pattern?.name || 'Pattern'}{linked ? ' · Linked' : ''}</em>
                        {picked && linked && (
                          <button
                            type="button"
                            className="clip-unique"
                            title="Make this clip its own pattern. The other copies stay linked."
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                              event.stopPropagation()
                              store.makePatternClipUnique(clip.id)
                            }}
                          >
                            Unique
                          </button>
                        )}
                        <span className="clip-notes" aria-hidden>
                          {previewNotes.slice(0, 64).map((note, index) => {
                            const lo = Math.min(...previewNotes.map((item) => item.pitch))
                            const hi = Math.max(lo + 1, ...previewNotes.map((item) => item.pitch))
                            return (
                              <i
                                key={`${note.pitch}-${index}`}
                                style={{
                                  left: `${(note.startBeat / Math.max(0.25, lengthBeats)) * 100}%`,
                                  width: `${Math.max(2, (note.durationBeats / Math.max(0.25, lengthBeats)) * 100)}%`,
                                  top: `${((hi - note.pitch) / (hi - lo)) * 72}%`,
                                }}
                              />
                            )
                          })}
                        </span>
                        {(tool === 'select' || tool === 'trim') && (
                          <ClipEdges
                            startLabel="Trim start. Drag to move the beginning. The pattern stays on the grid."
                            endLabel="Trim end. Drag to change how long the pattern plays."
                            onStart={(event) => trimPattern(event, clip.id, 'start')}
                            onEnd={(event) => trimPattern(event, clip.id, 'end')}
                          />
                        )}
                      </div>
                      </div>
                    )
                  })}
            </div>
          ))}
          {marquee && <div className="marquee" style={marquee} />}
          <RemoteTimeline peers={remotes} sampleRate={project.sampleRate} px={px} />
          <div className="playhead" data-playhead="arrange" style={{ left: (displayedPlayhead(position, project) / project.sampleRate) * px }} />
        </div>
        </div>
        <TimelineOverview
          scrollerRef={scroller}
          seconds={seconds}
          px={px}
          laneZoom={laneZoom}
          onTimeWindow={(nextPx, scrollLeft) => {
            const next = clampPx(nextPx)
            if (Math.abs(next - pxRef.current) < 0.01) {
              if (scroller.current) scroller.current.scrollLeft = scrollLeft
              return
            }
            zoomScroll.current.left = scrollLeft
            setPx(next)
          }}
          onLaneWindow={(nextZoom, scrollTop) => {
            if (Math.abs(nextZoom - laneZoomRef.current) < 0.001) {
              if (scroller.current) scroller.current.scrollTop = scrollTop
              return
            }
            zoomScroll.current.top = scrollTop
            setLaneZoom(nextZoom)
          }}
        />
      </div>
      </div>
      </div>
      </div>
      {phone && browserPhase !== 'off' && (
        <PlaylistBrowser
          store={store}
          engine={engine}
          phone={phone}
          sheet
          tab={browserTab}
          onTab={(next) => { setBrowserTab(next); writeBrowsePlace({ tab: next === 'patterns' || next === 'clips' ? next : 'library' }) }}
          onSeek={onSeek}
          onClose={() => { engine.stopPreview(); setBrowserOpen(false); rememberPanel('arrangeBrowser', false); onLibraryClose?.() }}
        />
      )}
      {pluginsPhase !== 'off' && <PluginsDrawer store={store} place={phone ? 'bottom' : 'side'} menuOpen={pluginsMenu} onClose={() => setPluginsOpen(false)} />}
      <UtilitySheets
        utility={utility}
        store={store}
        engine={engine}
        session={session}
        position={position}
        setupButton={setupButton}
        onClose={closeSheets}
        onQuickPunch={onQuickPunch}
        onReset={onReset}
        onMidi={onMidi}
        roomRole={session.state.role}
      />
      {sheetTrack && (
        <ArrangeBottomSheet
          id="track-options"
          label={`${sheetTrack.name} track`}
          title={sheetTrack.name}
          detail={trackKindLabel(sheetTrack)}
          onClose={closeSheets}
        >
          <TrackOptions
            store={store}
            track={sheetTrack}
            level={levels[sheetTrack.id] ?? 0}
            automationOpen={!!store.openLanes[sheetTrack.id]}
            participants={session.state.participants.filter((person) => person.id !== session.state.selfId)}
            onClose={closeSheets}
            onPerform={onPerform}
            onOpenBeatMachine={onOpenBeatMachine}
            onOpenPiano={onOpenPiano}
            onOpenSteps={onOpenSteps}
            onAnalyze={onAnalyze}
            onOpenPlugins={phone ? () => {
              if (sheetTrack) store.selectTrack(sheetTrack.id)
              closeSheets()
              setPluginsOpen(true)
            } : undefined}
          />
        </ArrangeBottomSheet>
      )}
      </div>
      <AnchoredMenu
        open={!!patternMenu}
        onClose={() => setPatternMenu(null)}
        label="Pattern clip"
        anchor={patternMenu ? { left: patternMenu.x, top: patternMenu.y, width: 28, height: 28 } : null}
        prefer="down"
      >
        <button type="button" title="Copy this pattern clip and place it just after." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.duplicateSelection(); setPatternMenu(null) }}>Duplicate</button>
        <button type="button" title="Give this clip its own pattern so edits stay here." onPointerDown={(event) => event.stopPropagation()} onClick={() => { const id = store.selectedPatternClipId; if (id) store.makePatternClipUnique(id); setPatternMenu(null) }}>Make unique</button>
        <button type="button" title="Remove this pattern clip from the arrangement." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.deleteSelectedClip(); setPatternMenu(null) }}>Delete</button>
      </AnchoredMenu>
      <StemSheet store={store} />
      {store.clipSheet && selected ? (
        <ClipSheet store={store} trackId={selected.track.id} clip={selected.clip} onClose={() => store.closeClipSheet()} />
      ) : null}
    </div>
  )
}

function laneStyle(track: { clips: AudioClip[] }, selectedId: string | null): { height?: number } {
  const open = track.clips.find((clip) => clip.id === selectedId && clip.folder)
  if (!open?.folder) return {}
  return { height: Math.max(168, 40 + open.folder.lanes.length * 48) }
}

function rowStyle(track: { clips: AudioClip[] }, selectedClipId: string | null, automation: boolean) {
  return rowHeight(track, selectedClipId, automation)
}

function rowHeight(track: { clips: AudioClip[] }, selectedId: string | null, automation: boolean): { height?: number | string } {
  const base = laneStyle(track, selectedId)
  if (!automation) {
    if (base.height == null) return base
    return { height: `calc(${base.height}px * var(--lane-zoom, 1))` }
  }
  return { height: `calc(${Math.max(base.height ?? 150, 236)}px * var(--lane-zoom, 1))` }
}

function ClipView({
  store,
  clip,
  trackId,
  px,
  tool,
  shift,
  passive,
  remotes,
  onSplitAt,
  onSplit,
  onErase,
  onMove,
}: {
  store: ProjectStore
  clip: AudioClip
  trackId: string
  px: number
  tool: string
  shift: number
  passive: boolean
  remotes: readonly { id: string; color: string; selectedClipIds: readonly string[] }[]
  onSplitAt: (clientX: number) => void
  onSplit: (snapToZero: boolean) => void
  onErase: (event: ReactPointerEvent) => void
  onMove: (event: ReactPointerEvent) => void
}) {
  const project = selectArrange(store).project
  const asset = store.buffers.get(clip.bufferId)
  const [preview, setPreview] = useState<AudioClip | null>(null)
  const [audioShadow, setAudioShadow] = useState<{ left: number; width: number; line: number; label: string; lock?: boolean } | null>(null)
  const [snapZero, setSnapZero] = useState(true)
  const clipRef = useRef<HTMLDivElement>(null)
  const spanRef = useRef<WaveSpan | null>(null)
  const pinchLock = useRef(false)
  const ghost = store.quantizePreview?.audio.find((item) => item.clipId === clip.id)?.clip
  const shown = preview ?? ghost ?? clip
  const left = ((shown.startSample + (preview ? 0 : shift)) / project.sampleRate) * px
  const width = Math.max(8, (shown.durationSamples / project.sampleRate) * px)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [swipe, setSwipe] = useState<{ laneId: string; from: number; to: number } | null>(null)
  const outline = project.waveforms?.[clip.bufferId]
  const sourceLen = sourceSamplesOf(shown)
  const selected = store.selectedClipIds.includes(clip.id)

  function pointerDown(event: ReactPointerEvent, mode: 'move' | 'start' | 'end') {
    if (event.button === 2 || clipRef.current?.dataset.wavePinch === '1') return
    pinchLock.current = false
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    store.selectClip(trackId, clip.id, false, false)
    const originX = event.clientX
    const originY = event.clientY
    const stretching = event.altKey
    const channel = asset?.channels[0]
    let finger: AudioClip | null = null
    let landed: AudioClip | null = null
    let held = false
    const timer = mode === 'move'
      ? window.setTimeout(() => {
          held = true
          setMenu({ x: originX, y: originY })
        }, 480)
      : 0
    const snapped = (value: number) => project.snap ? snapSampleToMap(value, project, 1 / Math.max(1e-6, activeGridBeats(project) || 1)) : Math.max(0, value)
    const bufferLength = channel?.length ?? clip.offsetSamples + clip.durationSamples
    const place = (edge: 'start' | 'end', timeline: number, zero: boolean) => {
      const raw = trimAudioClip(clip, edge, timeline, bufferLength)
      if (!zero || stretching) return { raw, landed: trimAudioClip(clip, edge, snapped(timeline), bufferLength), lock: false }
      const hit = snapClipTimeline(clip, channel, edge === 'start' ? raw.startSample : raw.startSample + raw.durationSamples, true)
      return { raw, landed: trimAudioClip(clip, edge, hit.sample, bufferLength), lock: hit.locked }
    }
    const move = (ev: PointerEvent) => {
      if (clipRef.current?.dataset.wavePinch === '1' || pinchLock.current) {
        finger = null
        landed = null
        return
      }
      if (Math.abs(ev.clientX - originX) > 8 || Math.abs(ev.clientY - originY) > 8) window.clearTimeout(timer)
      if (held) return
      const delta = ((ev.clientX - originX) / px) * project.sampleRate
      let lock = false
      if (mode === 'move') {
        finger = { ...clip, startSample: snapped(clip.startSample + delta) }
        landed = finger
      }
      if (mode === 'start' && stretching) {
        finger = stretchEdge(clip, 'start', snapped(clip.startSample + delta))
        landed = finger
      }
      if (mode === 'end' && stretching) {
        finger = stretchEdge(clip, 'end', snapped(clip.startSample + clip.durationSamples + delta))
        landed = finger
      }
      if (mode === 'start' && !stretching) {
        const next = place('start', clip.startSample + delta, snapZero)
        finger = next.raw
        landed = next.landed
        lock = next.lock
      }
      if (mode === 'end' && !stretching) {
        const next = place('end', clip.startSample + clip.durationSamples + delta, snapZero)
        finger = next.raw
        landed = next.landed
        lock = next.lock
      }
      setPreview(mode === 'move' || stretching ? landed : finger)
      const ghostClip = landed
      if (ghostClip) {
        const ghostLeft = (ghostClip.startSample / project.sampleRate) * px
        const ghostWidth = Math.max(8, (ghostClip.durationSamples / project.sampleRate) * px)
        const line = mode === 'end' ? ghostLeft + ghostWidth : ghostLeft
        const startBeat = projectSampleBeat(project, ghostClip.startSample)
        const endBeat = projectSampleBeat(project, ghostClip.startSample + ghostClip.durationSamples)
        const label = mode === 'move'
          ? positionReadout(startBeat, quartersPerBar(project.timeSignature))
          : lengthReadout(startBeat, endBeat, quartersPerBar(project.timeSignature))
        setAudioShadow({ left: ghostLeft, width: ghostWidth, line, label, lock })
      }
    }
    const up = (ev: PointerEvent) => {
      window.clearTimeout(timer)
      const pinching = pinchLock.current || clipRef.current?.dataset.wavePinch === '1'
      pinchLock.current = false
      if (!pinching && Number.isFinite(ev.clientX)) move(ev)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      if (pinching) {
        setPreview(null)
        setAudioShadow(null)
        return
      }
      const dropped = Number.isFinite(ev.clientX) ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-slot-drop]') : null
      if (dropped) {
        window.dispatchEvent(new CustomEvent('cueharbor-slot-clip', { detail: { trackId, clipId: clip.id } }))
        setPreview(null)
        setAudioShadow(null)
        return
      }
      if (held) {
        setPreview(null)
        setAudioShadow(null)
        return
      }
      const next = mode === 'move' || stretching ? finger : landed
      setPreview(null)
      setAudioShadow(null)
      if (!next) return
      if (
        mode !== 'move'
        && next.startSample === clip.startSample
        && next.durationSamples === clip.durationSamples
        && next.offsetSamples === clip.offsetSamples
      ) return
      if (mode === 'move') store.moveClip(trackId, clip.id, next.startSample)
      if (stretching && mode === 'start') store.stretchClip(trackId, clip.id, 'start', next.startSample)
      if (stretching && mode === 'end') store.stretchClip(trackId, clip.id, 'end', next.startSample + next.durationSamples)
      if (!stretching && mode === 'start') store.trimClip(trackId, clip.id, 'start', next.startSample, snapZero)
      if (!stretching && mode === 'end') store.trimClip(trackId, clip.id, 'end', next.startSample + next.durationSamples, snapZero)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const fadeIn = (shown.fadeInSamples / project.sampleRate) * px
  const fadeOut = (shown.fadeOutSamples / project.sampleRate) * px
  const editedOutline = arrangeOutline(asset?.channels, shown)
  const remote = remoteClipMark(remotes, clip.id)
  return (
    <div style={{ display: 'contents' }}>
    {audioShadow && (
      <>
        <div className="snap-shadow" data-snap-shadow="1" style={{ left: audioShadow.left, width: audioShadow.width }} />
        <i className="snap-line" data-zero-lock={audioShadow.lock ? '1' : '0'} style={{ left: audioShadow.line }} />
        <em className="snap-read" style={{ left: audioShadow.line }}>{audioShadow.label}</em>
      </>
    )}
    <div
      ref={clipRef}
      data-clip={clip.id}
      data-track={trackId}
      data-snap-zero={snapZero ? '1' : '0'}
      data-remote-select={remote?.id}
      className={`clip ${selected ? 'selected' : ''} ${clip.folder && store.selectedClipId === clip.id ? 'open' : ''}${remote ? ' remote-selected' : ''}`}
      style={{ left, width, background: store.project.tracks.find((t) => t.id === trackId)?.color, pointerEvents: passive ? 'none' : undefined, ['--remote' as string]: remote?.color }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('.take-lane, .edge, .wave-zoom')) return
        if (event.button === 2) return
        if (event.pointerType !== 'mouse' && !event.isPrimary) return
        if (tool === 'erase') {
          onErase(event)
          return
        }
        if (tool === 'split') {
          event.stopPropagation()
          event.preventDefault()
          if (!snapZero) {
            onSplitAt(event.clientX)
            return
          }
          const bounds = event.currentTarget.getBoundingClientRect()
          const ratio = clipPlayRatio(clip)
          const source = spanRef.current
            ? sampleAtX(spanRef.current, event.clientX - bounds.left, bounds.width)
            : clip.offsetSamples + ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * sourceLen
          const timeline = clip.startSample + (source - clip.offsetSamples) * ratio
          store.splitAt(trackId, clip.id, snapClipTimeline(clip, asset?.channels[0], timeline, true).sample)
          return
        }
        if (tool === 'trim') {
          event.stopPropagation()
          event.preventDefault()
          const bounds = event.currentTarget.getBoundingClientRect()
          const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)
          const zone = trimZone(ratio, coarsePointer(event.pointerType))
          if (zone) pointerDown(event, zone)
          else store.selectClip(trackId, clip.id, false, false)
          return
        }
        if (tool !== 'select') return
        onMove(event)
      }}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest('.take-lane, .edge, .wave-zoom')) return
        event.preventDefault()
        event.stopPropagation()
        if (clip.folder) store.selectClip(trackId, clip.id, false, true)
        else store.openWaveEditor(trackId, clip.id)
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        store.openStems(trackId, clip.id)
      }}
    >
      <WaveformView
        channel={editedOutline ? undefined : asset?.channels[0]}
        outline={editedOutline ?? (asset ? null : outline)}
        bounds={editedOutline ? { start: 0, end: editedOutline.length } : asset ? { start: shown.offsetSamples, end: shown.offsetSamples + sourceLen } : { start: 0, end: outline?.length || 1 }}
        ariaLabel="Clip waveform"
        className="clip-wave"
        color="rgba(255,255,255,0.9)"
        chrome="auto"
        snap={snapZero}
        onSnap={setSnapZero}
        listenRef={clipRef}
        onPinch={(active) => { if (active) pinchLock.current = true }}
        onSpan={(span) => { spanRef.current = span }}
      />
      <em>
        {clip.name}
        {clip.stretch && Math.abs(clip.durationSamples - sourceSamplesOf(clip)) > 1 ? ` ${Math.round((clip.durationSamples / sourceSamplesOf(clip)) * 100)}%` : ''}
        {clip.folder ? ` · ${clip.folder.lanes.length} takes` : ''}
        {clip.source === 'guide' ? ' · guide' : ''}
        {clip.source === 'aligned-take' ? ' · aligned' : ''}
        {clip.spectral?.ops.length ? ' · repair' : ''}
      </em>
      {clip.folder && store.selectedClipId === clip.id && (
        <div className="take-lanes">
          {clip.folder.lanes.map((lane) => {
            const comp = activeComp(clip.folder!)
            return (
              <div
                key={lane.id}
                className="take-lane"
                onPointerDown={(event) => {
                  event.stopPropagation()
                  const bounds = (event.currentTarget.parentElement?.parentElement || event.currentTarget).getBoundingClientRect()
                  const at = (x: number) => clip.startSample + ((x - bounds.left) / Math.max(1, bounds.width)) * clip.durationSamples
                  const origin = at(event.clientX)
                  const move = (ev: PointerEvent) => setSwipe({ laneId: lane.id, from: origin, to: at(ev.clientX) })
                  const up = (ev: PointerEvent) => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                    setSwipe(null)
                    store.swipeTake(trackId, clip.id, lane.id, origin, at(ev.clientX))
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                }}
              >
                <span>{lane.name}</span>
                {swipe?.laneId === lane.id && (
                  <i
                    className="live"
                    style={{
                      left: `${((Math.min(swipe.from, swipe.to) - clip.startSample) / clip.durationSamples) * 100}%`,
                      width: `${(Math.abs(swipe.to - swipe.from) / clip.durationSamples) * 100}%`,
                    }}
                  />
                )}
                {comp.segments.filter((segment) => segment.laneId === lane.id).map((segment, index) => (
                  <i
                    key={`${segment.startSample}-${index}`}
                    style={{
                      left: `${((segment.startSample - clip.startSample) / clip.durationSamples) * 100}%`,
                      width: `${((segment.endSample - segment.startSample) / clip.durationSamples) * 100}%`,
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      )}
      <AnchoredMenu
        open={!!menu}
        onClose={() => setMenu(null)}
        label="Clip"
        anchor={menu ? { left: menu.x, top: menu.y, width: 28, height: 28 } : null}
        prefer="down"
      >
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { if (clip.folder) store.selectClip(trackId, clip.id, false, true); else store.openWaveEditor(trackId, clip.id); setMenu(null) }}>Edit</button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.selectClip(trackId, clip.id, false, true); setMenu(null) }}>Timing</button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onSplit(snapZero); setMenu(null) }}>Split</button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.openStems(trackId, clip.id); setMenu(null) }}>Stems</button>
        <button type="button" title="Spectrogram. Select a spot and remove clicks, hum, or noise." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.openSpectral(trackId, clip.id); setMenu(null) }}>Repair</button>
        <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.deleteSelectedClip(); setMenu(null) }}>Delete</button>
      </AnchoredMenu>
      {(shown.stretch?.markers ?? []).map((marker) => (
        <i key={marker.id} className="warp" style={{ left: `${(marker.source / Math.max(1, sourceLen)) * 100}%` }} />
      ))}
      {fadeIn > 1 && <div className="fade" style={{ left: 0, width: fadeIn }} />}
      {fadeOut > 1 && <div className="fade" style={{ right: 0, width: fadeOut, transform: 'scaleX(-1)' }} />}
      {(tool === 'select' || tool === 'trim') && (
        <ClipEdges
          onStart={(event) => pointerDown(event, 'start')}
          onEnd={(event) => pointerDown(event, 'end')}
        />
      )}
    </div>
    </div>
  )
}

function ClipEdges({
  onStart,
  onEnd,
  startLabel = 'Trim start. Drag to move the beginning. The audio stays put.',
  endLabel = 'Trim end. Drag to change the length. Stops at the recorded audio.',
}: {
  onStart: (event: ReactPointerEvent) => void
  onEnd: (event: ReactPointerEvent) => void
  startLabel?: string
  endLabel?: string
}) {
  return (
    <>
      <div
        className="edge"
        data-edge="start"
        role="button"
        aria-label={startLabel}
        title={startLabel}
        onPointerDown={onStart}
      />
      <div
        className="edge r"
        data-edge="end"
        role="button"
        aria-label={endLabel}
        title={endLabel}
        onPointerDown={onEnd}
      />
    </>
  )
}

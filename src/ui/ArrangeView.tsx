import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { activeComp } from '../model/comp'
import { computePeaks } from '../model/demo'
import { sourceSamplesOf, stretchEdge } from '../audio/stretch/engine'
import { trimAudioClip } from '../model/clips'
import { rectsHit } from '../model/edit'
import { SCALER_MIME, parseScalerDrag } from '../instruments/scaler/model'
import { arrangementEndSample, gridMarks, mapIsLinear, projectBeatSample, projectSampleBeat, pxAtBeat, snapSampleToMap } from '../model/tempoMap'
import { SongMap, SongMapHead, SmartTempoBar } from './SongMap'
import type { AudioClip } from '../model/types'
import { ClipSheet } from './ClipSheet'
import { selectArrange } from '../state/select'
import { TrackReadout } from './AnalysisSheet'
import type { ProjectStore } from '../state/store'
import { activeTool, EDITOR_TOOL_KEYS, subscribeTools, toolClaimsGesture } from '../state/tools'
import { StemSheet } from './StemSheet'
import type { SessionClient } from '../remote/session'
import { AddTrackButton } from './AddTrack'
import { AutoFader, AutomationModeBar, AutomationOverlay, LanePicker, LinkGroup, MixFlags } from './AutomationLane'
import { AutoTuneLaneMark, AutoTuneTrackButton, addOrOpenAutoTune } from './AutoTuneFace'
import { InsertList, RouteFields, SendList } from './PluginSheet'
import { TRACK_ROW, TRACK_SHEET, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { ActionSheet, SheetRow, TipButton } from './Hint'
import { RecordBar } from './RecordBar'
import { coarsePointer, PATTERN_HOLD_SLOP, patternHoldOpensMenu, patternMenuPoint, trimZone } from './touchEdit'

export function ArrangeView({
  store,
  engine,
  session,
  onSeek,
  onOpenPiano,
  onPerform,
  onQuickPunch,
  onAnalyze,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onSeek: (sample: number) => void
  onOpenPiano: (trackId: string, clipId?: string) => void
  onPerform: (mode: 'keys' | 'drums') => void
  onQuickPunch: () => void
  onAnalyze: (trackId: string) => void
}) {
  const project = selectArrange(store).project
  const [px, setPx] = useState(90)
  const pxRef = useRef(px)
  pxRef.current = px
  const [position, setPosition] = useState(engine.positionSamples)
  const [nudge, setNudge] = useState<{ audio: Record<string, number>; midi: Record<string, number>; pattern: Record<string, number> } | null>(null)
  const [patternMenu, setPatternMenu] = useState<{ x: number; y: number } | null>(null)
  const touch = useFormFactor() !== 'desk'
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [ghost, setGhost] = useState<{ trackId: string; left: number; width: number } | null>(null)
  const [tool, setToolState] = useState(activeTool)
  const scroller = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  useEffect(() => subscribeTools(() => setToolState(activeTool())), [])
  useEffect(() => engine.subscribe(() => setPosition(engine.positionSamples)), [engine])
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
      setPx((value) => Math.min(280, Math.max(30, value * factor)))
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
      setPx(Math.min(280, Math.max(30, pinch.px * (dist / pinch.dist))))
      el.scrollLeft = pinch.left - (midX - pinch.x)
      el.scrollTop = pinch.top - (midY - pinch.y)
    }
    const up = (event: PointerEvent) => {
      points.delete(event.pointerId)
      if (points.size < 2) pinch = null
    }
    el.addEventListener('pointerdown', down, true)
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      el.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  const seconds = Math.max(
    16,
    arrangementEndSample(project) / project.sampleRate + 2,
    (project.loopEndSample / project.sampleRate) * 2,
    ...project.tracks.flatMap((t) => t.clips.map((c) => (c.startSample + c.durationSamples) / project.sampleRate + 2)),
  )
  const width = seconds * px
  const linear = mapIsLinear(project)
  const beatPx = (60 / project.tempo) * px
  const marks = gridMarks(project, projectSampleBeat(project, seconds * project.sampleRate) + 1)

  function seekFromEvent(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const sample = ((event.clientX - bounds.left) / px) * project.sampleRate
    onSeek(snapSampleToMap(sample, project))
  }

  function sampleAt(clientX: number) {
    const inner = innerRef.current
    if (!inner) return 0
    return ((clientX - inner.getBoundingClientRect().left) / pxRef.current) * project.sampleRate
  }

  function pointAt(clientX: number, clientY: number) {
    const inner = innerRef.current
    if (!inner) return { x: 0, y: 0 }
    const rect = inner.getBoundingClientRect()
    return { x: clientX - rect.left, y: clientY - rect.top }
  }

  const passive = tool === 'box' || tool === 'pencil' || tool === 'pan' || tool === 'zoom'

  function watch(move: (event: PointerEvent) => void, up: (event: PointerEvent) => void) {
    const end = (event: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      up(event)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
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
        (ev) => setPx(Math.min(280, Math.max(30, start * Math.pow(1.004, ev.clientX - originX)))),
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
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const clip = project.patternClips?.find((item) => item.id === clipId)
    if (!clip) return
    watch(
      () => undefined,
      (ev) => {
        const sample = Math.max(0, sampleAt(ev.clientX))
        const beat = projectSampleBeat(project, project.snap ? snapSampleToMap(sample, project) : sample)
        store.resizePatternClip(clipId, edge, beat)
      },
    )
  }

  function trimMidi(event: ReactPointerEvent, trackId: string, clipId: string, edge: 'start' | 'end', stretch: boolean) {
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const clip = project.tracks.find((track) => track.id === trackId)?.midiClips.find((item) => item.id === clipId)
    if (!clip) return
    watch(
      () => undefined,
      (ev) => {
        const sample = Math.max(0, sampleAt(ev.clientX))
        const beat = projectSampleBeat(project, project.snap ? snapSampleToMap(sample, project) : sample)
        store.resizeMidiClip(trackId, clipId, edge, beat, stretch)
      },
    )
  }

  function moveSelection(event: ReactPointerEvent, kind: 'audio' | 'midi' | 'pattern', trackId: string, clipId: string) {
    event.stopPropagation()
    if (kind === 'pattern') {
      setPatternMenu(null)
      if (touch) event.preventDefault()
    }
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
        if (ids.includes(clip.id) && clip.scene == null) origins.set(clip.id, { trackId, at: clip.startBeat })
      }
    }
    const originX = event.clientX
    const originY = event.clientY
    const started = performance.now()
    const deltas = new Map<string, number>()
    let travel = 0
    watch(
      (ev) => {
        travel = Math.max(travel, Math.hypot(ev.clientX - originX, ev.clientY - originY))
        if (kind === 'pattern' && touch && travel <= PATTERN_HOLD_SLOP) return
        const sampleDelta = ((ev.clientX - originX) / pxRef.current) * project.sampleRate
        const patch: Record<string, number> = {}
        for (const [id, item] of origins) {
          if (kind === 'audio') patch[id] = sampleDelta
          else patch[id] = projectSampleBeat(project, projectBeatSample(project, item.at) + sampleDelta) - item.at
          deltas.set(id, patch[id])
        }
        setNudge(kind === 'audio' ? { audio: patch, midi: {}, pattern: {} } : kind === 'midi' ? { audio: {}, midi: patch, pattern: {} } : { audio: {}, midi: {}, pattern: patch })
      },
      () => {
        setNudge(null)
        if (kind === 'pattern' && patternHoldOpensMenu(touch, performance.now() - started, travel)) {
          store.selectClip(trackId, clipId, false, false)
          setPatternMenu(patternMenuPoint(originX, originY, 168, 56, window.innerWidth, window.innerHeight))
          return
        }
        const moved = [...deltas.values()].some((value) => Math.abs(value) >= (kind === 'audio' ? 1 : 0.01))
        if (!moved) {
          if (additive && wasIn) store.selectClip(trackId, clipId, kind === 'midi', false, true)
          return
        }
        if (kind === 'audio') {
          store.placeAudioClips([...origins].map(([id, item]) => ({ trackId: item.trackId, clipId: id, startSample: item.at + (deltas.get(id) ?? 0) })))
        } else if (kind === 'midi') {
          store.placeMidiClips([...origins].map(([id, item]) => ({ trackId: item.trackId, clipId: id, startBeat: item.at + (deltas.get(id) ?? 0) })))
        } else {
          store.placePatternClips([...origins].map(([id, item]) => ({ clipId: id, startBeat: item.at + (deltas.get(id) ?? 0) })))
        }
      },
    )
  }

  const [trackSheet, setTrackSheet] = useState<string | null>(null)
  const selected = project.tracks.flatMap((track) => track.clips.filter((clip) => clip.id === store.selectedClipId).map((clip) => ({ track, clip })))[0]
  const sheetTrack = project.tracks.find((track) => track.id === trackSheet) || null

  return (
    <div className="arrange-wrap">
      <SmartTempoBar store={store} />
      <AutomationModeBar store={store} />
      <RecordBar store={store} engine={engine} session={session} onQuickPunch={onQuickPunch} />
      <div className="arrange" data-tool={tool}>
      <div className="heads">
        <div className="ruler-gap">
          <SongMapHead store={store} position={position} />
        </div>
        {project.tracks.map((track) => (
          <div className="head" data-track={track.id} key={track.id} style={rowHeight(track, store.selectedClipId, !!store.openLanes[track.id])} onClick={() => store.selectTrack(track.id)}>
            <header>
              <input
                className="name"
                aria-label={`${track.name} name`}
                style={{ color: track.color }}
                value={track.name}
                onChange={(event) => store.updateTrack(track.id, { name: event.target.value })}
              />
              {touch ? (
                <TipButton className="mini" label="Track" hint="Monitor, input, instrument, and removing the track." onClick={(event) => { event.stopPropagation(); setTrackSheet(track.id) }}>
                  ⋮
                </TipButton>
              ) : (
                <>
                  {track.type === 'midi' && (
                    <TipButton className={`mini scaler-open ${store.scalerTrackId === track.id ? 'on' : ''}`} label={copyOf(TRACK_SHEET, 'scaler').label} hint={copyOf(TRACK_SHEET, 'scaler').hint} pressed={store.scalerTrackId === track.id} onClick={(event) => { event.stopPropagation(); store.openScaler(track.id) }}>
                      Scaler
                    </TipButton>
                  )}
                  {track.type === 'midi' && (
                    <TipButton className={`mini rack-open ${store.rackTrackId === track.id ? 'on' : ''}`} label={copyOf(TRACK_SHEET, 'rack').label} hint={copyOf(TRACK_SHEET, 'rack').hint} pressed={store.rackTrackId === track.id} onClick={(event) => { event.stopPropagation(); store.openRack(track.id) }}>
                      Rack
                    </TipButton>
                  )}
                  {track.type === 'midi' && (
                    <TipButton className={`mini patch-open ${store.patchTrackId === track.id ? 'on' : ''}`} label="Patch" hint="Layered patch: synths, samples, grains, and a morph pad." pressed={store.patchTrackId === track.id} onClick={(event) => { event.stopPropagation(); store.openPatch(track.id) }}>
                      Patch
                    </TipButton>
                  )}
                  <TipButton className="mini" label={copyOf(TRACK_SHEET, 'remove').label} hint={copyOf(TRACK_SHEET, 'remove').hint} onClick={(event) => { event.stopPropagation(); store.removeTrack(track.id) }}>
                    ×
                  </TipButton>
                </>
              )}
            </header>
            <div className="row">
              <MixFlags store={store} trackId={track.id} />
              {track.type === 'audio' && <AutoTuneTrackButton store={store} trackId={track.id} />}
              <button type="button" className={`mini auto-open ${store.openLanes[track.id] ? 'on' : ''}`} aria-pressed={!!store.openLanes[track.id]} aria-label="Automation lane" title="Show the automation lane for this track." onClick={(event) => { event.stopPropagation(); store.toggleAutomation(track.id) }}>
                Auto
              </button>
              {(track.type === 'audio' || (track.type === 'midi' && hardwareMidiAllowed(navigator.userAgent))) && (
                <TipButton className={`mini ${track.armed ? 'on-r' : ''}`} label={copyOf(TRACK_ROW, 'arm').label} hint={track.type === 'midi' ? 'Record this instrument from its MIDI input.' : copyOf(TRACK_ROW, 'arm').hint} pressed={track.armed} onClick={() => store.updateTrack(track.id, { armed: !track.armed })}>
                  R
                </TipButton>
              )}
              {!touch && track.type === 'audio' && (
                <TipButton className={`mini ${track.monitor ? 'on-s' : ''}`} label={copyOf(TRACK_SHEET, 'monitor').label} hint={copyOf(TRACK_SHEET, 'monitor').hint} pressed={track.monitor} onClick={() => store.updateTrack(track.id, { monitor: !track.monitor })}>
                  I
                </TipButton>
              )}
              {!touch && track.type === 'midi' && (
                <>
                  <TipButton className="mini" label={copyOf(TRACK_SHEET, 'keys').label} hint={copyOf(TRACK_SHEET, 'keys').hint} onClick={() => onPerform('keys')}>
                    K
                  </TipButton>
                  <TipButton className="mini" label={copyOf(TRACK_SHEET, 'drums').label} hint={copyOf(TRACK_SHEET, 'drums').hint} onClick={() => onPerform('drums')}>
                    D
                  </TipButton>
                </>
              )}
              {!touch && (
                <TipButton className="mini" label="Analyze" hint="Analyze the key, chords, and sections of this track." onClick={(event) => { event.stopPropagation(); onAnalyze(track.id) }}>
                  An
                </TipButton>
              )}
              {!touch && <TrackReadout trackId={track.id} />}
              {!touch && (
                <AutoFader
                  className="slim"
                  store={store}
                  engine={engine}
                  label={`${track.name} volume. How loud this track is.`}
                  value={track.volume}
                  spec={{ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }}
                />
              )}
            </div>
            {!touch && track.type === 'audio' && (
              <select className="input" {...described(copyOf(TRACK_SHEET, 'input'))} value={track.input} onChange={(event) => store.updateTrack(track.id, { input: event.target.value })}>
                <option value="mic">Mic</option>
                <option value="line">Line</option>
                <option value="mic:0">Mic 1</option>
                <option value="mic:1">Mic 2</option>
                <option value="mic:2">Mic 3</option>
                <option value="mic:3">Mic 4</option>
                <option value="none">No input</option>
                {session.state.participants
                  .filter((person) => person.id !== session.state.selfId)
                  .map((person) => (
                    <option key={person.id} value={`remote:${person.id}`}>
                      {person.name} · live
                    </option>
                  ))}
              </select>
            )}
            <LanePicker store={store} trackId={track.id} />
            {!touch && (
              <div className="head-extra">
                <LinkGroup store={store} trackId={track.id} />
                <RouteFields store={store} trackId={track.id} />
                <InsertList store={store} trackId={track.id} />
                <SendList store={store} trackId={track.id} engine={engine} />
              </div>
            )}
          </div>
        ))}
        <AddTrackButton store={store} />
      </div>
      <div
        className="timeline-scroll"
        ref={scroller}
        style={{ touchAction: toolClaimsGesture(tool) ? 'none' : 'pan-x pan-y' }}
        onPointerDown={onTimelineDown}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            setPx((value) => Math.min(280, Math.max(30, value * (event.deltaY > 0 ? 0.9 : 1.1))))
          }
        }}
      >
        <div className="timeline-inner" ref={innerRef} data-px={px} style={{ width }}>
          <SongMap store={store} px={px} width={width} onSeek={onSeek} />
          <div className="ruler" onClick={seekFromEvent}>
            {marks.map((mark) =>
              mark.downbeat ? (
                <span key={mark.beat} style={{ left: pxAtBeat(project, mark.beat, px) }}>
                  {mark.bar}
                </span>
              ) : (
                <i key={mark.beat} style={{ left: pxAtBeat(project, mark.beat, px) }} />
              ),
            )}
          </div>
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
              className="lane"
              data-track={track.id}
              key={track.id}
              style={{ backgroundSize: linear ? `${beatPx}px 100%` : undefined, backgroundImage: linear ? undefined : 'none', ...rowHeight(track, store.selectedClipId, !!store.openLanes[track.id]) }}
              onDoubleClick={(event) => {
                if (track.type !== 'midi') return
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
                if (track.type !== 'midi') return
                const payload = parseScalerDrag(event.dataTransfer.getData(SCALER_MIME) || event.dataTransfer.getData('text/plain'))
                if (!payload) return
                event.preventDefault()
                event.stopPropagation()
                const sample = sampleAt(event.clientX)
                const beat = projectSampleBeat(project, project.snap ? snapSampleToMap(sample, project) : sample)
                store.writeScalerClip(track.id, payload.notes, Math.max(0, beat), payload.name)
              }}
            >
              <AutoTuneLaneMark plugins={track.plugins} />
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
                  onSplitAt={(clientX) => store.splitAt(track.id, clip.id, sampleAt(clientX))}
                  onSplit={() => store.splitSelected(engine.currentTimelineSample())}
                  onErase={beginErase}
                  onMove={(event) => moveSelection(event, 'audio', track.id, clip.id)}
                />
              ))}
              {track.type === 'midi' && track.midiClips.every((clip) => clip.slotOnly) && (
                <button type="button" className="lane-add" aria-label="Add clip" onClick={() => onOpenPiano(track.id)}>+</button>
              )}
              <AutomationOverlay store={store} trackId={track.id} px={px} tool={tool} />
              {track.midiClips.filter((clip) => !clip.slotOnly && clip.scene == null).map((clip) => {
                const beat = clip.startBeat + (nudge?.midi[clip.id] ?? 0)
                const left = pxAtBeat(project, beat, px)
                const widthPx = Math.max(8, pxAtBeat(project, beat + clip.durationBeats, px) - left)
                const picked = store.selectedMidiClipIds.includes(clip.id)
                return (
                  <div
                    key={clip.id}
                    data-clip={clip.id}
                    data-midi="1"
                    data-track={track.id}
                    className={`clip ${picked ? 'selected' : ''}`}
                    style={{ left, width: widthPx, background: track.color, pointerEvents: passive ? 'none' : undefined }}
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
                    onDoubleClick={() => onOpenPiano(track.id, clip.id)}
                  >
                    <em>
                      {clip.name} · {clip.notes.length} notes
                    </em>
                    {(tool === 'select' || tool === 'trim') && (
                      <ClipEdges
                        onStart={(event) => trimMidi(event, track.id, clip.id, 'start', event.altKey)}
                        onEnd={(event) => trimMidi(event, track.id, clip.id, 'end', event.altKey)}
                      />
                    )}
                  </div>
                )
              })}
              {track.id === project.tracks.find((item) => item.type === 'midi')?.id &&
                (project.patternClips ?? [])
                  .filter((clip) => clip.scene == null)
                  .map((clip) => {
                    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
                    const beat = clip.startBeat + (nudge?.pattern[clip.id] ?? 0)
                    const left = pxAtBeat(project, beat, px)
                    const widthPx = Math.max(24, pxAtBeat(project, beat + clip.lengthBeats, px) - left)
                    const picked = store.selectedPatternClipIds.includes(clip.id)
                    return (
                      <div
                        key={clip.id}
                        data-clip={clip.id}
                        data-pattern="1"
                        data-track={track.id}
                        className={`clip pattern ${picked ? 'selected' : ''}`}
                        style={{ left, width: widthPx, background: pattern?.color || track.color, pointerEvents: passive ? 'none' : undefined, touchAction: passive ? undefined : 'none' }}
                        onContextMenu={(event) => event.preventDefault()}
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
                        <em>{pattern?.name || 'Pattern'}</em>
                        {(tool === 'select' || tool === 'trim') && (
                          <ClipEdges
                            startLabel="Trim start. Drag to move the beginning. The pattern stays on the grid."
                            endLabel="Trim end. Drag to change how long the pattern plays."
                            onStart={(event) => trimPattern(event, clip.id, 'start')}
                            onEnd={(event) => trimPattern(event, clip.id, 'end')}
                          />
                        )}
                      </div>
                    )
                  })}
            </div>
          ))}
          {marquee && <div className="marquee" style={marquee} />}
          <div className="playhead" style={{ left: (position / project.sampleRate) * px }} />
        </div>
      </div>
      </div>
      {patternMenu && (
        <div className="touch-menu" style={{ left: patternMenu.x, top: patternMenu.y }}>
          <button type="button" title="Copy this pattern clip and place it just after." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.duplicateSelection(); setPatternMenu(null) }}>Duplicate</button>
          <button type="button" title="Remove this pattern clip from the arrangement." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.deleteSelectedClip(); setPatternMenu(null) }}>Delete</button>
        </div>
      )}
      <StemSheet store={store} />
      {store.clipSheet && selected ? (
        <ClipSheet store={store} trackId={selected.track.id} clip={selected.clip} onClose={() => store.closeClipSheet()} />
      ) : null}
      {touch && sheetTrack && (
        <ActionSheet title={sheetTrack.name} hint="Everything else for this track." onClose={() => setTrackSheet(null)}>
          {sheetTrack.type === 'audio' && (
            <SheetRow
              label={copyOf(TRACK_SHEET, 'monitor').label}
              hint={copyOf(TRACK_SHEET, 'monitor').hint}
              pressed={sheetTrack.monitor}
              onClick={() => store.updateTrack(sheetTrack.id, { monitor: !sheetTrack.monitor })}
            />
          )}
          {sheetTrack.type === 'audio' && (
            <SheetRow
              label="Auto-Tune"
              hint="Add or open Auto-Tune."
              pressed={sheetTrack.plugins.some((plugin) => plugin.pluginId === 'tune' && plugin.enabled)}
              onClick={() => {
                addOrOpenAutoTune(store, sheetTrack.id)
                setTrackSheet(null)
              }}
            />
          )}
          <label className="sheet-range">
            <span>{copyOf(TRACK_SHEET, 'volume').label}</span>
            <small>{copyOf(TRACK_SHEET, 'volume').hint}</small>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              {...described(copyOf(TRACK_SHEET, 'volume'))}
              value={sheetTrack.volume}
              onChange={(event) => store.updateTrack(sheetTrack.id, { volume: Number(event.target.value) })}
            />
          </label>
          {sheetTrack.type === 'audio' && (
            <label className="sheet-range">
              <span>{copyOf(TRACK_SHEET, 'input').label}</span>
              <small>{copyOf(TRACK_SHEET, 'input').hint}</small>
              <select {...described(copyOf(TRACK_SHEET, 'input'))} value={sheetTrack.input} onChange={(event) => store.updateTrack(sheetTrack.id, { input: event.target.value })}>
                <option value="mic">Mic</option>
                <option value="line">Line</option>
                <option value="mic:0">Mic 1</option>
                <option value="mic:1">Mic 2</option>
                <option value="mic:2">Mic 3</option>
                <option value="mic:3">Mic 4</option>
                <option value="none">No input</option>
                {session.state.participants
                  .filter((person) => person.id !== session.state.selfId)
                  .map((person) => (
                    <option key={person.id} value={`remote:${person.id}`}>{person.name} · live</option>
                  ))}
              </select>
            </label>
          )}
          {sheetTrack.type === 'midi' && (
            <>
              <SheetRow label={copyOf(TRACK_SHEET, 'scaler').label} hint={copyOf(TRACK_SHEET, 'scaler').hint} pressed={store.scalerTrackId === sheetTrack.id} onClick={() => { setTrackSheet(null); store.openScaler(sheetTrack.id) }} />
              <SheetRow label={copyOf(TRACK_SHEET, 'rack').label} hint={copyOf(TRACK_SHEET, 'rack').hint} pressed={store.rackTrackId === sheetTrack.id} onClick={() => { setTrackSheet(null); store.openRack(sheetTrack.id) }} />
              <SheetRow label="Patch" hint="Layered patch: synths, samples, grains, and a morph pad." pressed={store.patchTrackId === sheetTrack.id} onClick={() => { setTrackSheet(null); store.openPatch(sheetTrack.id) }} />
              <SheetRow label={copyOf(TRACK_SHEET, 'keys').label} hint={copyOf(TRACK_SHEET, 'keys').hint} onClick={() => { setTrackSheet(null); onPerform('keys') }} />
              <SheetRow label={copyOf(TRACK_SHEET, 'drums').label} hint={copyOf(TRACK_SHEET, 'drums').hint} onClick={() => { setTrackSheet(null); onPerform('drums') }} />
            </>
          )}
          <div className="sheet-fields">
            <RouteFields store={store} trackId={sheetTrack.id} />
            <InsertList store={store} trackId={sheetTrack.id} />
            <SendList store={store} trackId={sheetTrack.id} />
          </div>
          {sheetTrack.type === 'audio' && (
            <SheetRow
              label="Repair"
              hint="Spectrogram. Select a spot and remove clicks, hum, or noise."
              onClick={() => {
                const clip = sheetTrack.clips.find((item) => item.id === store.selectedClipId) ?? sheetTrack.clips[0]
                setTrackSheet(null)
                if (clip) store.openSpectral(sheetTrack.id, clip.id)
              }}
            />
          )}
          <SheetRow label="Analyze" hint="Analyze the key, chords, and sections of this track." onClick={() => { setTrackSheet(null); onAnalyze(sheetTrack.id) }} />
          <SheetRow label={copyOf(TRACK_SHEET, 'remove').label} hint={copyOf(TRACK_SHEET, 'remove').hint} onClick={() => { store.removeTrack(sheetTrack.id); setTrackSheet(null) }} />
        </ActionSheet>
      )}
    </div>
  )
}

function laneStyle(track: { clips: AudioClip[] }, selectedId: string | null): { height?: number } {
  const open = track.clips.find((clip) => clip.id === selectedId && clip.folder)
  if (!open?.folder) return {}
  return { height: Math.max(168, 40 + open.folder.lanes.length * 48) }
}

function rowHeight(track: { clips: AudioClip[] }, selectedId: string | null, automation: boolean) {
  const base = laneStyle(track, selectedId)
  if (!automation) return base
  return { height: Math.max(base.height ?? 150, 236) }
}

function ClipView({
  store,
  clip,
  trackId,
  px,
  tool,
  shift,
  passive,
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
  onSplitAt: (clientX: number) => void
  onSplit: () => void
  onErase: (event: ReactPointerEvent) => void
  onMove: (event: ReactPointerEvent) => void
}) {
  const project = selectArrange(store).project
  const asset = store.buffers.get(clip.bufferId)
  const [preview, setPreview] = useState<AudioClip | null>(null)
  const ghost = store.quantizePreview?.audio.find((item) => item.clipId === clip.id)?.clip
  const shown = preview ?? ghost ?? clip
  const left = ((shown.startSample + (preview ? 0 : shift)) / project.sampleRate) * px
  const width = Math.max(8, (shown.durationSamples / project.sampleRate) * px)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [swipe, setSwipe] = useState<{ laneId: string; from: number; to: number } | null>(null)
  const outline = project.waveforms?.[clip.bufferId]
  const sourceLen = sourceSamplesOf(shown)
  const peaks = useMemo(() => {
    if (asset?.channels[0]?.length) {
      const slice = asset.channels[0].subarray(shown.offsetSamples, Math.min(asset.channels[0].length, shown.offsetSamples + sourceLen))
      return computePeaks(slice, Math.max(8, Math.round(width)))
    }
    return outline || []
  }, [asset, outline, shown.offsetSamples, sourceLen, width])

  useEffect(() => {
    const node = canvas.current
    if (!node || !peaks.length) return
    const columns = Math.max(8, Math.round(width))
    node.width = columns
    node.height = 64
    const ctx = node.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, node.width, node.height)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    for (let x = 0; x < columns; x++) {
      const peak = peaks[Math.min(peaks.length - 1, Math.floor((x * peaks.length) / columns))]
      if (!peak) continue
      const y1 = (1 - peak.max) * 32
      const y2 = (1 - peak.min) * 32
      ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
    }
  }, [peaks, width])

  function pointerDown(event: ReactPointerEvent, mode: 'move' | 'start' | 'end') {
    if (event.button === 2) return
    event.stopPropagation()
    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)
    store.selectClip(trackId, clip.id, false, false)
    const originX = event.clientX
    const originY = event.clientY
    const stretching = event.altKey
    let latest: AudioClip | null = null
    let held = false
    const timer = mode === 'move'
      ? window.setTimeout(() => {
          held = true
          setMenu({ x: originX, y: originY })
        }, 480)
      : 0
    const snapped = (value: number) => snapSampleToMap(value, project)
    const bufferLength = asset?.channels[0]?.length ?? clip.offsetSamples + clip.durationSamples
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - originX) > 8 || Math.abs(ev.clientY - originY) > 8) window.clearTimeout(timer)
      if (held) return
      const delta = ((ev.clientX - originX) / px) * project.sampleRate
      if (mode === 'move') latest = { ...clip, startSample: snapped(clip.startSample + delta) }
      if (mode === 'start' && stretching) latest = stretchEdge(clip, 'start', snapped(clip.startSample + delta))
      if (mode === 'start' && !stretching) latest = trimAudioClip(clip, 'start', snapped(clip.startSample + delta), bufferLength)
      if (mode === 'end' && stretching) latest = stretchEdge(clip, 'end', snapped(clip.startSample + clip.durationSamples + delta))
      if (mode === 'end' && !stretching) latest = trimAudioClip(clip, 'end', snapped(clip.startSample + clip.durationSamples + delta), bufferLength)
      setPreview(latest)
    }
    const up = (ev: PointerEvent) => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const dropped = Number.isFinite(ev.clientX) ? document.elementFromPoint(ev.clientX, ev.clientY)?.closest('[data-slot-drop]') : null
      if (dropped) {
        window.dispatchEvent(new CustomEvent('cueharbor-slot-clip', { detail: { trackId, clipId: clip.id } }))
        setPreview(null)
        return
      }
      if (held) {
        setPreview(null)
        return
      }
      const next = latest
      setPreview(null)
      if (held) return
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
      if (!stretching && mode === 'start') store.trimClip(trackId, clip.id, 'start', next.startSample)
      if (!stretching && mode === 'end') store.trimClip(trackId, clip.id, 'end', next.startSample + next.durationSamples)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  const fadeIn = (shown.fadeInSamples / project.sampleRate) * px
  const fadeOut = (shown.fadeOutSamples / project.sampleRate) * px
  return (
    <div
      data-clip={clip.id}
      data-track={trackId}
      className={`clip ${store.selectedClipIds.includes(clip.id) ? 'selected' : ''} ${clip.folder && store.selectedClipId === clip.id ? 'open' : ''}`}
      style={{ left, width, background: store.project.tracks.find((t) => t.id === trackId)?.color, pointerEvents: passive ? 'none' : undefined }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('.take-lane, .edge')) return
        if (tool === 'erase') {
          onErase(event)
          return
        }
        if (tool === 'split') {
          event.stopPropagation()
          event.preventDefault()
          onSplitAt(event.clientX)
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
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        store.openStems(trackId, clip.id)
      }}
    >
      <canvas ref={canvas} />
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
      {menu && (
        <div className="touch-menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { onSplit(); setMenu(null) }}>Split</button>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.openStems(trackId, clip.id); setMenu(null) }}>Stems</button>
          <button type="button" title="Spectrogram. Select a spot and remove clicks, hum, or noise." onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.openSpectral(trackId, clip.id); setMenu(null) }}>Repair</button>
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.deleteSelectedClip(); setMenu(null) }}>Delete</button>
        </div>
      )}
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

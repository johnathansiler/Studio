import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { activeComp } from '../model/comp'
import { computePeaks } from '../model/demo'
import { sourceSamplesOf, stretchEdge } from '../audio/stretch/engine'
import { snapSample } from '../model/time'
import type { AudioClip } from '../model/types'
import { ClipSheet } from './ClipSheet'
import type { ProjectStore } from '../state/store'
import type { SessionClient } from '../remote/session'
import { AddTrackButton } from './AddTrack'
import { InsertList, RouteFields, SendList } from './PluginSheet'

export function ArrangeView({
  store,
  engine,
  session,
  onSeek,
  onOpenPiano,
  onPerform,
  onQuickPunch,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onSeek: (sample: number) => void
  onOpenPiano: (trackId: string, clipId?: string) => void
  onPerform: (mode: 'keys' | 'drums') => void
  onQuickPunch: () => void
}) {
  const project = store.project
  const [px, setPx] = useState(90)
  const pxRef = useRef(px)
  pxRef.current = px
  const [position, setPosition] = useState(engine.positionSamples)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => engine.subscribe(() => setPosition(engine.positionSamples)), [engine])
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
    let startDist = 0
    let startPx = pxRef.current
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        startDist = distance(event.touches)
        startPx = pxRef.current
      }
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !startDist) return
      event.preventDefault()
      const next = startPx * (distance(event.touches) / startDist)
      setPx(Math.min(280, Math.max(30, next)))
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
    }
  }, [])

  const seconds = Math.max(16, (project.loopEndSample / project.sampleRate) * 2, ...project.tracks.flatMap((t) => t.clips.map((c) => (c.startSample + c.durationSamples) / project.sampleRate + 2)))
  const width = seconds * px
  const beatPx = (60 / project.tempo) * px

  function seekFromEvent(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const sample = ((event.clientX - bounds.left) / px) * project.sampleRate
    onSeek(snapSample(sample, project.sampleRate, project.tempo, project.snap))
  }

  const selected = project.tracks.flatMap((track) => track.clips.filter((clip) => clip.id === store.selectedClipId).map((clip) => ({ track, clip })))[0]
  const record = store.recordSettings()
  const selectedFolder = project.tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip }))).find((item) => item.clip.id === store.selectedClipId && item.clip.folder)
  const selectedMidi = project.tracks.flatMap((track) => track.midiClips.map((clip) => ({ track, clip }))).find((item) => item.clip.id === store.selectedMidiClipId)

  return (
    <div className="arrange-wrap">
      <div className="tool-row" role="toolbar" aria-label="Tools">
        <button
          type="button"
          className={store.tool === 'stretch' ? 'on' : ''}
          aria-pressed={store.tool === 'stretch'}
          onClick={() => store.setTool(store.tool === 'stretch' ? 'pointer' : 'stretch')}
        >
          Stretch
        </button>
      </div>
      <div className="rec-bar" role="group" aria-label="Recording">
        <button type="button" className={record.loop ? 'on' : ''} onClick={() => {
          const next = !record.loop
          store.setRecord({ loop: next })
          if (next) store.setLoop(true, project.loopStartSample, project.loopEndSample)
        }}>Cycle</button>
        <button type="button" className={record.punchEnabled ? 'on' : ''} onClick={() => store.setRecord({ punchEnabled: !record.punchEnabled, quick: false })}>Punch</button>
        <button type="button" onClick={() => store.setRecord({ punchIn: Math.round(engine.currentTimelineSample()) })}>In</button>
        <button type="button" onClick={() => store.setRecord({ punchOut: Math.round(engine.currentTimelineSample()) })}>Out</button>
        <button type="button" onClick={onQuickPunch}>Quick</button>
        <label>Pre
          <input inputMode="decimal" value={record.preRoll} onChange={(event) => store.setRecord({ preRoll: Number(event.target.value) || 0 })} />
        </label>
        <label>Post
          <input inputMode="decimal" value={record.postRoll} onChange={(event) => store.setRecord({ postRoll: Number(event.target.value) || 0 })} />
        </label>
        <select value={record.rollUnit} onChange={(event) => store.setRecord({ rollUnit: event.target.value === 'seconds' ? 'seconds' : 'bars' })} aria-label="Roll unit">
          <option value="bars">Bars</option>
          <option value="seconds">Seconds</option>
        </select>
        {project.tracks.find((track) => track.id === store.selectedTrackId)?.type === 'audio' && (
          <select
            aria-label="Track input"
            value={project.tracks.find((track) => track.id === store.selectedTrackId)?.input || 'mic'}
            onChange={(event) => {
              const track = project.tracks.find((item) => item.id === store.selectedTrackId)
              if (track) store.updateTrack(track.id, { input: event.target.value })
            }}
          >
            <option value="mic">Mic · all</option>
            <option value="mic:0">Mic 1</option>
            <option value="mic:1">Mic 2</option>
            <option value="mic:2">Mic 3</option>
            <option value="mic:3">Mic 4</option>
            <option value="none">No input</option>
            {session.state.participants
              .filter((person) => person.id !== session.state.selfId)
              .map((person) => (
                <option key={person.id} value={`remote:${person.id}`}>{person.name}</option>
              ))}
          </select>
        )}
        <select value={record.midiLoop} onChange={(event) => store.setRecord({ midiLoop: event.target.value === 'merge' ? 'merge' : 'takes' })} aria-label="MIDI loop mode">
          <option value="takes">MIDI takes</option>
          <option value="merge">MIDI merge</option>
        </select>
        {selectedMidi && (
          <button type="button" onClick={() => store.commitMidiPass(selectedMidi.track.id, selectedMidi.clip.id, selectedMidi.clip.notes)}>Save MIDI take</button>
        )}
        {selectedMidi?.clip.takes && selectedMidi.clip.takes.length > 0 && (
          <select aria-label="MIDI take" value={selectedMidi.clip.activeTakeId || ''} onChange={(event) => store.recallMidi(selectedMidi.track.id, selectedMidi.clip.id, event.target.value)}>
            {selectedMidi.clip.takes.map((take) => (
              <option key={take.id} value={take.id}>{take.name}</option>
            ))}
          </select>
        )}
        {selectedFolder?.clip.folder && (
          <>
            <select
              aria-label="Comp"
              value={selectedFolder.clip.folder.activeCompId}
              onChange={(event) => store.recallTakeComp(selectedFolder.track.id, selectedFolder.clip.id, event.target.value)}
            >
              {selectedFolder.clip.folder.comps.map((comp) => (
                <option key={comp.id} value={comp.id}>{comp.name}</option>
              ))}
            </select>
            <button type="button" onClick={() => store.saveTakeComp(selectedFolder.track.id, selectedFolder.clip.id)}>Save comp</button>
            <button type="button" onClick={() => store.flattenTakes(selectedFolder.track.id, selectedFolder.clip.id, false)}>Flatten</button>
            <button type="button" onClick={() => store.flattenTakes(selectedFolder.track.id, selectedFolder.clip.id, true)}>Merge</button>
          </>
        )}
      </div>
      <div className="arrange">
      <div className="heads">
        <div className="ruler-gap" />
        {project.tracks.map((track) => (
          <div className="head" data-track={track.id} key={track.id} style={laneStyle(track, store.selectedClipId)} onClick={() => store.selectTrack(track.id)}>
            <header>
              <input
                className="name"
                style={{ color: track.color }}
                value={track.name}
                onChange={(event) => store.updateTrack(track.id, { name: event.target.value })}
              />
              {track.type === 'midi' && (
                <button className={`mini rack-open ${store.rackTrackId === track.id ? 'on' : ''}`} onClick={(event) => { event.stopPropagation(); store.openRack(track.id) }}>Rack</button>
              )}
              <button className="mini" onClick={() => store.removeTrack(track.id)} title="Remove track">
                ×
              </button>
            </header>
            <div className="row">
              <button className={`mini ${track.mute ? 'on-m' : ''}`} onClick={() => store.updateTrack(track.id, { mute: !track.mute })}>
                M
              </button>
              <button className={`mini ${track.solo ? 'on-s' : ''}`} onClick={() => store.updateTrack(track.id, { solo: !track.solo })}>
                S
              </button>
              {track.type === 'audio' && (
                <button className={`mini ${track.armed ? 'on-r' : ''}`} onClick={() => store.updateTrack(track.id, { armed: !track.armed })}>
                  R
                </button>
              )}
              {track.type === 'audio' && (
                <button className={`mini ${track.monitor ? 'on-s' : ''}`} title="Input monitor" onClick={() => store.updateTrack(track.id, { monitor: !track.monitor })}>
                  I
                </button>
              )}
              {track.type === 'midi' && (
                <>
                  <button className="mini" title="Piano roll" onClick={() => onPerform('keys')}>K</button>
                  <button className="mini" title="Drum machine" onClick={() => onPerform('drums')}>D</button>
                </>
              )}
              <input
                className="slim"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={track.volume}
                onChange={(event) => store.updateTrack(track.id, { volume: Number(event.target.value) })}
              />
            </div>
            {track.type === 'audio' && (
              <select className="input" value={track.input} onChange={(event) => store.updateTrack(track.id, { input: event.target.value })}>
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
            <div className="head-extra">
              <RouteFields store={store} trackId={track.id} />
              <InsertList store={store} trackId={track.id} />
              <SendList store={store} trackId={track.id} />
            </div>
          </div>
        ))}
        <AddTrackButton store={store} />
      </div>
      <div
        className="timeline-scroll"
        ref={scroller}
        onWheel={(event) => {
          if (event.ctrlKey || event.metaKey) {
            event.preventDefault()
            setPx((value) => Math.min(280, Math.max(30, value * (event.deltaY > 0 ? 0.9 : 1.1))))
          }
        }}
      >
        <div className="timeline-inner" style={{ width }}>
          <div
            className="ruler"
            onClick={seekFromEvent}
            style={{ backgroundImage: `linear-gradient(to right, rgba(255,255,255,0.08) 1px, transparent 1px)`, backgroundSize: `${beatPx}px 100%` }}
          >
            {Array.from({ length: Math.ceil(seconds / (60 / project.tempo)) + 1 }, (_, beat) =>
              beat % project.timeSignature.numerator === 0 ? (
                <span key={beat} style={{ left: beat * beatPx }}>
                  {beat / project.timeSignature.numerator + 1}
                </span>
              ) : (
                <i key={beat} style={{ left: beat * beatPx }} />
              ),
            )}
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
              style={{ backgroundSize: `${beatPx}px 100%`, ...laneStyle(track, store.selectedClipId) }}
              onDoubleClick={(event) => {
                if (track.type !== 'midi') return
                const bounds = event.currentTarget.getBoundingClientRect()
                const beat = ((event.clientX - bounds.left) / px) * (project.tempo / 60)
                store.addMidiClip(track.id, Math.floor(beat))
              }}
            >
              {track.clips.filter((clip) => !clip.slotOnly).map((clip) => (
                <ClipView key={clip.id} store={store} clip={clip} trackId={track.id} px={px} onSplit={() => store.splitSelected(engine.currentTimelineSample())} />
              ))}
              {track.type === 'midi' && track.midiClips.every((clip) => clip.slotOnly) && (
                <button type="button" className="lane-add" aria-label="Add clip" onClick={() => onOpenPiano(track.id)}>+</button>
              )}
              {track.midiClips.filter((clip) => !clip.slotOnly && clip.scene == null).map((clip) => {
                const left = ((clip.startBeat * 60) / project.tempo) * px
                const widthPx = ((clip.durationBeats * 60) / project.tempo) * px
                return (
                  <div
                    key={clip.id}
                    className={`clip ${store.selectedMidiClipId === clip.id ? 'selected' : ''}`}
                    style={{ left, width: widthPx, background: track.color }}
                    onClick={() => onOpenPiano(track.id, clip.id)}
                  >
                    <em>
                      {clip.name} · {clip.notes.length} notes
                    </em>
                  </div>
                )
              })}
              {track.id === project.tracks.find((item) => item.type === 'midi')?.id &&
                (project.patternClips ?? [])
                  .filter((clip) => clip.scene == null)
                  .map((clip) => {
                    const pattern = project.beats?.patterns.find((item) => item.id === clip.patternId)
                    const left = ((clip.startBeat * 60) / project.tempo) * px
                    const widthPx = Math.max(24, ((clip.lengthBeats * 60) / project.tempo) * px)
                    return (
                      <div key={clip.id} className="clip pattern" style={{ left, width: widthPx, background: pattern?.color || track.color }}>
                        <em>{pattern?.name || 'Pattern'}</em>
                      </div>
                    )
                  })}
            </div>
          ))}
          <div className="playhead" style={{ left: (position / project.sampleRate) * px }} />
        </div>
      </div>
      </div>
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

function ClipView({ store, clip, trackId, px, onSplit }: { store: ProjectStore; clip: AudioClip; trackId: string; px: number; onSplit: () => void }) {
  const project = store.project
  const asset = store.buffers.get(clip.bufferId)
  const [preview, setPreview] = useState<AudioClip | null>(null)
  const ghost = store.quantizePreview?.audio.find((item) => item.clipId === clip.id)?.clip
  const shown = preview ?? ghost ?? clip
  const left = (shown.startSample / project.sampleRate) * px
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
    event.stopPropagation()
    store.selectClip(trackId, clip.id)
    const originX = event.clientX
    const originY = event.clientY
    const stretching = mode !== 'move' && (store.tool === 'stretch' || event.altKey)
    let latest: AudioClip | null = null
    let held = false
    const timer = window.setTimeout(() => {
      held = true
      setMenu({ x: originX, y: originY })
    }, 480)
    const snapped = (value: number) => snapSample(value, project.sampleRate, project.tempo, project.snap)
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - originX) > 8 || Math.abs(ev.clientY - originY) > 8) window.clearTimeout(timer)
      if (held) return
      const delta = ((ev.clientX - originX) / px) * project.sampleRate
      if (mode === 'move') latest = { ...clip, startSample: snapped(clip.startSample + delta) }
      if (mode === 'start' && stretching) latest = stretchEdge(clip, 'start', snapped(clip.startSample + delta))
      if (mode === 'start' && !stretching) {
        const start = snapped(clip.startSample + delta)
        const shift = start - clip.startSample
        latest = { ...clip, startSample: start, offsetSamples: clip.offsetSamples + shift, durationSamples: clip.durationSamples - shift }
      }
      if (mode === 'end' && stretching) latest = stretchEdge(clip, 'end', snapped(clip.startSample + clip.durationSamples + delta))
      if (mode === 'end' && !stretching) latest = { ...clip, durationSamples: Math.max(64, snapped(clip.durationSamples + delta)) }
      setPreview(latest)
    }
    const up = () => {
      window.clearTimeout(timer)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (held) {
        setPreview(null)
        return
      }
      const next = latest
      setPreview(null)
      if (!next) return
      if (mode === 'move') store.moveClip(trackId, clip.id, next.startSample)
      if (stretching && mode === 'start') store.stretchClip(trackId, clip.id, 'start', next.startSample)
      if (stretching && mode === 'end') store.stretchClip(trackId, clip.id, 'end', next.startSample + next.durationSamples)
      if (!stretching && mode === 'start') store.trimClip(trackId, clip.id, 'start', next.startSample)
      if (!stretching && mode === 'end') store.trimClip(trackId, clip.id, 'end', next.startSample + next.durationSamples)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const fadeIn = (shown.fadeInSamples / project.sampleRate) * px
  const fadeOut = (shown.fadeOutSamples / project.sampleRate) * px
  return (
    <div
      className={`clip ${store.selectedClipId === clip.id ? 'selected' : ''} ${clip.folder && store.selectedClipId === clip.id ? 'open' : ''}`}
      style={{ left, width, background: store.project.tracks.find((t) => t.id === trackId)?.color }}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('.take-lane')) return
        pointerDown(event, 'move')
      }}
    >
      <canvas ref={canvas} />
      <em>
        {clip.name}
        {clip.stretch && Math.abs(clip.durationSamples - sourceSamplesOf(clip)) > 1 ? ` ${Math.round((clip.durationSamples / sourceSamplesOf(clip)) * 100)}%` : ''}
        {clip.folder ? ` · ${clip.folder.lanes.length} takes` : ''}
        {clip.source === 'guide' ? ' · guide' : ''}
        {clip.source === 'aligned-take' ? ' · aligned' : ''}
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
          <button type="button" onPointerDown={(event) => event.stopPropagation()} onClick={() => { store.deleteSelectedClip(); setMenu(null) }}>Delete</button>
        </div>
      )}
      {(shown.stretch?.markers ?? []).map((marker) => (
        <i key={marker.id} className="warp" style={{ left: `${(marker.source / Math.max(1, sourceLen)) * 100}%` }} />
      ))}
      {fadeIn > 1 && <div className="fade" style={{ left: 0, width: fadeIn }} />}
      {fadeOut > 1 && <div className="fade" style={{ right: 0, width: fadeOut, transform: 'scaleX(-1)' }} />}
      <div className="edge" onPointerDown={(event) => pointerDown(event, 'start')} />
      <div className="edge r" onPointerDown={(event) => pointerDown(event, 'end')} />
    </div>
  )
}

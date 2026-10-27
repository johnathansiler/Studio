import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
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
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onSeek: (sample: number) => void
  onOpenPiano: (trackId: string, clipId?: string) => void
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
      <div className="arrange">
      <div className="heads">
        <div className="ruler-gap" />
        {project.tracks.map((track) => (
          <div className="head" data-track={track.id} key={track.id} onClick={() => store.selectTrack(track.id)}>
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
              <select value={track.input} onChange={(event) => store.updateTrack(track.id, { input: event.target.value })}>
                <option value="mic">Mic</option>
                <option value="line">Line</option>
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
              style={{ backgroundSize: `${beatPx}px 100%` }}
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
              {track.midiClips.filter((clip) => !clip.slotOnly).map((clip) => {
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

function ClipView({ store, clip, trackId, px, onSplit }: { store: ProjectStore; clip: AudioClip; trackId: string; px: number; onSplit: () => void }) {
  const project = store.project
  const asset = store.buffers.get(clip.bufferId)
  const [preview, setPreview] = useState<AudioClip | null>(null)
  const shown = preview ?? clip
  const left = (shown.startSample / project.sampleRate) * px
  const width = Math.max(8, (shown.durationSamples / project.sampleRate) * px)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
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
      className={`clip ${store.selectedClipId === clip.id ? 'selected' : ''}`}
      style={{ left, width, background: store.project.tracks.find((t) => t.id === trackId)?.color }}
      onPointerDown={(event) => pointerDown(event, 'move')}
    >
      <canvas ref={canvas} />
      <em>
        {clip.name}
        {clip.stretch && Math.abs(clip.durationSamples - sourceSamplesOf(clip)) > 1 ? ` ${Math.round((clip.durationSamples / sourceSamplesOf(clip)) * 100)}%` : ''}
        {clip.source === 'guide' ? ' · guide' : ''}
        {clip.source === 'aligned-take' ? ' · aligned' : ''}
      </em>
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

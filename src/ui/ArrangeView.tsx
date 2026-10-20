import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { computePeaks } from '../model/demo'
import { snapSample } from '../model/time'
import type { AudioClip } from '../model/types'
import type { ProjectStore } from '../state/store'
import type { SessionClient } from '../remote/session'

export function ArrangeView({
  store,
  engine,
  session,
  onSeek,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onSeek: (sample: number) => void
}) {
  const project = store.project
  const [px, setPx] = useState(90)
  const [position, setPosition] = useState(engine.positionSamples)
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => engine.subscribe(() => setPosition(engine.positionSamples)), [engine])

  const seconds = Math.max(16, (project.loopEndSample / project.sampleRate) * 2, ...project.tracks.flatMap((t) => t.clips.map((c) => (c.startSample + c.durationSamples) / project.sampleRate + 2)))
  const width = seconds * px
  const beatPx = (60 / project.tempo) * px

  function seekFromEvent(event: MouseEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect()
    const sample = ((event.clientX - bounds.left) / px) * project.sampleRate
    onSeek(snapSample(sample, project.sampleRate, project.tempo, project.snap))
  }

  return (
    <div className="arrange-wrap">
      {store.remoteFollow && <div className="follow-banner">Following the host. Play, stop, and locate are shared. Clip edits stay on the host.</div>}
      <div className="arrange">
      <div className="heads">
        <div className="ruler-gap" />
        {project.tracks.map((track) => (
          <div className="head" key={track.id} onClick={() => store.selectTrack(track.id)}>
            <header>
              <input
                className="name"
                style={{ color: track.color }}
                value={track.name}
                onChange={(event) => store.updateTrack(track.id, { name: event.target.value })}
              />
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
            {track.type === 'audio' ? (
              <select value={track.input} onChange={(event) => store.updateTrack(track.id, { input: event.target.value })}>
                <option value="mic">Mic · raw</option>
                <option value="none">No input</option>
                {session.state.participants
                  .filter((person) => person.id !== session.state.selfId)
                  .map((person) => (
                    <option key={person.id} value={`remote:${person.id}`}>
                      {person.name} · live
                    </option>
                  ))}
              </select>
            ) : (
              <span className="hint">Instrument</span>
            )}
          </div>
        ))}
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
              key={track.id}
              style={{ backgroundSize: `${beatPx}px 100%` }}
              onDoubleClick={(event) => {
                if (track.type !== 'midi') return
                const bounds = event.currentTarget.getBoundingClientRect()
                const beat = ((event.clientX - bounds.left) / px) * (project.tempo / 60)
                store.addMidiClip(track.id, Math.floor(beat))
              }}
            >
              {track.clips.map((clip) => (
                <ClipView key={clip.id} store={store} clip={clip} trackId={track.id} px={px} />
              ))}
              {track.midiClips.map((clip) => {
                const left = ((clip.startBeat * 60) / project.tempo) * px
                const widthPx = ((clip.durationBeats * 60) / project.tempo) * px
                return (
                  <div
                    key={clip.id}
                    className={`clip ${store.selectedMidiClipId === clip.id ? 'selected' : ''}`}
                    style={{ left, width: widthPx, background: track.color }}
                    onClick={() => store.selectClip(track.id, clip.id, true)}
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
    </div>
  )
}

function ClipView({ store, clip, trackId, px }: { store: ProjectStore; clip: AudioClip; trackId: string; px: number }) {
  const project = store.project
  const asset = store.buffers.get(clip.bufferId)
  const [preview, setPreview] = useState<AudioClip | null>(null)
  const shown = preview ?? clip
  const left = (shown.startSample / project.sampleRate) * px
  const width = Math.max(8, (shown.durationSamples / project.sampleRate) * px)
  const canvas = useRef<HTMLCanvasElement>(null)
  const peaks = useMemo(() => {
    if (!asset) return []
    const slice = asset.channels[0].subarray(shown.offsetSamples, shown.offsetSamples + shown.durationSamples)
    return computePeaks(slice, Math.max(8, Math.round(width)))
  }, [asset, shown.offsetSamples, shown.durationSamples, width])

  useEffect(() => {
    const node = canvas.current
    if (!node) return
    node.width = Math.max(8, Math.round(width))
    node.height = 64
    const ctx = node.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, node.width, node.height)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    peaks.forEach((peak, index) => {
      const y1 = (1 - peak.max) * 32
      const y2 = (1 - peak.min) * 32
      ctx.fillRect(index, y1, 1, Math.max(1, y2 - y1))
    })
  }, [peaks, width])

  function pointerDown(event: ReactPointerEvent, mode: 'move' | 'start' | 'end') {
    event.stopPropagation()
    store.selectClip(trackId, clip.id)
    const originX = event.clientX
    let latest: AudioClip | null = null
    const snapped = (value: number) => snapSample(value, project.sampleRate, project.tempo, project.snap)
    const move = (ev: PointerEvent) => {
      const delta = ((ev.clientX - originX) / px) * project.sampleRate
      if (mode === 'move') latest = { ...clip, startSample: snapped(clip.startSample + delta) }
      if (mode === 'start') {
        const start = snapped(clip.startSample + delta)
        const shift = start - clip.startSample
        latest = { ...clip, startSample: start, offsetSamples: clip.offsetSamples + shift, durationSamples: clip.durationSamples - shift }
      }
      if (mode === 'end') latest = { ...clip, durationSamples: Math.max(64, snapped(clip.durationSamples + delta)) }
      setPreview(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const next = latest
      setPreview(null)
      if (!next) return
      if (mode === 'move') store.moveClip(trackId, clip.id, next.startSample)
      if (mode === 'start') store.trimClip(trackId, clip.id, 'start', next.startSample)
      if (mode === 'end') store.trimClip(trackId, clip.id, 'end', next.startSample + next.durationSamples)
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
        {clip.source === 'guide' ? ' · guide' : ''}
        {clip.source === 'aligned-take' ? ' · aligned' : ''}
      </em>
      {fadeIn > 1 && <div className="fade" style={{ left: 0, width: fadeIn }} />}
      {fadeOut > 1 && <div className="fade" style={{ right: 0, width: fadeOut, transform: 'scaleX(-1)' }} />}
      <div className="edge" onPointerDown={(event) => pointerDown(event, 'start')} />
      <div className="edge r" onPointerDown={(event) => pointerDown(event, 'end')} />
    </div>
  )
}

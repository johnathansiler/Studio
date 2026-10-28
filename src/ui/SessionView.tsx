import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { LAUNCH_QUANTS, QUANT_LABEL, sceneClip } from '../model/launch'
import { clipLoopSamples, slotDisplay } from '../model/sessionSlots'
import {
  clipPaint,
  instrumentFor,
  midiKind,
  parseDeviceDrag,
  sceneTitle,
  sessionPanes,
  sessionTracks,
} from '../model/sessionBoard'
import type { LaunchQuant, Track } from '../model/types'
import { selectSession } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { useFormFactor } from './form'
import { dropLibrarySound, SessionBrowser, soundById } from './sessionBrowser'
import { SessionDetail } from './sessionDetail'
import './sessionGrid.css'
import './sessionLive.css'

const CLIP_DRAG = /^cueharbor-clip:([^:]+):([^:]+)$/

export function SessionView({
  store,
  engine,
  onRecord,
  onDropAudio,
}: {
  store: ProjectStore
  engine: AudioEngine
  onRecord: () => void
  onDropAudio: (trackId: string, scene: number, file: File) => void
}) {
  return <SessionBody key={store.project.id} store={store} engine={engine} onRecord={onRecord} onDropAudio={onDropAudio} />
}

function SessionBody({
  store,
  engine,
  onRecord,
  onDropAudio,
}: {
  store: ProjectStore
  engine: AudioEngine
  onRecord: () => void
  onDropAudio: (trackId: string, scene: number, file: File) => void
}) {
  const grid = selectSession(store)
  const phone = useFormFactor() === 'phone'
  const panes = sessionPanes(phone)
  const [browserOn, setBrowserOn] = useState(panes.browser)
  const [detailOn, setDetailOn] = useState(panes.detail)
  const [mixerOn, setMixerOn] = useState(panes.mixer)
  const [browserW, setBrowserW] = useState(220)
  const [detailH, setDetailH] = useState(320)
  const [levels, setLevels] = useState<{ master: number; tracks: Record<string, number> }>({ master: 0, tracks: {} })
  const [now, setNow] = useState(() => engine.currentTimelineSample())
  const clickTimer = useRef(0)
  const tracks = sessionTracks(grid.tracks)
  const quant = grid.project.launchQuant ?? '1bar'
  const focus = store.sessionEdit
  const focusTrack = tracks.find((track) => track.id === (focus?.trackId ?? store.selectedTrackId)) ?? tracks[0] ?? null
  const pane = !phone ? 'grid' : browserOn ? 'browser' : detailOn ? 'detail' : 'grid'

  useEffect(() => {
    const next = sessionPanes(phone)
    setBrowserOn(next.browser)
    setDetailOn(next.detail)
    setMixerOn(next.mixer)
  }, [phone])

  useEffect(() => {
    let frame = 0
    const tick = () => {
      setNow(engine.currentTimelineSample())
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [engine])

  useEffect(() => {
    const id = window.setInterval(() => {
      const next = engine.levels()
      setLevels({ master: next.master, tracks: next.tracks })
    }, 90)
    return () => window.clearInterval(id)
  }, [engine])

  function recordInto(trackId: string, scene: number) {
    store.armSlot(trackId, scene)
    const track = store.project.tracks.find((item) => item.id === trackId)
    if (track?.type === 'audio') {
      for (const item of store.project.tracks) {
        if (item.type === 'audio' && item.id !== trackId && item.armed) store.updateTrack(item.id, { armed: false })
      }
      store.updateTrack(trackId, { armed: true })
    } else if (track?.type === 'midi') {
      store.updateTrack(trackId, { armed: true, input: track.input === 'none' ? 'midi' : track.input })
    }
    onRecord()
  }

  function openSlot(track: Track, scene: number, clipId: string | null) {
    window.clearTimeout(clickTimer.current)
    if (!clipId) {
      if (track.type === 'midi') store.prepareMidiSlot(track.id, scene)
      else store.toast('Drop a sound here, or arm the track and click to record.', 'info')
      store.armSlot(track.id, scene)
      setDetailOn(true)
      if (phone) setBrowserOn(false)
      return
    }
    store.armSlot(track.id, scene)
    setDetailOn(true)
    if (phone) setBrowserOn(false)
  }

  function clickSlot(track: Track, scene: number, clipId: string | null) {
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      if (clipId) {
        store.armSlot(track.id, scene)
        const clip = sceneClip(track, scene)
        if (clip && clip.mode !== 'gate') store.launch(track.id, clip.id, engine.currentTimelineSample())
        return
      }
      store.armSlot(track.id, scene)
      if (track.armed) recordInto(track.id, scene)
    }, 220)
  }

  function stopTrack(trackId: string) {
    store.launch(trackId, null, engine.currentTimelineSample())
  }

  async function onDrop(trackId: string, scene: number, event: DragEvent) {
    event.preventDefault()
    event.stopPropagation()
    const text = event.dataTransfer.getData('text/plain')
    const clipDrag = CLIP_DRAG.exec(text)
    if (clipDrag) {
      const from = store.project.tracks.find((item) => item.id === clipDrag[1])
      const fromScene = from ? (from.type === 'audio' ? from.audioSlots : from.midiSlots)?.indexOf(clipDrag[2]) ?? -1 : -1
      if (from && fromScene >= 0) store.moveClipToSlot(from.id, fromScene, trackId, scene)
      else store.copyIntoSlot(trackId, scene, clipDrag[1], clipDrag[2])
      return
    }
    if (text.startsWith('cueharbor-sound:')) {
      const id = text.slice('cueharbor-sound:'.length)
      if (!soundById(id)) return
      try {
        await dropLibrarySound(store, trackId, scene, id)
      } catch (error) {
        store.toast(error instanceof Error ? error.message : 'Could not add that sound.', 'warn')
      }
      return
    }
    const device = parseDeviceDrag(text)
    if (device) {
      applyDevice(store, trackId, device.kind, device.id)
      store.armSlot(trackId, scene)
      setDetailOn(true)
      return
    }
    const file = event.dataTransfer.files?.[0]
    if (file) onDropAudio(trackId, scene, file)
  }

  const rolling = engine.status === 'playing' || engine.status === 'recording' || engine.status === 'counting-in'

  return (
    <div className="session-grid sl" data-session-view="open" data-pane={pane} data-mixer={mixerOn ? 'open' : 'closed'}>
      <div className="sl-bar">
        <select aria-label="Launch quantize" title="Clips start on this grid." value={quant} disabled={store.remoteFollow} onChange={(event) => store.setLaunchQuant(event.target.value as LaunchQuant)}>
          {LAUNCH_QUANTS.map((value) => <option key={value} value={value}>{QUANT_LABEL[value]}</option>)}
        </select>
        <button type="button" className={browserOn ? 'on' : ''} title="Show or hide the browser." onClick={() => { setBrowserOn((value) => !value); if (phone) setDetailOn(false) }}>Browser</button>
        <button type="button" className={detailOn ? 'on' : ''} title="Show or hide clip and device details." onClick={() => { setDetailOn((value) => !value); if (phone) setBrowserOn(false) }}>Detail</button>
        <button type="button" className={mixerOn ? 'on' : ''} title="Show or hide the mixer under the clips." onClick={() => setMixerOn((value) => !value)}>Mix</button>
        {!phone && <button type="button" className="text-btn" title="Print launched clips onto the arrangement." disabled={store.remoteFollow} onClick={() => store.captureToArrangement()}>To arrangement</button>}
        <button type="button" className="text-btn" title="Stop every clip on the next grid line." onClick={() => store.stopSession(engine.currentTimelineSample(), rolling)}>Stop all</button>
        <AddTrackButton store={store} />
      </div>
      <div className="sl-body">
        {browserOn && (
          <SessionBrowser
            width={browserW}
            onResize={setBrowserW}
            onClose={phone ? () => setBrowserOn(false) : undefined}
          />
        )}
        <div className="sl-stage">
          <div className="sl-scroller">
            {tracks.map((track, index) => (
              <TrackColumn
                key={track.id}
                store={store}
                engine={engine}
                track={track}
                index={index}
                now={now}
                level={levels.tracks[track.id] ?? 0}
                mixer={mixerOn}
                onClickSlot={clickSlot}
                onOpenSlot={openSlot}
                onStop={() => stopTrack(track.id)}
                onDrop={onDrop}
              />
            ))}
            <div className="sl-scenes" aria-label="Scenes">
              <div className="sl-head" style={{ background: '#c8c2b4' }}>Master</div>
              {Array.from({ length: 8 }, (_, scene) => (
                <div key={scene} className="sl-scene">
                  <button type="button" title={`Launch ${sceneTitle(grid.project.sceneNames, scene)}.`} aria-label={`Scene ${scene + 1}. Launch every clip in this row.`} onClick={() => store.launchScene(scene, engine.currentTimelineSample())}>
                    <i className="sl-tri" />
                  </button>
                  <input
                    aria-label={`Scene ${scene + 1} name`}
                    title="Rename this scene."
                    value={grid.project.sceneNames?.[scene] ?? ''}
                    placeholder={sceneTitle(grid.project.sceneNames, scene)}
                    onChange={(event) => store.setSceneName(scene, event.target.value)}
                  />
                </div>
              ))}
              <button type="button" className="sl-stopall" title="Stop every clip on the next grid line." onClick={() => store.stopSession(engine.currentTimelineSample(), rolling)}>Stop all</button>
              {mixerOn && (
                <div className="sl-mix">
                  <div className="sl-fader">
                    <input aria-label="Master volume" title="Master volume." type="range" min={0} max={1.25} step={0.01} value={grid.project.masterVolume} onChange={(event) => store.setMasterVolume(Number(event.target.value))} />
                    <div className="sl-meter" aria-hidden><i style={{ height: `${Math.min(100, levels.master * 140)}%` }} /></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {detailOn && (
          <SessionDetail
            store={store}
            engine={engine}
            track={focusTrack}
            scene={focus?.scene ?? null}
            height={detailH}
            onResize={setDetailH}
            onClose={phone ? () => setDetailOn(false) : undefined}
          />
        )}
      </div>
    </div>
  )
}

function TrackColumn({
  store,
  engine,
  track,
  index,
  now,
  level,
  mixer,
  onClickSlot,
  onOpenSlot,
  onStop,
  onDrop,
}: {
  store: ProjectStore
  engine: AudioEngine
  track: Track
  index: number
  now: number
  level: number
  mixer: boolean
  onClickSlot: (track: Track, scene: number, clipId: string | null) => void
  onOpenSlot: (track: Track, scene: number, clipId: string | null) => void
  onStop: () => void
  onDrop: (trackId: string, scene: number, event: DragEvent) => void
}) {
  const project = store.project
  const playingId = store.launched[track.id]
  const trackLive = !!playingId
  const buses = project.tracks.filter((item) => item.type === 'bus')
  return (
    <div className="session-col sl-col" data-track={track.id} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDrop(track.id, store.sessionEdit?.scene ?? 0, event)}>
      <button type="button" className="sl-head" style={{ background: track.color }} title={track.name} onClick={() => { store.selectTrack(track.id); store.armSlot(track.id, store.sessionEdit?.scene ?? 0) }}>
        <span>{track.name}</span>
      </button>
      {Array.from({ length: 8 }, (_, scene) => {
        const clip = sceneClip(track, scene)
        const hand = store.handoff[track.id]
        const phase = slotDisplay({
          clipId: clip?.id ?? null,
          launchedId: playingId ?? null,
          handoffId: hand?.clipId,
          handoffAt: hand?.at,
          now,
          launchAt: store.launchAt[track.id],
          stopAt: store.stopAt[track.id],
          lengthSamples: clip ? clipLoopSamples(clip, project.sampleRate, project.tempo) : 1,
        })
        const phaseLabel = phase.phase === 'queued' ? 'Queued until the next grid line.' : phase.phase === 'playing' ? 'Playing.' : phase.phase === 'stopping' ? 'Stopping at the next grid line.' : ''
        return (
          <button
            key={scene}
            type="button"
            data-phase={phase.phase}
            draggable={!!clip}
            className={`slot ${clip ? 'filled' : ''} ${phase.phase === 'playing' ? 'live' : ''} ${phase.phase === 'queued' ? 'queued' : ''} ${phase.phase === 'stopping' ? 'stopping' : ''}`}
            style={clip ? { background: clipPaint(clip, track.color) } : undefined}
            title={clip ? 'Click to launch on the grid. Double-click to edit.' : track.armed ? 'Empty slot. Click to record. Double-click a MIDI track to make a clip.' : 'Empty slot. Arm the track to record, or double-click a MIDI track to make a clip.'}
            aria-label={clip ? `${clip.name}. ${phaseLabel} Click to launch.` : `${track.name} scene ${scene + 1}. Empty slot.`}
            onDragStart={(event) => {
              if (!clip) return
              event.dataTransfer.setData('text/plain', `cueharbor-clip:${track.id}:${clip.id}`)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(track.id, scene, event)}
            onDoubleClick={() => onOpenSlot(track, scene, clip?.id ?? null)}
            onPointerDown={(event) => {
              if (!clip || (clip.mode ?? 'toggle') !== 'gate') return
              event.preventDefault()
              store.launch(track.id, clip.id, engine.currentTimelineSample())
            }}
            onPointerUp={() => {
              if (!clip || clip.mode !== 'gate') return
              store.launch(track.id, null, engine.currentTimelineSample())
            }}
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('.sl-sq') && !clip) {
                onStop()
                return
              }
              if (clip?.mode === 'gate') return
              onClickSlot(track, scene, clip?.id ?? null)
            }}
          >
            {(phase.phase === 'playing' || phase.phase === 'stopping') && (
              <span className="slot-progress" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
            )}
            {(phase.phase === 'queued' || phase.phase === 'playing' || phase.phase === 'stopping') && <span className="slot-mark" aria-hidden />}
            {clip ? <i className="sl-tri" /> : <i className="sl-sq" title="Stop this track." />}
            <span className="slot-name">{clip ? clip.name : ''}</span>
          </button>
        )
      })}
      <button
        type="button"
        className={`track-stop ${trackLive ? 'live' : ''}`}
        aria-label={`${track.name}. Stop this track.`}
        title="Stop this track on the next grid line."
        onClick={onStop}
      >
        <i className="sl-sq" />
      </button>
      {mixer && (
        <div className="sl-mix" data-mixer={track.id}>
          <div className="sl-fader">
            <input aria-label={`${track.name} volume`} title="Volume." type="range" min={0} max={1.25} step={0.01} value={track.volume} onChange={(event) => store.updateTrack(track.id, { volume: Number(event.target.value) })} />
            <div className="sl-meter" aria-hidden><i style={{ height: `${Math.min(100, level * 160)}%` }} /></div>
          </div>
          <label className="sl-pan">
            Pan
            <input aria-label={`${track.name} pan`} title="Pan." type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(event) => store.updateTrack(track.id, { pan: Number(event.target.value) })} />
          </label>
          <div className="sl-flags">
            <button type="button" className={track.mute ? 'mute on' : ''} title="Activator. Turn the track on or off." onClick={() => store.updateTrack(track.id, { mute: !track.mute })}>{index + 1}</button>
            <button type="button" className={track.solo ? 'on' : ''} title="Solo this track." onClick={() => store.updateTrack(track.id, { solo: !track.solo })}>S</button>
            <button type="button" className={track.armed ? 'arm on' : ''} title="Arm this track for recording." onClick={() => store.updateTrack(track.id, { armed: !track.armed })}>R</button>
          </div>
          <div className="sl-sends">
            {[0, 1].map((sendIndex) => {
              const bus = buses[sendIndex]
              const send = bus ? track.sends.find((item) => item.busId === bus.id) : undefined
              const letter = String.fromCharCode(65 + sendIndex)
              return (
                <label key={letter}>
                  {letter}
                  <input
                    aria-label={`${track.name} send ${letter}`}
                    title={bus ? `Send to ${bus.name}.` : 'Adds a return and sends this track to it.'}
                    type="range"
                    min={0}
                    max={1}
                    step={0.01}
                    value={send?.gain ?? 0}
                    onChange={(event) => {
                      const gain = Number(event.target.value)
                      let target: Track | undefined = bus
                      if (!target) {
                        store.addTrack('bus')
                        target = store.project.tracks.filter((item) => item.type === 'bus').at(-1)
                      }
                      if (!target) return
                      if (!track.sends.some((item) => item.busId === target!.id)) store.addSend(track.id, target.id)
                      const next = store.track(track.id)?.sends.find((item) => item.busId === target!.id)
                      if (next) store.updateSend(track.id, next.id, { gain })
                    }}
                  />
                </label>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function applyDevice(store: ProjectStore, trackId: string, kind: 'audio' | 'midi' | 'instrument', id: string) {
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!track) return
  if (kind === 'audio') {
    store.addPlugin(track.id, id)
    if (id === 'tune') {
      const plugin = store.track(track.id)?.plugins.at(-1)
      if (plugin?.pluginId === 'tune') store.updatePlugin(track.id, plugin.id, { params: { amount: Math.max(plugin.params.amount ?? 0, 0.85) } })
    }
    return
  }
  if (track.type !== 'midi') {
    store.toast('That device goes on a MIDI track.', 'warn')
    return
  }
  if (kind === 'midi') {
    const fx = midiKind(id)
    if (fx) store.addMidiFx(track.id, fx)
    return
  }
  const instrument = instrumentFor(id)
  if (instrument) store.updateTrack(track.id, { instrument })
}

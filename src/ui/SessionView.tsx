import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { LAUNCH_QUANTS, QUANT_LABEL, sceneClip, SESSION_SCENES } from '../model/launch'
import { clipLoopSamples, slotDisplay } from '../model/sessionSlots'
import {
  clipPaint,
  instrumentFor,
  midiKind,
  sceneTitle,
  sessionPanes,
  sessionTracks,
} from '../model/sessionBoard'
import {
  createsEmptyMidiClip,
  parseSessionDrag,
  planSessionDrop,
  slotGesture,
  slotLabels,
  type SessionDrag,
  type SessionTarget,
} from '../model/sessionInteract'
import type { LaunchQuant, Track } from '../model/types'
import { selectSession } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { useFormFactor } from './form'
import { dropLibrarySound, SessionBrowser, soundById } from './sessionBrowser'
import { SessionDetail } from './sessionDetail'
import { sessionTargetAt } from './sessionPointer'
import './sessionGrid.css'
import './sessionLive.css'

export function SessionView({
  store,
  engine,
  onDropAudio,
}: {
  store: ProjectStore
  engine: AudioEngine
  /** Kept so recording stays on the transport. Slot clicks do not start a take. */
  onRecord: () => void
  onDropAudio: (trackId: string, scene: number, file: File) => void
}) {
  return <SessionBody key={store.project.id} store={store} engine={engine} onDropAudio={onDropAudio} />
}

function SessionBody({
  store,
  engine,
  onDropAudio,
}: {
  store: ProjectStore
  engine: AudioEngine
  onDropAudio: (trackId: string, scene: number, file: File) => void
}) {
  const grid = selectSession(store)
  const phone = useFormFactor() === 'phone'
  const panes = sessionPanes(phone)
  const [browserOn, setBrowserOn] = useState(panes.browser)
  const [detailOn, setDetailOn] = useState(panes.detail)
  const [mixerOn, setMixerOn] = useState(panes.mixer)
  const [browserW, setBrowserW] = useState(220)
  const [detailH, setDetailH] = useState(360)
  const [levels, setLevels] = useState<{ master: number; tracks: Record<string, number> }>({ master: 0, tracks: {} })
  const [now, setNow] = useState(() => engine.currentTimelineSample())
  const clickTimer = useRef(0)
  const lastClick = useRef<{ key: string; at: number } | null>(null)
  const tracks = sessionTracks(grid.tracks)
  const quant = grid.project.launchQuant ?? '1bar'
  const focus = store.sessionEdit
  const focusTrack = tracks.find((track) => track.id === (focus?.trackId ?? store.selectedTrackId)) ?? tracks[0] ?? null
  const pane = !phone ? 'grid' : browserOn ? 'browser' : detailOn ? 'detail' : 'grid'
  const rolling = engine.status === 'playing' || engine.status === 'recording' || engine.status === 'counting-in'
  const stopping = Object.keys(store.stopAt).length > 0
  const rows = mixerOn
    ? `var(--sl-head) repeat(${SESSION_SCENES}, var(--sl-slot)) var(--sl-stop) minmax(188px, auto)`
    : `var(--sl-head) repeat(${SESSION_SCENES}, var(--sl-slot)) var(--sl-stop)`

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

  function showDetail() {
    setDetailOn(true)
    if (phone) setBrowserOn(false)
  }

  function openSlot(track: Track, scene: number) {
    window.clearTimeout(clickTimer.current)
    const fresh = store.project.tracks.find((item) => item.id === track.id) ?? track
    const clip = sceneClip(fresh, scene)
    if (createsEmptyMidiClip(fresh.type, 'edit', !!clip)) {
      store.createEmptyMidiSlot(fresh.id, scene)
      showDetail()
      return
    }
    store.armSlot(fresh.id, scene)
    if (clip) showDetail()
    else if (fresh.type !== 'midi') store.toast('Drop a sound here, or arm the track and record.', 'info')
  }

  function bodyClick(track: Track, scene: number) {
    const key = `${track.id}:${scene}`
    const at = performance.now()
    const prev = lastClick.current
    if (prev && prev.key === key && at - prev.at < 400) {
      lastClick.current = null
      openSlot(track, scene)
      return
    }
    lastClick.current = { key, at }
    window.clearTimeout(clickTimer.current)
    clickTimer.current = window.setTimeout(() => {
      const fresh = store.project.tracks.find((item) => item.id === track.id) ?? track
      const clip = sceneClip(fresh, scene)
      store.armSlot(fresh.id, scene)
      if (clip) showDetail()
    }, 280)
  }

  function launchSlot(track: Track, scene: number) {
    const clip = sceneClip(track, scene)
    if (!clip || clip.mode === 'gate') return
    store.launch(track.id, clip.id, engine.currentTimelineSample(), 'start')
  }

  function stopTrack(trackId: string) {
    store.launch(trackId, null, engine.currentTimelineSample())
  }

  async function applyPlanned(drag: SessionDrag, target: SessionTarget) {
    const plan = planSessionDrop(drag, target)
    if (plan.action === 'reject') {
      store.toast(plan.reason, 'warn')
      return
    }
    if (plan.action === 'place-sound') {
      if (!soundById(plan.id)) {
        store.toast('That sound is not in the browser yet.', 'warn')
        return
      }
      try {
        await dropLibrarySound(store, plan.trackId, plan.scene, plan.id)
        store.armSlot(plan.trackId, plan.scene)
        showDetail()
      } catch (error) {
        store.toast(error instanceof Error ? error.message : 'Could not add that sound.', 'warn')
      }
      return
    }
    if (plan.action === 'load-instrument' || plan.action === 'add-audio-device' || plan.action === 'add-midi-device') {
      applyDevice(store, plan.trackId, plan.action === 'load-instrument' ? 'instrument' : plan.action === 'add-audio-device' ? 'audio' : 'midi', plan.id)
      store.armSlot(plan.trackId, 0)
      showDetail()
      return
    }
    const from = store.project.tracks.find((item) => item.id === plan.fromTrackId)
    const fromScene = from ? (from.type === 'audio' ? from.audioSlots : from.midiSlots)?.indexOf(plan.clipId) ?? -1 : -1
    if (from && fromScene >= 0) store.moveClipToSlot(from.id, fromScene, plan.trackId, plan.scene)
    else store.copyIntoSlot(plan.trackId, plan.scene, plan.fromTrackId, plan.clipId)
    store.armSlot(plan.trackId, plan.scene)
    showDetail()
  }

  function readDrop(event: DragEvent, target: SessionTarget) {
    event.preventDefault()
    event.stopPropagation()
    const file = event.dataTransfer.files?.[0]
    if (file && target.kind === 'slot') {
      onDropAudio(target.trackId, target.scene, file)
      return
    }
    const drag = parseSessionDrag(event.dataTransfer.getData('text/plain'))
    if (drag) void applyPlanned(drag, target)
  }

  const transportNote = !rolling
    ? ''
    : stopping
      ? 'Stopping clips. Transport keeps playing.'
      : 'Stop all keeps the transport playing.'

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
        <button type="button" className="text-btn" title="Stop every clip on the next grid line. The transport keeps playing." onClick={() => store.stopSession(engine.currentTimelineSample(), rolling)}>{stopping ? 'Stopping' : 'Stop all'}</button>
        {transportNote && <span className="sl-keep" role="status">{phone ? 'Transport stays on' : transportNote}</span>}
        <AddTrackButton store={store} />
      </div>
      <div className="sl-body">
        {browserOn && (
          <SessionBrowser
            width={browserW}
            onResize={setBrowserW}
            onClose={phone ? () => setBrowserOn(false) : undefined}
            onPointerDrop={(drag, point) => {
              const target = sessionTargetAt(point.x, point.y)
              if (target) void applyPlanned(drag, target)
            }}
          />
        )}
        <div className="sl-stage">
          <div className="sl-scroller" style={{ ['--sl-rows' as string]: rows }}>
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
                onBody={bodyClick}
                onOpen={openSlot}
                onLaunch={launchSlot}
                onStop={() => stopTrack(track.id)}
                onDrop={readDrop}
              />
            ))}
            <div className="sl-scenes" aria-label="Scenes">
              <div className="sl-head" style={{ background: '#c8c2b4' }}>Master</div>
              {Array.from({ length: SESSION_SCENES }, (_, scene) => (
                <div key={scene} className="sl-scene" data-scene={scene}>
                  <button
                    type="button"
                    data-scene-launch={scene}
                    title={`Launch ${sceneTitle(grid.project.sceneNames, scene)}. Row ${scene + 1}.`}
                    aria-label={`Scene ${scene + 1}. Launch every clip in row ${scene + 1}.`}
                    onClick={() => store.launchScene(scene, engine.currentTimelineSample())}
                  >
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
              <button type="button" className="sl-stopall" title="Stop every clip on the next grid line. The transport keeps playing." onClick={() => store.stopSession(engine.currentTimelineSample(), rolling)}>
                {stopping ? 'Stopping' : 'Stop all'}
              </button>
              {mixerOn && (
                <div className="sl-mix sl-master">
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
  onBody,
  onOpen,
  onLaunch,
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
  onBody: (track: Track, scene: number) => void
  onOpen: (track: Track, scene: number) => void
  onLaunch: (track: Track, scene: number) => void
  onStop: () => void
  onDrop: (event: DragEvent, target: SessionTarget) => void
}) {
  const project = store.project
  const playingId = store.launched[track.id]
  const trackLive = !!playingId
  const buses = project.tracks.filter((item) => item.type === 'bus')
  const names = Array.from({ length: SESSION_SCENES }, (_, scene) => sceneClip(track, scene)?.name ?? null)
  const labels = slotLabels(names)
  const slotTarget = (scene: number): SessionTarget => ({ kind: 'slot', trackId: track.id, scene, trackType: track.type })
  const headTarget: SessionTarget = { kind: 'header', trackId: track.id, trackType: track.type }
  return (
    <div className="session-col sl-col" data-track={track.id}>
      <button
        type="button"
        className="sl-head"
        data-session-head={track.id}
        data-track-type={track.type}
        style={{ background: track.color }}
        title={track.name}
        onClick={() => store.selectTrack(track.id)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => onDrop(event, headTarget)}
      >
        <span>{track.name}</span>
      </button>
      {Array.from({ length: SESSION_SCENES }, (_, scene) => {
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
        const label = labels[scene]
        const phaseLabel = phase.phase === 'queued' ? 'Queued until the next grid line.' : phase.phase === 'playing' ? 'Playing.' : phase.phase === 'stopping' ? 'Stopping at the next grid line.' : ''
        return (
          <div
            key={scene}
            data-session-slot={track.id}
            data-scene={scene}
            data-track-type={track.type}
            data-phase={phase.phase}
            role="button"
            tabIndex={0}
            draggable={!!clip}
            className={`slot ${clip ? 'filled' : ''} ${phase.phase === 'playing' ? 'live' : ''} ${phase.phase === 'queued' ? 'queued' : ''} ${phase.phase === 'stopping' ? 'stopping' : ''}`}
            style={clip ? { backgroundColor: clipPaint(clip, track.color) } : undefined}
            title={clip ? label.title : 'Empty slot. Double-click a MIDI track to make a 1-bar clip.'}
            aria-label={clip ? `${label.title}. ${phaseLabel} Click to edit. The triangle launches.` : `${track.name} scene ${scene + 1}. Empty slot.`}
            onDragStart={(event) => {
              if (!clip) return
              event.dataTransfer.setData('text/plain', `cueharbor-clip:${track.id}:${clip.id}`)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => onDrop(event, slotTarget(scene))}
            onDoubleClick={() => onOpen(track, scene)}
            onClick={(event) => {
              const hit = (event.target as HTMLElement).closest('[data-slot-launch], [data-slot-stop]')
              if (hit) return
              if (slotGesture('body', 1) === 'select') onBody(track, scene)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onBody(track, scene)
            }}
          >
            {(phase.phase === 'playing' || phase.phase === 'stopping') && (
              <span className="slot-progress" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
            )}
            {clip ? (
              <button
                type="button"
                data-slot-launch=""
                className="sl-hit"
                title={`Launch ${label.title}.`}
                aria-label={`Launch ${label.title}.`}
                onPointerDown={(event) => {
                  if (!clip || (clip.mode ?? 'toggle') !== 'gate') return
                  event.preventDefault()
                  event.stopPropagation()
                  store.launch(track.id, clip.id, engine.currentTimelineSample(), 'start')
                }}
                onPointerUp={(event) => {
                  if (!clip || clip.mode !== 'gate') return
                  event.stopPropagation()
                  store.launch(track.id, null, engine.currentTimelineSample())
                }}
                onClick={(event) => {
                  event.stopPropagation()
                  if (clip.mode === 'gate') return
                  if (slotGesture('launch', 1) === 'launch') onLaunch(track, scene)
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <i className="sl-tri" />
              </button>
            ) : (
              <button
                type="button"
                data-slot-stop=""
                className="sl-hit"
                title="Stop this track."
                aria-label={`Stop ${track.name}.`}
                onClick={(event) => {
                  event.stopPropagation()
                  if (slotGesture('stop', 1) === 'stop') onStop()
                }}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                <i className="sl-sq" />
              </button>
            )}
            <span className="slot-name">{label.text}</span>
            {label.badge && <span className="slot-num">{label.badge}</span>}
          </div>
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
  if (!instrument) return
  store.updateTrack(track.id, { instrument, input: track.input === 'none' ? 'midi' : track.input })
}

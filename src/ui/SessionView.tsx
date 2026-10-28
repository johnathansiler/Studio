import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, QUANT_LABEL, sceneClip, SESSION_SCENES } from '../model/launch'
import { COLUMN_BOUNDS } from '../model/layoutWidth'
import { clipLoopSamples, slotPhase } from '../model/sessionSlots'
import type { FollowAction, LaunchMode, LaunchQuant } from '../model/types'
import { quartersPerBar } from '../model/time'
import { selectSession } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { SESSION_BAR, SESSION_SHEET, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { ActionSheet, TipButton } from './Hint'
import { ColumnGrip, pinchBlocked, useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'
import './sessionGrid.css'

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
  const project = grid.project
  const { layout, setColumn, resetColumn } = useLayoutWidths(project.id)
  const areaRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef(layout.column)
  columnRef.current = layout.column
  usePinchResize(areaRef, () => columnRef.current, setColumn, COLUMN_BOUNDS)
  const quant = project.launchQuant ?? '1bar'
  const bars = project.recordBars ?? 4
  const edit = store.sessionEdit
  const editTrack = edit ? grid.tracks.find((track) => track.id === edit.trackId) : undefined
  const editClip = editTrack && edit ? sceneClip(editTrack, edit.scene) : null
  const compact = useFormFactor() !== 'desk'
  const [clipOpen, setClipOpen] = useState(false)
  const [now, setNow] = useState(() => engine.currentTimelineSample())
  const bar = (id: string) => copyOf(SESSION_BAR, id)
  const sheet = (id: string) => copyOf(SESSION_SHEET, id)
  const rolling = engine.status === 'playing' || engine.status === 'recording' || engine.status === 'counting-in'
  useEffect(() => {
    let frame = 0
    const tick = () => {
      setNow(engine.currentTimelineSample())
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [engine])
  const clipFields = editClip && edit ? (
    <>
      <select
        {...described(sheet('mode'))}
        value={editClip.mode ?? 'toggle'}
        disabled={store.remoteFollow}
        onChange={(event) => store.setClipLaunch(edit.trackId, editClip.id, { mode: event.target.value as LaunchMode })}
      >
        {LAUNCH_MODES.map((value) => (
          <option key={value} value={value}>{value}</option>
        ))}
      </select>
      <select
        {...described(sheet('follow'))}
        value={editClip.follow ?? 'none'}
        disabled={store.remoteFollow}
        onChange={(event) => {
          const follow = event.target.value as FollowAction
          store.setClipLaunch(edit.trackId, editClip.id, {
            follow,
            followBeats: editClip.followBeats ?? quartersPerBar(project.timeSignature),
          })
        }}
      >
        {FOLLOW_ACTIONS.map((value) => (
          <option key={value} value={value}>{value}</option>
        ))}
      </select>
      <TipButton className={`mode-btn ${editClip.loop !== false ? 'on' : ''}`} label={sheet('loop').label} hint={sheet('loop').hint} pressed={editClip.loop !== false} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { loop: editClip.loop === false })} />
      <TipButton className={`mode-btn ${editClip.legato ? 'on' : ''}`} label={sheet('legato').label} hint={sheet('legato').hint} pressed={!!editClip.legato} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { legato: !editClip.legato })} />
      {'bufferId' in editClip && (
        <>
          <TipButton className={`mode-btn ${editClip.warp !== false ? 'on' : ''}`} label={sheet('warp').label} hint={sheet('warp').hint} pressed={editClip.warp !== false} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { warp: editClip.warp === false })} />
          <TipButton className="mode-btn" label="Repair" hint="Spectrogram. Select a spot and remove clicks, hum, or noise." disabled={store.remoteFollow} onClick={() => store.openSpectral(edit.trackId, editClip.id)} />
        </>
      )}
    </>
  ) : null

  function recordInto(trackId: string, scene: number) {
    store.armSlot(trackId, scene)
    const track = store.project.tracks.find((item) => item.id === trackId)
    if (track?.type === 'audio') {
      for (const item of store.project.tracks) {
        if (item.type === 'audio' && item.id !== trackId && item.armed) store.updateTrack(item.id, { armed: false })
      }
      store.updateTrack(trackId, { armed: true })
    }
    onRecord()
  }

  function assignDrop(trackId: string, scene: number, event: DragEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const text = event.dataTransfer.getData('text/plain')
    const match = /^cueharbor-clip:([^:]+):([^:]+)$/.exec(text)
    if (match) {
      store.copyIntoSlot(trackId, scene, match[1], match[2])
      return
    }
    const file = event.dataTransfer.files?.[0]
    if (file) onDropAudio(trackId, scene, file)
  }

  return (
    <div
      className="session-grid"
      ref={areaRef}
      data-column-width={layout.column}
      data-session-view="open"
      style={{ ['--col' as string]: `${layout.column}px` }}
    >
      <div className="session-bar">
        <select {...described(bar('quant'))} value={quant} disabled={store.remoteFollow} onChange={(event) => store.setLaunchQuant(event.target.value as LaunchQuant)}>
          {LAUNCH_QUANTS.map((value) => (
            <option key={value} value={value}>{QUANT_LABEL[value]}</option>
          ))}
        </select>
        {compact && editClip ? (
          <TipButton label={bar('clip').label} hint={bar('clip').hint} onClick={() => setClipOpen(true)} />
        ) : compact ? null : (
          <>
            <select {...described(sheet('length'))} value={String(bars)} disabled={store.remoteFollow} onChange={(event) => store.setRecordBars(Number(event.target.value))}>
              <option value="0">Open</option>
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>{value} bar{value === 1 ? '' : 's'}</option>
              ))}
            </select>
            {clipFields}
          </>
        )}
        <TipButton className="text-btn" label={bar('print').label} hint={bar('print').hint} disabled={store.remoteFollow} onClick={() => store.captureToArrangement()} />
        <TipButton className="text-btn" label={bar('stop').label} hint={bar('stop').hint} onClick={() => store.stopSession(engine.currentTimelineSample(), rolling)} />
        <AddTrackButton store={store} />
        <WidthBar axis="column" value={layout.column} onChange={setColumn} onReset={resetColumn} />
      </div>
      {compact && clipOpen && edit && editClip && (
        <ActionSheet title={editClip.name || 'Clip'} hint={bar('clip').hint} onClose={() => setClipOpen(false)}>
          <div className="sheet-fields">
            <select {...described(sheet('length'))} value={String(bars)} disabled={store.remoteFollow} onChange={(event) => store.setRecordBars(Number(event.target.value))}>
              <option value="0">Open</option>
              {[1, 2, 4, 8].map((value) => (
                <option key={value} value={value}>{value} bar{value === 1 ? '' : 's'}</option>
              ))}
            </select>
            {clipFields}
          </div>
        </ActionSheet>
      )}
      <div className="session-scroller">
        {grid.tracks.map((track, index) => {
          const playingId = grid.launched[track.id]
          const trackLive = !!playingId
          return (
            <div key={track.id} className="session-col" data-track={track.id}>
              <div className="col-head">
                <span className="col-name" style={{ color: track.color }}>{track.name}</span>
                {index === 0 && <ColumnGrip value={layout.column} onChange={setColumn} labelled />}
              </div>
              {Array.from({ length: SESSION_SCENES }, (_, scene) => {
                const clip = sceneClip(track, scene)
                const launched = !!(clip && playingId === clip.id)
                const phase = slotPhase({
                  hasClip: !!clip,
                  launched,
                  now,
                  launchAt: grid.launchAt[track.id],
                  stopAt: grid.stopAt[track.id],
                  lengthSamples: clip ? clipLoopSamples(clip, project.sampleRate, project.tempo) : 1,
                })
                const armed = store.sessionSlot?.trackId === track.id && store.sessionSlot.scene === scene
                return (
                  <button
                    key={scene}
                    type="button"
                    className={`slot ${clip ? 'filled' : ''} ${phase.phase === 'playing' ? 'live' : ''} ${phase.phase === 'queued' ? 'queued' : ''} ${phase.phase === 'stopping' ? 'stopping' : ''} ${armed && !clip ? 'armed' : ''}`}
                    title={clip ? 'Tap to launch this clip on the grid. Tap again to stop it.' : 'Empty slot. Tap to record into it. Drop a clip to assign it.'}
                    aria-label={clip ? `${clip.name}. Tap to launch this clip. Tap again to stop it.` : `${track.name} scene ${scene + 1}. Empty slot. Tap to record into it.`}
                    style={clip ? { background: track.color } : undefined}
                    draggable={!!clip}
                    onDragStart={(event) => {
                      if (!clip) return
                      event.dataTransfer.setData('text/plain', `cueharbor-clip:${track.id}:${clip.id}`)
                      event.dataTransfer.effectAllowed = 'copy'
                    }}
                    onDragOver={(event) => {
                      if ([...event.dataTransfer.types].includes('Files') || event.dataTransfer.types.includes('text/plain')) event.preventDefault()
                    }}
                    onDrop={(event) => assignDrop(track.id, scene, event)}
                    onPointerDown={(event) => {
                      if (pinchBlocked(event.currentTarget)) return
                      if (!clip || (clip.mode ?? 'toggle') !== 'gate') return
                      event.preventDefault()
                      store.launch(track.id, clip.id, engine.currentTimelineSample())
                    }}
                    onPointerUp={(event) => {
                      if (pinchBlocked(event.currentTarget)) return
                      if (!clip || clip.mode !== 'gate') return
                      store.launch(track.id, null, engine.currentTimelineSample())
                    }}
                    onPointerCancel={(event) => {
                      if (pinchBlocked(event.currentTarget)) return
                      if (!clip || clip.mode !== 'gate') return
                      store.launch(track.id, null, engine.currentTimelineSample())
                    }}
                    onClick={(event) => {
                      if (pinchBlocked(event.currentTarget)) return
                      if (!clip) {
                        recordInto(track.id, scene)
                        return
                      }
                      store.armSlot(track.id, scene)
                      if (clip.mode === 'gate') return
                      store.launch(track.id, clip.id, engine.currentTimelineSample())
                    }}
                  >
                    {(phase.phase === 'playing' || phase.phase === 'stopping') && (
                      <span className="slot-progress" style={{ width: `${Math.round(phase.progress * 100)}%` }} />
                    )}
                    <span className="slot-name">{clip ? clip.name : ''}</span>
                  </button>
                )
              })}
              <button
                type="button"
                className={`track-stop ${trackLive ? 'live' : ''} ${track.armed ? 'armed' : ''}`}
                aria-label={`${track.name}. Stop clips on this track, or arm it when nothing is playing.`}
                title="Stop clips on this track. If nothing is playing, arm the track."
                onClick={() => {
                  if (trackLive || grid.stopAt[track.id] != null) store.launch(track.id, null, engine.currentTimelineSample())
                  else store.updateTrack(track.id, { armed: !track.armed })
                }}
              >
                {trackLive ? 'Stop' : track.armed ? 'Armed' : 'Arm'}
              </button>
            </div>
          )
        })}
        <div className="session-scenes" aria-label="Scenes">
          <div className="scene-head" />
          {Array.from({ length: SESSION_SCENES }, (_, scene) => (
            <button
              key={scene}
              type="button"
              className="scene-launch"
              title="Launch every clip in this row."
              aria-label={`Scene ${scene + 1}. Launch every clip in this row.`}
              onClick={() => store.launchScene(scene, engine.currentTimelineSample())}
            >
              {scene + 1}
            </button>
          ))}
          <div className="scene-head" />
        </div>
      </div>
    </div>
  )
}

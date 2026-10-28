import { useRef } from 'react'
import type { AudioEngine } from '../audio/engine'
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, QUANT_LABEL, sceneClip, SESSION_SCENES } from '../model/launch'
import { COLUMN_BOUNDS, sessionTableWidth } from '../model/layoutWidth'
import type { FollowAction, LaunchMode, LaunchQuant } from '../model/types'
import { quartersPerBar } from '../model/time'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { ColumnGrip, pinchBlocked, useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'

export function SessionView({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  return <SessionBody key={store.project.id} store={store} engine={engine} />
}

function SessionBody({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const project = store.project
  const { layout, setColumn, resetColumn } = useLayoutWidths(project.id)
  const areaRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef(layout.column)
  columnRef.current = layout.column
  usePinchResize(areaRef, () => columnRef.current, setColumn, COLUMN_BOUNDS)
  const quant = project.launchQuant ?? '1bar'
  const bars = project.recordBars ?? 4
  const edit = store.sessionEdit
  const editTrack = edit ? store.project.tracks.find((track) => track.id === edit.trackId) : undefined
  const editClip = editTrack && edit ? sceneClip(editTrack, edit.scene) : null
  return (
    <div
      className="session-grid"
      ref={areaRef}
      data-column-width={layout.column}
      style={{ ['--col' as string]: `${layout.column}px` }}
    >
      <div className="session-bar">
        <select aria-label="Launch quantization" value={quant} disabled={store.remoteFollow} onChange={(event) => store.setLaunchQuant(event.target.value as LaunchQuant)}>
          {LAUNCH_QUANTS.map((value) => (
            <option key={value} value={value}>{QUANT_LABEL[value]}</option>
          ))}
        </select>
        <select aria-label="Record length" value={String(bars)} disabled={store.remoteFollow} onChange={(event) => store.setRecordBars(Number(event.target.value))}>
          <option value="0">Open</option>
          {[1, 2, 4, 8].map((value) => (
            <option key={value} value={value}>{value} bar{value === 1 ? '' : 's'}</option>
          ))}
        </select>
        {editClip && edit && (
          <>
            <select
              aria-label="Launch mode"
              value={editClip.mode ?? 'toggle'}
              disabled={store.remoteFollow}
              onChange={(event) => store.setClipLaunch(edit.trackId, editClip.id, { mode: event.target.value as LaunchMode })}
            >
              {LAUNCH_MODES.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
            <select
              aria-label="Follow action"
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
            <button type="button" className={`mode-btn ${editClip.loop !== false ? 'on' : ''}`} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { loop: editClip.loop === false })}>
              Loop
            </button>
            <button type="button" className={`mode-btn ${editClip.legato ? 'on' : ''}`} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { legato: !editClip.legato })}>
              Legato
            </button>
            {'bufferId' in editClip && (
              <button type="button" className={`mode-btn ${editClip.warp !== false ? 'on' : ''}`} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { warp: editClip.warp === false })}>
                Warp
              </button>
            )}
          </>
        )}
        <button type="button" className="text-btn" onClick={() => store.stopSession()}>Stop all</button>
        <WidthBar axis="column" value={layout.column} onChange={setColumn} onReset={resetColumn} />
      </div>
      <table style={{ width: sessionTableWidth(store.project.tracks.length, layout.column) }}>
        <thead>
          <tr>
            <th className="scene-col" />
            {store.project.tracks.map((track, index) => (
              <th key={track.id} className="track-col" data-track={track.id} style={{ color: track.color }}>
                <span className="col-name">{track.name}</span>
                <ColumnGrip value={layout.column} onChange={setColumn} labelled={index === 0} />
              </th>
            ))}
            <th className="add-col"><AddTrackButton store={store} /></th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SESSION_SCENES }, (_, scene) => (
            <tr key={scene}>
              <th className="scene-col">
                <button type="button" className="scene-launch" onClick={() => store.launchScene(scene, engine.currentTimelineSample())}>{scene + 1}</button>
              </th>
              {store.project.tracks.map((track) => {
                const clip = sceneClip(track, scene) || track.midiClips.find((item) => item.scene === scene)
                const launched = clip && store.launched[track.id] === clip.id
                const armed = store.sessionSlot?.trackId === track.id && store.sessionSlot.scene === scene
                return (
                  <td key={track.id} className="track-col">
                    <button
                      type="button"
                      className={`slot ${clip ? 'filled' : ''} ${launched ? 'live' : ''} ${armed ? 'armed' : ''}`}
                      style={clip ? { background: track.color } : undefined}
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
                        store.armSlot(track.id, scene)
                        if (!clip || clip.mode === 'gate') return
                        store.launch(track.id, clip.id, engine.currentTimelineSample())
                      }}
                    >
                      {clip ? clip.name : ''}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

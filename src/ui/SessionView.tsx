import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, QUANT_LABEL, sceneClip, SESSION_SCENES } from '../model/launch'
import type { FollowAction, LaunchMode, LaunchQuant } from '../model/types'
import { quartersPerBar } from '../model/time'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { SESSION_BAR, SESSION_SHEET, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { ActionSheet, TipButton } from './Hint'

export function SessionView({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const project = store.project
  const quant = project.launchQuant ?? '1bar'
  const bars = project.recordBars ?? 4
  const edit = store.sessionEdit
  const editTrack = edit ? store.project.tracks.find((track) => track.id === edit.trackId) : undefined
  const editClip = editTrack && edit ? sceneClip(editTrack, edit.scene) : null
  const compact = useFormFactor() !== 'desk'
  const [clipOpen, setClipOpen] = useState(false)
  const bar = (id: string) => copyOf(SESSION_BAR, id)
  const sheet = (id: string) => copyOf(SESSION_SHEET, id)
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
        <TipButton className={`mode-btn ${editClip.warp !== false ? 'on' : ''}`} label={sheet('warp').label} hint={sheet('warp').hint} pressed={editClip.warp !== false} disabled={store.remoteFollow} onClick={() => store.setClipLaunch(edit.trackId, editClip.id, { warp: editClip.warp === false })} />
      )}
    </>
  ) : null
  return (
    <div className="session-grid">
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
        <TipButton className="text-btn" label={bar('stop').label} hint={bar('stop').hint} onClick={() => store.stopSession()} />
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
      <table>
        <thead>
          <tr>
            <th />
            {store.project.tracks.map((track) => (
              <th key={track.id} data-track={track.id} style={{ color: track.color }}>
                {track.name}
              </th>
            ))}
            <th><AddTrackButton store={store} /></th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: SESSION_SCENES }, (_, scene) => (
            <tr key={scene}>
              <th>
                <button type="button" className="scene-launch" title="Launch every clip in this row." aria-label={`Scene ${scene + 1}. Launch every clip in this row.`} onClick={() => store.launchScene(scene, engine.currentTimelineSample())}>{scene + 1}</button>
              </th>
              {store.project.tracks.map((track) => {
                const clip = sceneClip(track, scene) || track.midiClips.find((item) => item.scene === scene)
                const launched = clip && store.launched[track.id] === clip.id
                const armed = store.sessionSlot?.trackId === track.id && store.sessionSlot.scene === scene
                return (
                  <td key={track.id}>
                    <button
                      type="button"
                      className={`slot ${clip ? 'filled' : ''} ${launched ? 'live' : ''} ${armed ? 'armed' : ''}`}
                      title={clip ? 'Tap to launch this clip. Tap again to stop it.' : 'Empty slot. Record into it while it is armed.'}
                      aria-label={clip ? `${clip.name}. Tap to launch this clip.` : `${track.name} scene ${scene + 1}. Empty slot.`}
                      style={clip ? { background: track.color } : undefined}
                      onPointerDown={(event) => {
                        if (!clip || (clip.mode ?? 'toggle') !== 'gate') return
                        event.preventDefault()
                        store.launch(track.id, clip.id, engine.currentTimelineSample())
                      }}
                      onPointerUp={() => {
                        if (!clip || clip.mode !== 'gate') return
                        store.launch(track.id, null, engine.currentTimelineSample())
                      }}
                      onPointerCancel={() => {
                        if (!clip || clip.mode !== 'gate') return
                        store.launch(track.id, null, engine.currentTimelineSample())
                      }}
                      onClick={() => {
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

import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { gainToDb } from '../model/time'
import { useLiveMix } from './liveMix'
import { DbRead } from './DbRead'
import type { ProjectStore } from '../state/store'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { hasStepSequencer } from '../model/editorOpen'
import { isSampledInstrument } from '../instruments/sampled'
import type { Track } from '../model/types'
import { TRACK_ROW, TRACK_SHEET, copyOf } from './chrome'
import { BevelSelect } from './BevelSelect'
import { InsertList, RouteFields, SendList } from './PluginSheet'
import { addOrOpenAutoTune } from './AutoTuneFace'
import './trackOptions.css'

function VolumeRange({ store, engine, trackId, volume, label, title }: { store: ProjectStore; engine?: AudioEngine; trackId: string; volume: number; label: string; title: string }) {
  const held = useRef(false)
  const live = useLiveMix(volume, {
    audio: (next) => engine?.previewMix('volume', trackId, next),
    project: (next) => {
      if (engine) store.reviseMix({ trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 }, next, false, 0)
    },
    commit: () => {
      if (!engine) return
      engine.armMixFollow()
      store.finishMixGesture()
    },
  })
  return (
    <input
      type="range"
      min={0}
      max={1.25}
      step="any"
      data-track-action="volume"
      title={title}
      aria-label={label}
      aria-valuetext={gainToDb(live.value)}
      value={engine ? live.value : volume}
      onPointerDown={() => {
        held.current = true
        store.beginAutomationTouch()
      }}
      onPointerUp={() => {
        held.current = false
        if (engine) live.release()
        store.endAutomationTouch()
      }}
      onPointerCancel={() => {
        held.current = false
        if (engine) live.release()
        store.endAutomationTouch()
      }}
      onChange={(event) => {
        const next = Number(event.target.value)
        if (!engine) {
          store.updateTrack(trackId, { volume: next })
          return
        }
        live.move(next)
        if (!held.current) {
          live.release()
          store.endAutomationTouch()
        }
      }}
    />
  )
}

export function trackKindLabel(track: { type: string }) {
  if (track.type === 'audio') return 'Audio'
  if (track.type === 'bus') return 'Bus'
  if (track.type === 'group') return 'Group'
  if (track.type === 'midi') return 'Instrument'
  return 'Track'
}

export function trackCanArm(track: { type: string }, userAgent = '') {
  return track.type === 'audio' || (track.type === 'midi' && hardwareMidiAllowed(userAgent))
}

export interface TrackTile {
  id: 'keys' | 'drums' | 'scaler' | 'patch' | 'rack' | 'repair'
  label: string
  hint: string
}

/** Open targets that apply to this track. Audio does not get the instrument editors. */
export function trackOpenTiles(track: { type: string }): TrackTile[] {
  if (track.type === 'midi') {
    return [
      { id: 'keys', label: 'Keys', hint: copyOf(TRACK_SHEET, 'keys').hint },
      { id: 'drums', label: 'Beat Machine', hint: copyOf(TRACK_SHEET, 'drums').hint },
      { id: 'scaler', label: copyOf(TRACK_SHEET, 'scaler').label, hint: copyOf(TRACK_SHEET, 'scaler').hint },
      { id: 'patch', label: 'Patch', hint: 'Layered patch: synths, samples, grains, and a morph pad.' },
      { id: 'rack', label: copyOf(TRACK_SHEET, 'rack').label, hint: copyOf(TRACK_SHEET, 'rack').hint },
    ]
  }
  if (track.type === 'audio') {
    return [{ id: 'repair', label: 'Repair', hint: 'Spectrogram. Select a spot and remove clicks, hum, or noise.' }]
  }
  return []
}

const INPUTS = [
  { value: 'mic', label: 'Mic' },
  { value: 'line', label: 'Line' },
  { value: 'mic:0', label: 'Mic 1' },
  { value: 'mic:1', label: 'Mic 2' },
  { value: 'mic:2', label: 'Mic 3' },
  { value: 'mic:3', label: 'Mic 4' },
  { value: 'none', label: 'No input' },
]

export function TrackOptions({
  store,
  engine,
  track,
  level,
  automationOpen,
  participants,
  onClose,
  onPerform,
  onOpenBeatMachine,
  onOpenPiano,
  onOpenSteps,
  onAnalyze,
  onOpenPlugins,
}: {
  store: ProjectStore
  engine?: AudioEngine
  track: Track
  level: number
  automationOpen: boolean
  participants: readonly { id: string; name: string }[]
  onClose: () => void
  onPerform: (mode: 'keys' | 'drums') => void
  onOpenBeatMachine?: (trackId: string) => void
  onOpenPiano?: (trackId: string, clipId?: string) => void
  onOpenSteps?: (trackId: string) => void
  onAnalyze: (trackId: string) => void
  /** Phone Arrange has no bottom-bar Plugins button. The same sheet opens from here. */
  onOpenPlugins?: () => void
}) {
  const [confirmRemove, setConfirmRemove] = useState(false)
  useEffect(() => { setConfirmRemove(false) }, [track.id])
  const armable = trackCanArm(track, typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const tiles = trackOpenTiles(track).map((tile) => tile.id === 'patch' && isSampledInstrument(track)
    ? { ...tile, hint: 'Sampler. Waveform, root, envelope, tone, and the keyboard.' }
    : tile.id === 'keys' && isSampledInstrument(track)
      ? { ...tile, hint: 'Sampler keyboard, root, and envelope.' }
      : tile)
  const volume = copyOf(TRACK_SHEET, 'volume')
  const buses = store.project.tracks.some((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const inputOptions = [
    ...INPUTS,
    ...participants.map((person) => ({ value: `remote:${person.id}`, label: `${person.name} · live` })),
  ]

  function openTile(id: TrackTile['id']) {
    onClose()
    if (id === 'keys') {
      if (isSampledInstrument(track)) store.showRack(track.id)
      else onPerform('keys')
      return
    }
    if (id === 'drums') {
      if (onOpenBeatMachine) onOpenBeatMachine(track.id)
      else store.insertPads(track.id)
      return
    }
    if (id === 'scaler') store.openScaler(track.id)
    if (id === 'patch') store.openPatch(track.id)
    if (id === 'rack') store.openRack(track.id)
    if (id === 'repair') {
      const clip = track.clips.find((item) => item.id === store.selectedClipId) ?? track.clips[0]
      if (clip) store.openSpectral(track.id, clip.id)
    }
  }

  function pressed(id: TrackTile['id']) {
    if (id === 'scaler') return store.scalerTrackId === track.id
    if (id === 'rack') return store.rackTrackId === track.id
    if (id === 'patch') return isSampledInstrument(track) ? store.rackTrackId === track.id : store.patchTrackId === track.id
    if (id === 'drums') return store.padsTrackId === track.id
    return false
  }

  const sequencer = hasStepSequencer(track)
  return (
    <div className="track-options">
      <label className="route-field track-rename">
        <span>Name</span>
        <input
          aria-label={`${track.name} name`}
          value={track.name}
          onChange={(event) => store.updateTrack(track.id, { name: event.target.value })}
        />
      </label>
      <div className="track-volume">
        <div className="track-volume-top">
          <span>Volume</span>
          <b>
            <DbRead
              gain={track.volume}
              min={0}
              max={1.25}
              label={`${track.name} volume decibels`}
              onFocus={() => store.beginAutomationTouch()}
              onBlur={() => store.endAutomationTouch()}
              onChange={(next) => {
                engine?.armMixFollow()
                store.updateTrack(track.id, { volume: next })
              }}
            />
          </b>
        </div>
        <div className="track-fader">
          <i className="track-meter" data-track-meter="" aria-hidden="true">
            <b style={{ width: `${Math.max(0, Math.min(1, level)) * 100}%` }} />
          </i>
          <VolumeRange store={store} engine={engine} trackId={track.id} volume={track.volume} label={`${volume.label}. ${volume.hint}`} title={volume.hint} />
        </div>
      </div>
      <div className="track-toggles" role="group" aria-label="Track switches">
        {armable && (
          <Toggle
            action="arm"
            label={track.armed ? 'Armed' : 'Arm'}
            hint={track.type === 'midi' ? 'Record this instrument from its MIDI input.' : copyOf(TRACK_ROW, 'arm').hint}
            pressed={track.armed}
            onClick={() => store.updateTrack(track.id, { armed: !track.armed })}
          />
        )}
        <Toggle
          action="solo-safe"
          label="Solo safe"
          hint="Stay audible when other tracks are soloed."
          pressed={!!track.soloSafe}
          onClick={() => store.updateTrack(track.id, { soloSafe: !track.soloSafe })}
        />
        <Toggle
          action="automation"
          label="Automation"
          hint="Show the automation lane for this track."
          pressed={automationOpen}
          onClick={() => store.toggleAutomation(track.id)}
        />
        {track.type === 'audio' && (
          <Toggle
            action="monitor"
            label="Monitor"
            hint={copyOf(TRACK_SHEET, 'monitor').hint}
            pressed={track.monitor}
            onClick={() => store.updateTrack(track.id, { monitor: !track.monitor })}
          />
        )}
        {track.type === 'audio' && (
          <Toggle
            action="auto-tune"
            label="Auto-Tune"
            hint="Add Auto-Tune on this track. It starts in key and audible."
            pressed={track.plugins.some((plugin) => plugin.pluginId === 'tune' && plugin.enabled)}
            onClick={() => { onClose(); addOrOpenAutoTune(store, track.id) }}
          />
        )}
      </div>
      {(track.type === 'midi' && !sequencer) || sequencer ? (
        <div className="track-toggles" role="group" aria-label="Editors">
          {track.type === 'midi' && !sequencer && (
            <Toggle action="roll" label="Roll" hint="Piano roll." pressed={false} onClick={() => { onClose(); onOpenPiano?.(track.id) }} />
          )}
          {sequencer && (
            <Toggle action="steps" label="Step Sequencer" hint="Open the step sequencer." pressed={false} onClick={() => { onClose(); onOpenSteps?.(track.id) }} />
          )}
        </div>
      ) : null}
      {tiles.length > 0 && (
        <section className="track-open" aria-label="Open">
          <h3>Open</h3>
          <div className="track-tiles">
            {tiles.map((tile) => (
              <button
                key={tile.id}
                type="button"
                className={`track-tile${pressed(tile.id) ? ' on' : ''}`}
                data-track-action={tile.id}
                aria-pressed={pressed(tile.id) ? true : undefined}
                title={tile.hint}
                aria-label={`${tile.label}. ${tile.hint}`}
                onClick={() => openTile(tile.id)}
              >
                <TileIcon id={tile.id} />
                <span>{tile.label}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="track-route">
        <RouteFields store={store} trackId={track.id} labeled />
        {track.type === 'audio' && (
          <label className="route-field track-input">
            <span>{copyOf(TRACK_SHEET, 'input').label}</span>
            <BevelSelect
              label={copyOf(TRACK_SHEET, 'input').label}
              hint={copyOf(TRACK_SHEET, 'input').hint}
              value={track.input}
              options={inputOptions}
              onChange={(next) => store.updateTrack(track.id, { input: next })}
            />
          </label>
        )}
      </div>
      <div className="track-plugins">
        {onOpenPlugins && (
          <button
            type="button"
            className="track-secondary"
            data-track-action="plugins"
            data-arrange-plugins="toggle"
            title="Effects on this track."
            aria-label="Plugins. Effects on this track."
            onClick={() => onOpenPlugins()}
          >
            Plugins
          </button>
        )}
        <InsertList store={store} trackId={track.id} />
      </div>
      {(track.sends.length > 0 || buses) && <SendList store={store} trackId={track.id} />}
      <button
        type="button"
        className="track-secondary"
        data-track-action="analyze"
        title="Analyze the key, chords, and sections of this track."
        aria-label="Analyze. Analyze the key, chords, and sections of this track."
        onClick={() => { onClose(); onAnalyze(track.id) }}
      >
        Analyze
      </button>
      <button
        type="button"
        className="track-danger"
        data-track-action="remove"
        data-confirm={confirmRemove ? '1' : '0'}
        title={copyOf(TRACK_SHEET, 'remove').hint}
        aria-label={confirmRemove ? 'Tap again to confirm. Delete this track and its clips.' : `${copyOf(TRACK_SHEET, 'remove').label}. ${copyOf(TRACK_SHEET, 'remove').hint}`}
        onClick={() => {
          if (!confirmRemove) {
            setConfirmRemove(true)
            return
          }
          store.removeTrack(track.id)
          onClose()
        }}
      >
        {confirmRemove ? 'Tap again to confirm' : 'Remove track'}
      </button>
    </div>
  )
}

function Toggle({
  action,
  label,
  hint,
  pressed,
  onClick,
}: {
  action: string
  label: string
  hint: string
  pressed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={pressed ? 'on' : ''}
      data-track-action={action}
      aria-pressed={pressed}
      title={hint}
      aria-label={`${label}. ${hint}`}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TileIcon({ id }: { id: TrackTile['id'] }) {
  const common = { width: 22, height: 22, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true }
  if (id === 'keys') return <svg {...common}><rect x="3" y="4" width="16" height="14" rx="1.5" /><path d="M7 4v8M11 4v8M15 4v8" /></svg>
  if (id === 'drums') return <svg {...common}><rect x="3" y="3" width="6" height="6" rx="1" /><rect x="13" y="3" width="6" height="6" rx="1" /><rect x="3" y="13" width="6" height="6" rx="1" /><rect x="13" y="13" width="6" height="6" rx="1" /></svg>
  if (id === 'scaler') return <svg {...common}><path d="M4 16V8M9 16V5M14 16v-7M19 16V6" /></svg>
  if (id === 'patch') return <svg {...common}><path d="M4 15l5-8 4 5 5-7" /></svg>
  if (id === 'rack') return <svg {...common}><rect x="3" y="4" width="16" height="14" rx="2" /><path d="M7 8v6M11 7v8M15 10v4" /></svg>
  return <svg {...common}><path d="M3 14c2-6 4 2 6-1s3 4 5 0 3 2 5-3" /></svg>
}

import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { Insert, InsertType } from '../model/types'
import type { ProjectStore } from '../state/store'

const INSERTS: InsertType[] = ['eq', 'compressor', 'delay', 'reverb']

export function MixerView({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const [selected, setSelected] = useState<{ trackId: string; insertId: string } | null>(null)
  const project = store.project
  const insert = selected
    ? (selected.trackId === 'master' ? project.masterInserts : store.track(selected.trackId)?.inserts)?.find((item) => item.id === selected.insertId)
    : undefined

  return (
    <div className="mixer">
      {project.tracks.map((track) => (
        <Strip
          key={track.id}
          name={track.name}
          color={track.color}
          volume={track.volume}
          pan={track.pan}
          mute={track.mute}
          solo={track.solo}
          inserts={track.inserts}
          engine={engine}
          meterId={track.id}
          onVolume={(volume) => store.updateTrack(track.id, { volume })}
          onPan={(pan) => store.updateTrack(track.id, { pan })}
          onMute={() => store.updateTrack(track.id, { mute: !track.mute })}
          onSolo={() => store.updateTrack(track.id, { solo: !track.solo })}
          onAdd={(type) => store.addInsert(track.id, type)}
          onPick={(insertId) => setSelected({ trackId: track.id, insertId })}
          onToggle={(insertId, enabled) => store.updateInsert(track.id, insertId, { enabled })}
        />
      ))}
      <Strip
        name="Master"
        color="var(--accent)"
        volume={project.masterVolume}
        pan={0}
        mute={false}
        solo={false}
        inserts={project.masterInserts}
        engine={engine}
        meterId="master"
        master
        onVolume={(volume) => store.setMasterVolume(volume)}
        onPan={() => undefined}
        onMute={() => undefined}
        onSolo={() => undefined}
        onAdd={(type) => store.addInsert('master', type)}
        onPick={(insertId) => setSelected({ trackId: 'master', insertId })}
        onToggle={(insertId, enabled) => store.updateInsert('master', insertId, { enabled })}
      />
      {insert && selected && (
        <div className="strip">
          <h3>
            {insert.type}{' '}
            <button className="mini" onClick={() => store.removeInsert(selected.trackId, insert.id)}>
              ×
            </button>
          </h3>
          <div className="knobs">
            {Object.entries(insert.params).map(([key, value]) => (
              <label key={key}>
                {key}
                <input
                  type="range"
                  min={rangeFor(insert.type, key).min}
                  max={rangeFor(insert.type, key).max}
                  step={rangeFor(insert.type, key).step}
                  value={value}
                  onChange={(event) =>
                    store.updateInsert(selected.trackId, insert.id, { params: { [key]: Number(event.target.value) } })
                  }
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Strip(props: {
  name: string
  color: string
  volume: number
  pan: number
  mute: boolean
  solo: boolean
  inserts: Insert[]
  engine: AudioEngine
  meterId: string
  master?: boolean
  onVolume: (value: number) => void
  onPan: (value: number) => void
  onMute: () => void
  onSolo: () => void
  onAdd: (type: InsertType) => void
  onPick: (id: string) => void
  onToggle: (id: string, enabled: boolean) => void
}) {
  return (
    <div className={`strip ${props.master ? 'master' : ''}`}>
      <h3 style={{ color: props.color }}>{props.name}</h3>
      <div className="inserts">
        {props.inserts.map((insert) => (
          <button key={insert.id} className={insert.enabled ? 'on' : ''} onClick={() => props.onPick(insert.id)} onDoubleClick={() => props.onToggle(insert.id, !insert.enabled)}>
            {insert.type} {insert.enabled ? '' : '(bypass)'}
          </button>
        ))}
        {props.inserts.length < 4 && (
          <select className="insert-add" value="" onChange={(event) => event.target.value && props.onAdd(event.target.value as InsertType)}>
            <option value="">+ insert</option>
            {INSERTS.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        )}
      </div>
      {!props.master && <input className="pan" type="range" min={-1} max={1} step={0.01} value={props.pan} onChange={(event) => props.onPan(Number(event.target.value))} />}
      <div className="fader-row">
        <Meter engine={props.engine} id={props.meterId} />
        <input type="range" min={0} max={1.25} step={0.01} value={props.volume} onChange={(event) => props.onVolume(Number(event.target.value))} />
      </div>
      {!props.master && (
        <div className="row">
          <button className={`mini ${props.mute ? 'on-m' : ''}`} onClick={props.onMute}>
            M
          </button>
          <button className={`mini ${props.solo ? 'on-s' : ''}`} onClick={props.onSolo}>
            S
          </button>
        </div>
      )}
    </div>
  )
}

function Meter({ engine, id }: { engine: AudioEngine; id: string }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const levels = engine.levels()
      const value = Math.min(1, (id === 'master' ? levels.master : levels.tracks[id] || 0) * 3.2)
      setLevel((prev) => (Math.abs(prev - value) < 0.03 ? prev : value))
      timer = window.setTimeout(tick, 80)
    }
    timer = window.setTimeout(tick, 80)
    return () => window.clearTimeout(timer)
  }, [engine, id])
  return (
    <div className="meter">
      <b style={{ height: `${level * 100}%` }} />
    </div>
  )
}

function rangeFor(type: InsertType, key: string) {
  if (type === 'eq' && key === 'midFreq') return { min: 200, max: 8000, step: 10 }
  if (type === 'eq') return { min: -18, max: 12, step: 0.1 }
  if (key === 'threshold') return { min: -60, max: 0, step: 0.5 }
  if (key === 'ratio') return { min: 1, max: 20, step: 0.1 }
  if (key === 'attack' || key === 'release' || key === 'time' || key === 'decay') return { min: 0, max: key === 'decay' ? 6 : 1, step: 0.01 }
  if (key === 'mix' || key === 'feedback') return { min: 0, max: key === 'feedback' ? 0.85 : 1, step: 0.01 }
  return { min: -12, max: 12, step: 0.1 }
}

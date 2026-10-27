import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'
import { InsertList, RouteFields, SendList } from './PluginSheet'

export function MixerView({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const project = store.project
  return (
    <div className="mixer">
      {project.tracks.map((track) => (
        <div className="strip" key={track.id}>
          <h3 style={{ color: track.color }}>{track.name}</h3>
          <RouteFields store={store} trackId={track.id} />
          <InsertList store={store} trackId={track.id} />
          <SendList store={store} trackId={track.id} />
          <input className="pan" type="range" min={-1} max={1} step={0.01} value={track.pan} onChange={(event) => store.updateTrack(track.id, { pan: Number(event.target.value) })} />
          <div className="fader-row">
            <Meter engine={engine} id={track.id} />
            <input type="range" min={0} max={1.25} step={0.01} value={track.volume} onChange={(event) => store.updateTrack(track.id, { volume: Number(event.target.value) })} />
          </div>
          <div className="row">
            <button className={`mini ${track.mute ? 'on-m' : ''}`} onClick={() => store.updateTrack(track.id, { mute: !track.mute })}>M</button>
            <button className={`mini ${track.solo ? 'on-s' : ''}`} onClick={() => store.updateTrack(track.id, { solo: !track.solo })}>S</button>
          </div>
        </div>
      ))}
      <div className="strip master">
        <h3>Master</h3>
        <InsertList store={store} trackId="master" />
        <Readout engine={engine} />
        <div className="fader-row">
          <Meter engine={engine} id="master" />
          <input type="range" min={0} max={1.25} step={0.01} value={project.masterVolume} onChange={(event) => store.setMasterVolume(Number(event.target.value))} />
        </div>
      </div>
    </div>
  )
}

function Readout({ engine }: { engine: AudioEngine }) {
  const [text, setText] = useState('0% · -70.0 LUFS · -70.0 dB')
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const meters = engine.mixMeters()
      const next = `${Math.round(meters.cpu * 100)}% · ${meters.lufs.toFixed(1)} LUFS · ${meters.truePeak.toFixed(1)} dB`
      setText((prev) => (prev === next ? prev : next))
      timer = window.setTimeout(tick, 200)
    }
    timer = window.setTimeout(tick, 200)
    return () => window.clearTimeout(timer)
  }, [engine])
  return <div className="readout">{text}</div>
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

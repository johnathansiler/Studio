import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { CATALOG, FACTORY, descriptor } from '../audio/plugins/catalog'
import { MODEL_IDS } from '../audio/plugins/models'
import { Faceplate } from './Faceplate'
import { NOTE_NAMES, SCALES } from '../model/scale'
import { samplesToBeats } from '../model/time'
import type { PluginInstance } from '../model/types'
import type { ProjectStore } from '../state/store'

export function PluginSheet({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const focus = store.pluginFocus
  const plugin = focus ? findPlugin(store, focus.trackId, focus.pluginId) : null
  const spec = plugin ? descriptor(plugin.pluginId) : null
  const [last, setLast] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  const [, setTick] = useState(0)
  const faced = plugin ? MODEL_IDS.includes(plugin.pluginId) || plugin.pluginId === 'tune' : false
  useEffect(() => {
    if (!faced) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 80)
    return () => window.clearInterval(timer)
  }, [faced, plugin?.id])
  useEffect(() => {
    if (!plugin || plugin.pluginId !== 'eq') return
    let timer = 0
    const draw = () => {
      const spectrum = engine.spectrum(plugin.id)
      const ctx = canvas.current?.getContext('2d')
      const view = canvas.current
      if (ctx && view) {
        ctx.clearRect(0, 0, view.width, view.height)
        ctx.fillStyle = '#73c48f'
        const bins = spectrum?.length ?? 32
        const slot = view.width / bins
        for (let i = 0; i < bins; i++) {
          const mag = spectrum ? Math.min(1, spectrum[i] || 0) : 0
          const h = mag * view.height
          ctx.fillRect(i * slot, view.height - h, Math.max(1, slot - 1), h)
        }
      }
      timer = window.setTimeout(draw, 100)
    }
    timer = window.setTimeout(draw, 100)
    return () => window.clearTimeout(timer)
  }, [engine, plugin])
  if (!focus || !plugin || !spec) return null
  const names = [
    ...(FACTORY[plugin.pluginId] ?? []).map((item) => item.name),
    ...store.project.presets.filter((item) => item.pluginId === plugin.pluginId).map((item) => item.name),
  ]
  const buses = store.project.tracks.filter((track) => track.type === 'bus' || track.type === 'group' || track.type === 'audio')
  const point = () => {
    const param = last || spec.params[0]?.id
    if (!param) return
    const beat = samplesToBeats(engine.currentTimelineSample(), engine.sampleRate, store.project.tempo)
    store.addAutomationPoint(plugin.id, param, beat, plugin.params[param] ?? 0)
  }
  return (
    <div className="plugin-sheet" role="dialog" aria-label={spec.name}>
      <header>
        <strong>{spec.name}</strong>
        <select value="" onChange={(event) => event.target.value && store.applyPluginPreset(focus.trackId, plugin.id, event.target.value)}>
          <option value="">Preset</option>
          {names.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button className="text-btn" onClick={() => {
          const name = window.prompt('Preset')
          if (name) store.savePluginPreset(plugin.pluginId, name.trim(), plugin.params)
        }}>Save</button>
        <button className={`text-btn ${plugin.enabled ? 'on' : ''}`} onClick={() => store.updatePlugin(focus.trackId, plugin.id, { enabled: !plugin.enabled })}>
          {plugin.enabled ? 'On' : 'Bypass'}
        </button>
        <button className="text-btn" onClick={() => store.focusPlugin(null)}>×</button>
      </header>
      <label className="wet">
        Wet
        <input type="range" min={0} max={1} step={0.01} value={plugin.wet} onChange={(event) => store.updatePlugin(focus.trackId, plugin.id, { wet: Number(event.target.value) })} />
      </label>
      {plugin.pluginId === 'compressor' && (
        <select value={plugin.sidechain} onChange={(event) => store.updatePlugin(focus.trackId, plugin.id, { sidechain: event.target.value })}>
          <option value="">Sidechain</option>
          {buses.filter((track) => track.id !== focus.trackId).map((track) => (
            <option key={track.id} value={track.id}>{track.name}</option>
          ))}
        </select>
      )}
      {plugin.pluginId === 'eq' && <canvas ref={canvas} width={320} height={64} className="spectrum" />}
      {faced && (
        <Faceplate
          pluginId={plugin.pluginId}
          title={spec.name}
          params={spec.params}
          values={plugin.params}
          vu={engine.meter(plugin.id)?.vu ?? -20}
          gr={engine.meter(plugin.id)?.gr ?? 0}
          trace={engine.trace(plugin.id)}
          onChange={(id, value) => {
            setLast(id)
            store.updatePlugin(focus.trackId, plugin.id, { params: { [id]: value } })
          }}
        />
      )}
      {!faced ? <div className="knobs">
        {spec.params.map((param) => (
          <label key={param.id}>
            {param.name} {formatParam(param.id, plugin.params[param.id] ?? param.default, param.unit)}
            <ParamControl
              id={param.id}
              min={param.min}
              max={param.max}
              value={plugin.params[param.id] ?? param.default}
              onChange={(value) => {
                setLast(param.id)
                store.updatePlugin(focus.trackId, plugin.id, { params: { [param.id]: value } })
              }}
            />
          </label>
        ))}
      </div> : null}
      <div className="row">
        <button className="text-btn" onClick={() => store.movePlugin(focus.trackId, plugin.id, -1)}>←</button>
        <button className="text-btn" onClick={() => store.movePlugin(focus.trackId, plugin.id, 1)}>→</button>
        <button className="text-btn" onClick={() => store.removePlugin(focus.trackId, plugin.id)}>Remove</button>
        <button className="text-btn" onClick={point}>Point</button>
      </div>
    </div>
  )
}

function ParamControl({ id, min, max, value, onChange }: { id: string; min: number; max: number; value: number; onChange: (value: number) => void }) {
  if (id === 'mode') {
    return (
      <select value={value >= 0.5 ? 1 : 0} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>Chromatic</option>
        <option value={1}>Scale</option>
      </select>
    )
  }
  if (id === 'root') {
    return (
      <select value={Math.round(value)} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={-1}>Project</option>
        {NOTE_NAMES.map((name, index) => (
          <option key={name} value={index}>{name}</option>
        ))}
      </select>
    )
  }
  if (id === 'scaleIndex') {
    return (
      <select value={Math.round(value)} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={-1}>Project</option>
        {SCALES.map((scale, index) => (
          <option key={scale.id} value={index}>{scale.name}</option>
        ))}
      </select>
    )
  }
  const span = max - min
  const step = span <= 2 ? 0.01 : span <= 40 ? 0.1 : 1
  return <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
}

function formatParam(id: string, value: number, unit: string) {
  if (id === 'mode' || id === 'root' || id === 'scaleIndex') return ''
  const shown = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return unit ? `${shown} ${unit}` : `${shown}`
}

export function InsertList({ store, trackId }: { store: ProjectStore; trackId: string | 'master' }) {
  const plugins = trackId === 'master' ? store.project.masterPlugins : store.track(trackId)?.plugins ?? []
  return (
    <div className="inserts">
      {plugins.map((plugin) => (
        <button
          key={plugin.id}
          className={plugin.enabled ? 'on' : ''}
          onClick={() => store.focusPlugin(trackId, plugin.id)}
          onDoubleClick={() => store.updatePlugin(trackId, plugin.id, { enabled: !plugin.enabled })}
        >
          {descriptor(plugin.pluginId)?.name ?? plugin.pluginId}
        </button>
      ))}
      <select className="insert-add" value="" onChange={(event) => addChoice(store, trackId, event.target.value)}>
        <option value="">+</option>
        {CATALOG.map((plugin) => (
          <option key={plugin.id} value={plugin.id}>{plugin.name}</option>
        ))}
        {trackId !== 'master' && <option value="vocal">Vocal chain</option>}
      </select>
    </div>
  )
}

export function SendList({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const buses = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== trackId)
  return (
    <div className="sends">
      {track.sends.map((send) => (
        <label key={send.id}>
          <span>{buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'}</span>
          <input type="range" min={0} max={1} step={0.01} value={send.gain} onChange={(event) => store.updateSend(trackId, send.id, { gain: Number(event.target.value) })} />
          <button type="button" className={`mini ${send.preFader ? 'on' : ''}`} onClick={() => store.updateSend(trackId, send.id, { preFader: !send.preFader })}>
            {send.preFader ? 'Pre' : 'Post'}
          </button>
          <button type="button" className="mini" onClick={() => store.removeSend(trackId, send.id)}>×</button>
        </label>
      ))}
      {buses.length > 0 && (
        <select className="insert-add" value="" onChange={(event) => event.target.value && store.addSend(trackId, event.target.value)}>
          <option value="">+</option>
          {buses.map((bus) => (
            <option key={bus.id} value={bus.id}>{bus.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export function RouteFields({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const groups = targets.filter((item) => item.type === 'group')
  return (
    <div className="route-fields">
      <select value={track.output ?? ''} onChange={(event) => store.updateTrack(track.id, { output: event.target.value || null })}>
        <option value="">{track.input.startsWith('remote:') ? 'Cue' : 'Master'}</option>
        {targets.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
      <select value={track.groupId ?? ''} onChange={(event) => store.updateTrack(track.id, { groupId: event.target.value || null })}>
        <option value="">—</option>
        {groups.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
      </select>
    </div>
  )
}

function addChoice(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value) return
  if (value === 'vocal' && trackId !== 'master') store.addVocalChain(trackId)
  else store.addPlugin(trackId, value)
}

function findPlugin(store: ProjectStore, trackId: string, pluginId: string): PluginInstance | null {
  const list = trackId === 'master' ? store.project.masterPlugins : store.track(trackId)?.plugins
  return list?.find((item) => item.id === pluginId) ?? null
}

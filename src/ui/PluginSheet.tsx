import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { MASTERING_IDS } from '../audio/master/assistant'
import { activeTunePreset, orderedInserts, tuneScaleOf } from '../audio/plugins/autoTune'
import { CATALOG, FACTORY, descriptor } from '../audio/plugins/catalog'
import { MODEL_IDS } from '../audio/plugins/models'
import { AmpPop } from './AmpPop'
import { AutoTuneFace } from './AutoTuneFace'
import { Faceplate } from './Faceplate'
import { NOTE_NAMES, SCALES } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import { selectPlugin } from '../state/select'
import type { ProjectStore } from '../state/store'
import { SamplePanel } from './SamplePanel'

export function PluginSheet({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const focus = store.pluginFocus
  const plugin = focus ? selectPlugin(store, focus.trackId, focus.pluginId) : null
  const spec = plugin ? descriptor(plugin.pluginId) : null
  const [last, setLast] = useState('')
  const [sheetHeight, setSheetHeight] = useState(tuneSheetHeight)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tick, setTick] = useState(0)
  const autoTune = plugin?.pluginId === 'tune'
  const faced = plugin ? MODEL_IDS.includes(plugin.pluginId) || !!autoTune : false
  useEffect(() => {
    if (!faced) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 80)
    return () => window.clearInterval(timer)
  }, [faced, plugin?.id])
  useEffect(() => {
    if (!plugin || engine.performanceMode || (plugin.pluginId !== 'eq' && plugin.pluginId !== 'meq' && plugin.pluginId !== 'meter')) return
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
  if (plugin.pluginId === 'amp') return <AmpPop store={store} engine={engine} trackId={focus.trackId} plugin={plugin} />
  const names = [
    ...(FACTORY[plugin.pluginId] ?? []).map((item) => item.name),
    ...store.project.presets.filter((item) => item.pluginId === plugin.pluginId).map((item) => item.name),
  ]
  const song = tuneScaleOf(store.scaleState())
  const tunePresets = [
    ...(FACTORY.tune ?? []),
    ...store.project.presets.filter((item) => item.pluginId === 'tune'),
  ]
  const buses = store.project.tracks.filter((track) => track.id !== focus.trackId)
  const rolling = () => engine.status === 'playing' || engine.status === 'recording'
  const point = () => {
    const param = last || spec.params[0]?.id
    if (!param) return
    const beat = projectSampleBeat(store.project, engine.currentTimelineSample())
    store.addAutomationPoint(plugin.id, param, beat, plugin.params[param] ?? 0)
  }
  const resize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startY = event.clientY
    const startH = sheetHeight
    const move = (ev: PointerEvent) => {
      const next = Math.min(window.innerHeight - 8, Math.max(420, startH + (startY - ev.clientY)))
      setSheetHeight(next)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className={`plugin-sheet ${autoTune ? 'tune-open' : ''}`} role="dialog" aria-label={spec.name} style={autoTune ? { height: sheetHeight } : undefined}>
      {autoTune && <div className="tune-resize" title="Drag to resize the plugin." aria-label="Resize plugin. Drag up or down." onPointerDown={resize} />}
      <header>
        <strong>{spec.name}</strong>
        {!autoTune && (
          <select value="" onChange={(event) => event.target.value && store.applyPluginPreset(focus.trackId, plugin.id, event.target.value)}>
            <option value="">Preset</option>
            {names.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        )}
        {!autoTune && (
        <button className="text-btn" title="Save these settings as a preset." aria-label="Save preset. Keep these settings under a name." onClick={() => {
          const name = window.prompt('Preset')
          if (name) store.savePluginPreset(plugin.pluginId, name.trim(), plugin.params)
        }}>Save</button>
        )}
        {!autoTune && (
          <button className={`text-btn ${plugin.enabled ? 'on' : ''}`} onClick={() => store.updatePlugin(focus.trackId, plugin.id, { enabled: !plugin.enabled })}>
            {plugin.enabled ? 'On' : 'Bypass'}
          </button>
        )}
        <button className="text-btn" title="Close the plugin." aria-label="Close the plugin." onClick={() => store.focusPlugin(null)}>×</button>
      </header>
      {plugin.pluginId !== 'tune' && (
      <label className="wet">
        Wet
        <input type="range" min={0} max={1} step={0.01} value={plugin.wet} onChange={(event) => store.updatePlugin(focus.trackId, plugin.id, { wet: Number(event.target.value) })} />
      </label>
      )}
      {(plugin.pluginId === 'compressor' || plugin.pluginId === 'gate') && (
        <label>
          Sidechain key
          <select aria-label="Sidechain key" title="Route any track or bus into this compressor or gate." value={plugin.sidechain} onChange={(event) => store.updatePlugin(focus.trackId, plugin.id, { sidechain: event.target.value })}>
            <option value="">Input</option>
            {buses.map((track) => (
              <option key={track.id} value={track.id}>{track.name}</option>
            ))}
          </select>
        </label>
      )}
      {plugin.pluginId === 'compressor' && (
        <button type="button" className="text-btn" title="Ducking preset: heavy compression for a sidechain key." onClick={() => store.applyPluginPreset(focus.trackId, plugin.id, 'Duck')}>Duck</button>
      )}
      {plugin.pluginId === 'eq' && <canvas ref={canvas} width={320} height={64} className="spectrum" />}
      {(plugin.pluginId === 'sampler' || plugin.pluginId === 'looper') && (
        <SamplePanel store={store} engine={engine} trackId={focus.trackId} plugin={plugin} />
      )}
      {autoTune && (
        <div className="tune-body" onPointerDownCapture={() => store.beginAutomationTouch()} onPointerUp={() => { store.endAutomationTouch(); store.endDraft() }} onPointerCancel={() => { store.endAutomationTouch(); store.endDraft() }}>
        <AutoTuneFace
          values={plugin.params}
          trace={engine.trace(plugin.id)}
          revision={tick}
          enabled={plugin.enabled}
          projectKey={song.note}
          projectScale={song.scaleName}
          projectRoot={song.root}
          projectIntervals={song.intervals}
          active={activeTunePreset(plugin.params, tunePresets)}
          presets={tunePresets.map((item) => item.name)}
          onChange={(id, value) => {
            setLast(id)
            store.updatePlugin(focus.trackId, plugin.id, { params: { [id]: value } })
          }}
          onPatch={(patch) => store.updatePlugin(focus.trackId, plugin.id, { params: patch })}
          onPreset={(name) => store.applyPluginPreset(focus.trackId, plugin.id, name)}
          onBypass={() => store.updatePlugin(focus.trackId, plugin.id, { enabled: !plugin.enabled })}
          onSave={(name) => store.savePluginPreset(plugin.pluginId, name, plugin.params)}
        />
        </div>
      )}
      {faced && !autoTune && (
        <div onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
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
            const param = spec.params.find((item) => item.id === id)
            store.setAutomated(
              { trackId: focus.trackId, target: 'plugin', pluginId: plugin.id, param: id, min: param?.min ?? 0, max: param?.max ?? 1 },
              value,
              rolling(),
              engine.currentTimelineSample(),
            )
          }}
        />
        </div>
      )}
      {!faced && plugin.pluginId !== 'sampler' && plugin.pluginId !== 'looper' ? <div className="knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
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
                store.setAutomated(
                  { trackId: focus.trackId, target: 'plugin', pluginId: plugin.id, param: param.id, min: param.min, max: param.max },
                  value,
                  rolling(),
                  engine.currentTimelineSample(),
                )
              }}
            />
          </label>
        ))}
      </div> : null}
      <div className="row">
        <button className="text-btn" title="Move this plugin earlier." aria-label="Move this plugin earlier." onClick={() => store.movePlugin(focus.trackId, plugin.id, -1)}>←</button>
        <button className="text-btn" title="Move this plugin later." aria-label="Move this plugin later." onClick={() => store.movePlugin(focus.trackId, plugin.id, 1)}>→</button>
        <button className="text-btn" title="Remove this plugin." aria-label="Remove this plugin." onClick={() => store.removePlugin(focus.trackId, plugin.id)}>Remove</button>
        <button className="text-btn" title="Write an automation point." aria-label="Point. Write an automation point." onClick={point}>Point</button>
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
          type="button"
          className={plugin.enabled ? 'on' : ''}
          title={descriptor(plugin.pluginId)?.name ?? plugin.pluginId}
          aria-label={`${descriptor(plugin.pluginId)?.name ?? plugin.pluginId}. Open this insert.`}
          onPointerDown={(event) => {
            if (event.button !== 0) return
            event.stopPropagation()
            store.focusPlugin(trackId, plugin.id)
          }}
          onClick={() => store.focusPlugin(trackId, plugin.id)}
          onDoubleClick={() => store.updatePlugin(trackId, plugin.id, { enabled: !plugin.enabled })}
        >
          {insertLabel(plugin.pluginId)}
        </button>
      ))}
      <select className="insert-add" aria-label="Add insert" title="Add an effect. Auto-Tune is first." value="" onChange={(event) => addChoice(store, trackId, event.target.value)}>
        <option value="">+</option>
        {orderedInserts(CATALOG.filter((plugin) => plugin.id !== 'meter' && (trackId === 'master' || !(MASTERING_IDS as readonly string[]).includes(plugin.id)))).map((plugin) => (
          <option key={plugin.id} value={plugin.id}>{plugin.name}</option>
        ))}
        {trackId !== 'master' && <option value="vocal">Vocal chain</option>}
      </select>
    </div>
  )
}

export function SendList({ store, trackId, engine }: { store: ProjectStore; trackId: string; engine?: AudioEngine }) {
  const track = store.track(trackId)
  if (!track) return null
  const buses = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== trackId)
  return (
    <div className="sends">
      {track.sends.map((send) => (
        <label key={send.id}>
          <span>{buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            aria-label={`${buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'} level`}
            title="Send level. Latch and touch write this while playing."
            value={send.gain}
            onPointerDown={() => store.beginAutomationTouch()}
            onPointerUp={() => store.endAutomationTouch()}
            onPointerCancel={() => store.endAutomationTouch()}
            onChange={(event) => {
              const rolling = !!engine && (engine.status === 'playing' || engine.status === 'recording')
              store.setAutomated(
                { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 },
                Number(event.target.value),
                rolling,
                engine?.currentTimelineSample() ?? 0,
              )
            }}
          />
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

/** Strip slots are narrow. Auto-Tune keeps its full name in the picker and the sheet. */
export function insertLabel(pluginId: string) {
  if (pluginId === 'tune') return 'Tune'
  return descriptor(pluginId)?.name ?? pluginId
}

function tuneSheetHeight() {
  if (typeof window === 'undefined') return 680
  return Math.min(740, Math.max(560, window.innerHeight - 16))
}

function addChoice(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value) return
  if (value === 'vocal' && trackId !== 'master') store.addVocalChain(trackId)
  else store.addPlugin(trackId, value)
}


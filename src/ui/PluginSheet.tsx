import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ComponentProps, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { activeTunePreset, tuneScaleOf } from '../audio/plugins/autoTune'
import { FACTORY, descriptor } from '../audio/plugins/catalog'
import { commitPluginPreset } from '../presets/project'
import { isDrumsPlugin, kindLabels, paramsForKind } from '../audio/plugins/ids'
import { controlChoices, controlLabel, controlText } from '../audio/plugins/readout'
import { PresetControls } from './PresetControls'
import { TouchSlider } from './kit/controls'
import { AmpPop } from './AmpPop'
import { AutoTuneFace } from './AutoTuneFace'
import { useFormFactor, useLandscape } from './form'
import { PluginPages, chunkParams } from './PluginPages'
import { NOTE_NAMES, SCALES } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import { selectPlugin } from '../state/select'
import type { ProjectStore } from '../state/store'
import { ChunkBoundary, moduleView } from './lazyViews'
import { SamplePanel } from './SamplePanel'
import { useScreenOverlay } from './screenOverlay'

type FaceProps = ComponentProps<typeof import('./faces/PluginFace').PluginFace>
const loadPluginFace = moduleView(() => import('./faces/PluginFace'), 'PluginFace')

function PluginFace(props: FaceProps) {
  const [attempt, setAttempt] = useState(0)
  const View = useMemo(() => lazy(() => loadPluginFace(attempt)), [attempt])
  return (
    <ChunkBoundary key={attempt} label="Faceplate" className="face-hint" onRetry={() => setAttempt((value) => value + 1)}>
      <Suspense fallback={<p className="face-hint">Loading the faceplate.</p>}>
        <View {...props} />
      </Suspense>
    </ChunkBoundary>
  )
}

export function PluginSheet({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const focus = store.pluginFocus
  const plugin = focus ? selectPlugin(store, focus.trackId, focus.pluginId) : null
  const spec = plugin ? descriptor(plugin.pluginId) : null
  const [last, setLast] = useState('')
  const [sheetHeight, setSheetHeight] = useState(tuneSheetHeight)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [tick, setTick] = useState(0)
  const [sheetWidth, setSheetWidth] = useState(480)
  const form = useFormFactor()
  const land = useLandscape()
  const compact = form !== 'desk'
  const autoTune = plugin?.pluginId === 'tune'
  const sampleFace = plugin?.pluginId === 'sampler' && !isDrumsPlugin(plugin)
  const ampFace = plugin?.pluginId === 'saturator' && Math.round(plugin.params.kind ?? 0) === 5
  const customFace = !!plugin && !autoTune && !ampFace && !sampleFace
  const faced = !!autoTune || customFace || sampleFace || ampFace
  useScreenOverlay(() => store.focusPlugin(null), !!(focus && plugin && spec))
  useEffect(() => {
    if (!faced) return
    const timer = window.setInterval(() => setTick((value) => value + 1), 80)
    return () => window.clearInterval(timer)
  }, [faced, plugin?.id])
  useEffect(() => {
    if (!plugin || engine.performanceMode || (plugin.pluginId !== 'eq' && plugin.pluginId !== 'limiter')) return
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
  if (ampFace) return <AmpPop store={store} engine={engine} trackId={focus.trackId} plugin={plugin} />
  const shown = paramsForKind(plugin.pluginId, plugin.params.kind ?? 0)
  const faceParams = shown ? spec.params.filter((param) => shown.includes(param.id)) : spec.params
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
  const resizeWidth = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startX = event.clientX
    const startW = sheetWidth
    const move = (ev: PointerEvent) => {
      setSheetWidth(Math.min(760, Math.max(320, startW + (startX - ev.clientX))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const resizeHeight = (event: ReactPointerEvent<HTMLDivElement>) => {
    const startY = event.clientY
    const startH = sheetHeight
    const move = (ev: PointerEvent) => {
      setSheetHeight(Math.min(window.innerHeight - 8, Math.max(420, startH + (startY - ev.clientY))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className={`plugin-sheet ${autoTune ? 'tune-open' : ''}`} role="dialog" aria-label={spec.name} data-plugin-root="" data-screen-overlay="" style={autoTune ? undefined : compact ? undefined : { width: sheetWidth }}>
      {autoTune ? (
        <div className="tune-resize" title="Drag to resize the plugin." aria-label="Resize plugin. Drag up or down." onPointerDown={resizeHeight} />
      ) : (
        <div className="sheet-resize" title="Drag to resize the plugin." aria-label="Resize plugin. Drag the edge." onPointerDown={resizeWidth} />
      )}
      <header>
        <strong>{spec.name}</strong>
        <PresetControls
          pluginId={plugin.pluginId}
          instanceKey={plugin.id}
          values={plugin.params}
          presets={store.project.presets}
          onCommit={(next) => commitPluginPreset(store, focus.trackId, plugin.id, next.params, next.presets, plugin.pluginId === 'steps')}
        />
        {!autoTune && (
          <button className={`text-btn ${plugin.enabled ? 'on' : ''}`} onClick={() => store.updatePlugin(focus.trackId, plugin.id, { enabled: !plugin.enabled })}>
            {plugin.enabled ? 'On' : 'Bypass'}
          </button>
        )}
        <button className="text-btn overlay-close" title="Close the plugin." aria-label="Close the plugin." onClick={() => store.focusPlugin(null)}>Close</button>
      </header>
      {!sampleFace && !autoTune && (
        <PluginPages
          label={`${spec.name} pages`}
          pages={[
            ...(customFace ? [{
              id: 'face',
              label: 'Face',
              node: (
                <Suspense fallback={<p className="face-hint">Loading the faceplate.</p>}>
                  <div onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
                    <PluginFace
                      pluginId={plugin.pluginId}
                      params={faceParams}
                      values={plugin.params}
                      vu={engine.meter(plugin.id)?.vu ?? -20}
                      gr={engine.meter(plugin.id)?.gr ?? 0}
                      spectrum={engine.spectrum(plugin.id)}
                      compact={compact}
                      showParams={false}
                      keyboard={false}
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
                      onNote={(note, down) => {
                        if (down) engine.previewSample(plugin.id, note)
                      }}
                    />
                  </div>
                </Suspense>
              ),
            }] : []),
            ...chunkParams(faceParams, form === 'phone' && land ? 4 : form === 'phone' ? 8 : 12).map((group, index) => ({
              id: `controls-${index}`,
              label: group.length === 1 ? group[0].name : `${group[0].name} to ${group[group.length - 1].name}`,
              node: (
                <div className="plugin-controls" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
                  {group.map((param) => (
                    <label key={param.id}>
                      {controlLabel(plugin.pluginId, param.id, param.name)} {formatParam(plugin.pluginId, param.id, plugin.params[param.id] ?? param.default, param.unit)}
                      <ParamControl
                        pluginId={plugin.pluginId}
                        id={param.id}
                        name={controlLabel(plugin.pluginId, param.id, param.name)}
                        min={param.min}
                        max={param.max}
                        labels={param.id === 'kind' ? kindLabels(plugin.pluginId) : controlChoices(plugin.pluginId, param.id) ?? []}
                        value={plugin.params[param.id] ?? param.default}
                        fallback={param.default}
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
                </div>
              ),
            })),
            {
              id: 'route',
              label: 'Route',
              node: (
                <>
                  <label className="wet" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
                    Wet
                    <TouchSlider label="Wet" min={0} max={1} step={0.01} value={plugin.wet} fallback={1} onChange={(value) => store.updatePlugin(focus.trackId, plugin.id, { wet: value })} />
                  </label>
                  {(plugin.pluginId === 'compressor' || plugin.pluginId === 'vocal') && (
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
                  <div className="row slot-actions eq-grid" style={{ ['--eq-cols' as string]: '4' }}>
                    <button className="text-btn" title="Move this plugin earlier." aria-label="Move this plugin earlier." onClick={() => store.movePlugin(focus.trackId, plugin.id, -1)}>Earlier</button>
                    <button className="text-btn" title="Move this plugin later." aria-label="Move this plugin later." onClick={() => store.movePlugin(focus.trackId, plugin.id, 1)}>Later</button>
                    <button className="text-btn" title="Remove this plugin." aria-label="Remove this plugin." onClick={() => store.removePlugin(focus.trackId, plugin.id)}>Remove</button>
                    <button className="text-btn" title="Write an automation point." aria-label="Point. Write an automation point." onClick={point}>Point</button>
                  </div>
                </>
              ),
            },
          ]}
        />
      )}
      {sampleFace && <SamplePanel store={store} engine={engine} trackId={focus.trackId} plugin={plugin} vu={engine.meter(plugin.id)?.vu} />}
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
          sharedBar
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
    </div>
  )
}

function ParamControl({ pluginId, id, name, min, max, value, fallback, onChange, labels = [] }: { pluginId: string; id: string; name?: string; min: number; max: number; value: number; fallback?: number; onChange: (value: number) => void; labels?: readonly string[] }) {
  if ((id === 'kind' || labels.length > 0) && labels.length) {
    const aria = id === 'kind' ? 'Kind' : (name ?? id)
    return (
      <select aria-label={aria} value={Math.max(0, Math.min(labels.length - 1, Math.round(value)))} onChange={(event) => onChange(Number(event.target.value))}>
        {labels.map((name, index) => <option key={name} value={index}>{name}</option>)}
      </select>
    )
  }
  if (pluginId === 'tune' && id === 'mode') {
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
  return <TouchSlider label={id} min={min} max={max} step={step} value={value} fallback={fallback} onChange={onChange} />
}

function formatParam(pluginId: string, id: string, value: number, unit: string) {
  if (pluginId === 'tune' && (id === 'mode' || id === 'root' || id === 'scaleIndex')) return ''
  return controlText(pluginId, id, value, unit)
}

export {
  InsertList,
  SendList,
  RouteFields,
  insertChoices,
  insertMenuChoices,
  addInsert,
  clipInsertName,
  isInstrumentSource,
  stripCanHost,
  stripSlotChoices,
  addStripInsert,
  StripInserts,
} from './pluginInserts'
export { insertLabel } from './insertLabel'

function tuneSheetHeight() {
  if (typeof window === 'undefined') return 680
  return Math.min(740, Math.max(560, window.innerHeight - 16))
}


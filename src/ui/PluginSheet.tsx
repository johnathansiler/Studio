import { lazy, Suspense, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { activeTunePreset, orderedInserts, tuneScaleOf } from '../audio/plugins/autoTune'
import { CATALOG, FACTORY, descriptor } from '../audio/plugins/catalog'
import { commitPluginPreset } from '../presets/project'
import { INSTRUMENT_IDS, isDrumsPlugin, kindLabels, paramsForKind } from '../audio/plugins/ids'
import { controlChoices, controlLabel, controlText } from '../audio/plugins/readout'
import { insertsBeatMachine } from '../instruments/pads/identity'
import { chainSections, trackHasScaler } from '../instruments/scaler/chain'
import { AnchoredMenu } from './AnchoredMenu'
import { PresetControls } from './PresetControls'
import { TouchSlider } from './kit/controls'
import { AmpPop } from './AmpPop'
import { AutoTuneFace } from './AutoTuneFace'
import { useFormFactor, useLandscape } from './form'
import { PluginPages, chunkParams } from './PluginPages'
import { BevelSelect } from './BevelSelect'
import { NOTE_NAMES, SCALES } from '../model/scale'
import { projectSampleBeat } from '../model/tempoMap'
import { selectPlugin } from '../state/select'
import type { ProjectStore } from '../state/store'
import { insertLabel } from './insertLabel'
import { SamplePanel } from './SamplePanel'
import { useScreenOverlay } from './screenOverlay'

const PluginFace = lazy(() => import('./faces/PluginFace').then((mod) => ({ default: mod.PluginFace })))

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

export function InsertList({ store, trackId, roomy = false }: { store: ProjectStore; trackId: string | 'master'; roomy?: boolean }) {
  const track = trackId === 'master' ? null : store.track(trackId)
  const plugins = trackId === 'master' ? store.project.masterPlugins : track?.plugins ?? []
  if (track && trackHasScaler(track)) {
    const sections = chainSections(track)
    return (
      <div className="inserts" data-chain="midi-sound">
        <span className="chain-part">MIDI</span>
        {sections.midi.map((plugin) => insertButton(store, trackId, plugin))}
        <span className="chain-part">Sound</span>
        {sections.sound.map((plugin) => insertButton(store, trackId, plugin))}
        {sections.caption && <span className="chain-fallback">{sections.caption}</span>}
        {sections.addInstrument && <AddScalerInstrument store={store} trackId={track.id} />}
        {sections.rest.map((plugin) => insertButton(store, trackId, plugin))}
        <PluginPicker store={store} trackId={trackId} roomy={roomy} />
      </div>
    )
  }
  return (
    <div className="inserts">
      {plugins.map((plugin) => insertButton(store, trackId, plugin))}
      <PluginPicker store={store} trackId={trackId} roomy={roomy} />
    </div>
  )
}

function insertButton(store: ProjectStore, trackId: string | 'master', plugin: { id: string; pluginId: string; enabled: boolean; params?: Record<string, number> }) {
  return (
    <button
      key={plugin.id}
      type="button"
      className={plugin.enabled ? 'on' : ''}
      title={descriptor(plugin.pluginId)?.name ?? plugin.pluginId}
      aria-label={`${descriptor(plugin.pluginId)?.name ?? plugin.pluginId}. Open this insert.`}
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
      onClick={(event) => {
        event?.stopPropagation()
        event?.preventDefault()
        store.focusPlugin(trackId, plugin.id)
      }}
      onDoubleClick={() => store.updatePlugin(trackId, plugin.id, { enabled: !plugin.enabled })}
    >
      {insertLabel(plugin.pluginId, plugin)}
    </button>
  )
}

function AddScalerInstrument({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={button}
        type="button"
        className="insert-add"
        aria-expanded={open}
        aria-label="Add instrument"
        title="Add a synth, sampler, or Beat Machine under Scaler."
        onClick={() => setOpen((value) => !value)}
      >
        Add instrument
      </button>
      <AnchoredMenu className="insert-menu" open={open} onClose={() => setOpen(false)} label="Add instrument" triggerRef={button} prefer="down">
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'synth'); setOpen(false) }}>Synth</button>
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'sampler'); setOpen(false) }}>Sampler</button>
        <button type="button" onClick={() => { store.addScalerSound(trackId, 'pads'); setOpen(false) }}>Beat Machine</button>
      </AnchoredMenu>
    </>
  )
}

export function SendList({ store, trackId, engine, roomy = false }: { store: ProjectStore; trackId: string; engine?: AudioEngine; roomy?: boolean }) {
  const track = store.track(trackId)
  if (!track) return null
  const buses = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== trackId)
  return (
    <div className="sends">
      {track.sends.map((send) => (
        <label key={send.id}>
          <span>{buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'}</span>
          <TouchSlider
            label={`${buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'} level`}
            title="Send level. Latch and touch write this while playing."
            min={0}
            max={1}
            step={0.01}
            value={send.gain}
            fallback={0.25}
            onStart={() => store.beginAutomationTouch()}
            onCommit={() => store.endAutomationTouch()}
            onChange={(value) => {
              const rolling = !!engine && (engine.status === 'playing' || engine.status === 'recording')
              store.setAutomated(
                { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 },
                value,
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
          <option value="">{roomy ? 'Add send' : '+'}</option>
          {buses.map((bus) => (
            <option key={bus.id} value={bus.id}>{bus.name}</option>
          ))}
        </select>
      )}
    </div>
  )
}

export function RouteFields({ store, trackId, labeled = false }: { store: ProjectStore; trackId: string; labeled?: boolean }) {
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const groups = targets.filter((item) => item.type === 'group')
  const outputLabel = !track.output
    ? (track.input.startsWith('remote:') ? 'Cue' : 'Master')
    : targets.find((item) => item.id === track.output)?.name ?? 'Master'
  const groupLabel = groups.find((item) => item.id === track.groupId)?.name ?? 'No group'
  const output = (
    <BevelSelect
      label="Output"
      hint={`Output. ${outputLabel}`}
      value={track.output ?? ''}
      options={[
        { value: '', label: track.input.startsWith('remote:') ? 'Cue' : 'Master' },
        ...targets.map((item) => ({ value: item.id, label: item.name })),
      ]}
      onChange={(next) => store.updateTrack(track.id, { output: next || null })}
    />
  )
  const group = (
    <BevelSelect
      label="Group"
      hint={`Group. ${groupLabel}`}
      value={track.groupId ?? ''}
      options={[{ value: '', label: 'No group' }, ...groups.map((item) => ({ value: item.id, label: item.name }))]}
      onChange={(next) => store.updateTrack(track.id, { groupId: next || null })}
    />
  )
  if (!labeled) return <div className="route-fields">{output}{group}</div>
  return (
    <div className="route-fields labeled">
      <label className="route-field"><span>Output</span>{output}</label>
      <label className="route-field"><span>Group</span>{group}</label>
    </div>
  )
}

export { insertLabel } from './insertLabel'

/** Instrument and effect choices. Beat Machine leads the list on a MIDI track. */
export function insertChoices<T extends { id: string; name: string }>(entries: readonly T[], midi: boolean): { id: string; name: string }[] {
  const ordered = orderedInserts(entries)
  if (!midi) return [...ordered]
  return [
    { id: 'steps', name: 'Step Sequencer' },
    { id: 'pads', name: 'Beat Machine' },
    ...ordered.filter((item) => item.id !== 'pads' && item.id !== 'steps'),
  ]
}

/** Same insert list Mix shows for this track. */
export function insertMenuChoices(store: ProjectStore, trackId: string | 'master') {
  const midi = trackId !== 'master' && store.track(trackId)?.type === 'midi'
  return insertChoices(CATALOG.filter((plugin) => trackId !== 'master' || !INSTRUMENT_IDS.has(plugin.id)), midi)
}

/** Same insert action Mix uses. Vocal Clean adds the vocal chain. */
export function addInsert(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value) return
  if (value === 'vocal' && trackId !== 'master') store.addVocalChain(trackId)
  else store.addPlugin(trackId, value)
}

/** Names that fit a narrow strip. The full name stays on the button label. */
export function clipInsertName(name: string, column: number) {
  const inner = Math.max(28, column - 10)
  const chars = Math.max(3, Math.floor(inner / 7.2))
  if (name.length <= chars) return name
  return `${name.slice(0, Math.max(1, chars - 1))}…`
}

/**
 * The live insert worklet drops only the Step Sequencer.
 * Synth, sampler, Scaler, and Beat Machine stay in that serial chain, so they are not labeled as skipped sources.
 */
export function isInstrumentSource(plugin: { pluginId: string; params?: Record<string, number> }) {
  return plugin.pluginId === 'steps'
}

/** These choices retarget through addPlugin when the clicked strip is not a MIDI track. */
const RETARGET_IDS = new Set(['steps', 'scaler', 'synth'])

export function stripCanHost(store: ProjectStore, trackId: string | 'master', pluginId: string) {
  if (!RETARGET_IDS.has(pluginId) && !insertsBeatMachine(pluginId)) return true
  const track = trackId === 'master' ? null : store.track(trackId)
  return track?.type === 'midi'
}

export function stripSlotChoices(store: ProjectStore, trackId: string | 'master') {
  return insertMenuChoices(store, trackId).filter((plugin) => stripCanHost(store, trackId, plugin.id))
}

/** Strip Add. Refuses a choice that would land on a different track. */
export function addStripInsert(store: ProjectStore, trackId: string | 'master', value: string) {
  if (!value || !stripCanHost(store, trackId, value)) return
  addInsert(store, trackId, value)
}

function audioPlace(index: number, count: number) {
  if (index === 0 && count <= 1) return 'Only audio effect. This processes first, then the fader.'
  if (index === 0) return 'First audio effect. This processes first.'
  if (index === count - 1) return 'Last audio effect. It receives the previous audio effect, then the fader.'
  return 'This audio effect receives the previous audio effect and feeds the next one.'
}

function sourcePlace(name: string, savedIndex: number) {
  return `${name}. Instrument source, saved at position ${savedIndex + 1}. The audio chain skips this slot. It does not process in series.`
}

/** Named insert slots. Top is first in the audio chain. One empty slot adds on this track. */
export function StripInserts({ store, trackId, column }: { store: ProjectStore; trackId: string | 'master'; column: number }) {
  const track = trackId === 'master' ? null : store.track(trackId)
  const plugins = trackId === 'master' ? store.project.masterPlugins : track?.plugins ?? []
  const name = trackId === 'master' ? 'Master' : track?.name ?? 'Track'
  return (
    <div className="strip-rack">
      <p className="strip-inserts-label">Inserts</p>
      <div
        className="strip-inserts"
        role="list"
        data-inserts={trackId}
        data-chain="serial"
        aria-label={`Inserts on ${name}. The top insert processes first. Each insert below receives the one above. The bottom insert is last, then the fader feeds the output.`}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {plugins.map((plugin, index) => {
          const full = insertLabel(plugin.pluginId, plugin)
          const source = isInstrumentSource(plugin)
          const audio = plugins.filter((item) => !isInstrumentSource(item))
          const audioIndex = audio.findIndex((item) => item.id === plugin.id)
          const label = source
            ? `${sourcePlace(full, index)} Open this source.`
            : `${full}. Audio effect ${audioIndex + 1} of ${audio.length}. ${audioPlace(audioIndex, audio.length)} Open this effect.`
          return (
            <button
              key={plugin.id}
              type="button"
              role="listitem"
              className={`strip-insert${source ? ' is-source' : ''}${plugin.enabled ? ' on' : ' is-off'}`}
              data-plugin={plugin.id}
              data-plugin-id={plugin.pluginId}
              data-role={source ? 'source' : 'audio'}
              data-chain-index={index}
              data-audio-index={source ? undefined : audioIndex}
              title={label}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                event.preventDefault()
                if (trackId !== 'master') store.selectTrack(trackId)
                store.focusPlugin(trackId, plugin.id)
              }}
            >
              <span>{clipInsertName(full, column)}</span>
            </button>
          )
        })}
        <PluginPicker store={store} trackId={trackId} slot order={plugins.length} />
      </div>
    </div>
  )
}

function PluginPicker({ store, trackId, slot = false, order = 0 }: { store: ProjectStore; trackId: string | 'master'; roomy?: boolean; slot?: boolean; order?: number }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const choices = slot ? stripSlotChoices(store, trackId) : insertMenuChoices(store, trackId)
  const name = trackId === 'master' ? 'Master' : store.track(trackId)?.name ?? 'Track'
  const addLabel = `Add insert on ${name}. It is placed at the bottom and processes last, then the fader.`
  return (
    <>
      <button
        ref={button}
        type="button"
        className={slot ? 'strip-insert strip-insert-add' : 'plugin-pick insert-add'}
        aria-expanded={open}
        aria-label={slot ? addLabel : 'Add plugin'}
        title={slot ? addLabel : 'Add an instrument or effect on this track.'}
        data-chain-index={slot ? order : undefined}
        data-add-track={slot ? trackId : undefined}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        {slot ? 'Add' : open ? 'Close' : 'Add plugin'}
      </button>
      {open && (
        <AnchoredMenu className="insert-menu" open={open} onClose={() => setOpen(false)} label="Add plugin" triggerRef={button} prefer="auto">
          {choices.map((plugin) => (
            <button
              key={plugin.id}
              type="button"
              className="plugin-pick"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                if (trackId !== 'master') store.selectTrack(trackId)
                if (slot) addStripInsert(store, trackId, plugin.id)
                else addInsert(store, trackId, plugin.id)
                setOpen(false)
              }}
            >
              {plugin.name}
            </button>
          ))}
        </AnchoredMenu>
      )}
    </>
  )
}

function tuneSheetHeight() {
  if (typeof window === 'undefined') return 680
  return Math.min(740, Math.max(560, window.innerHeight - 16))
}


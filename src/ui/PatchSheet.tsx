import { useEffect, useState, type PointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { detectRoot } from '../audio/sample/engine'
import {
  LAYER_KINDS,
  MAX_LAYERS,
  MOD_SOURCES,
  addLayer,
  addRoute,
  captureCorner,
  controlHelp,
  destinationsFor,
  editLayer,
  editRoute,
  morphActive,
  removeLayer,
  removeRoute,
  setLayerKind,
  setPerformance,
  setRates,
  type LayerKind,
  type PatchLayer,
} from '../instruments/patch'
import { uid } from '../model/types'
import type { ProjectStore } from '../state/store'

const TABS = [
  ['layers', 'Layers', 'tabLayers'],
  ['grain', 'Grain', 'tabGrain'],
  ['mod', 'Mod', 'tabMod'],
  ['xy', 'XY', 'tabXY'],
] as const

const KEYS = [60, 62, 64, 65, 67, 69, 71, 72]
const NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C']

export function PatchSheet({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const track = store.track(trackId)
  const patch = track?.omniPatch
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('layers')
  const [layerId, setLayerId] = useState('')
  const [routeId, setRouteId] = useState('')
  const [more, setMore] = useState(false)
  const [hint, setHint] = useState(controlHelp('tabLayers'))
  useEffect(() => () => {
    for (const note of KEYS) engine.previewPatch(trackId, note, false)
  }, [engine, trackId])
  if (!track || !patch) return null
  const layer = patch.layers.find((item) => item.id === layerId) ?? patch.layers[0]
  const route = patch.routes.find((item) => item.id === routeId) ?? patch.routes[0]
  const grain = patch.layers.find((item) => item.id === layer?.id && item.kind === 'granular') ?? patch.layers.find((item) => item.kind === 'granular')
  const show = (id: string) => setHint(controlHelp(id))
  const edit = (id: string, partial: Parameters<typeof editLayer>[2], draft = false) => {
    store.updateOmni(trackId, (current) => editLayer(current, id, partial), draft)
  }
  return (
    <section className="patch-sheet" role="dialog" aria-label="Layered patch">
      <header>
        <input
          aria-label="Patch name"
          title={controlHelp('name')}
          value={patch.name}
          onFocus={() => show('name')}
          onChange={(event) => store.updateOmni(trackId, (current) => { current.name = event.target.value.slice(0, 64) }, true)}
          onBlur={() => store.endDraft()}
        />
        <button type="button" className={`text-btn ${patch.enabled ? 'on' : ''}`} title={controlHelp('enabled')} onClick={() => { show('enabled'); store.updateOmni(trackId, (current) => { current.enabled = !current.enabled }) }}>
          {patch.enabled ? 'On' : 'Off'}
        </button>
        <button type="button" className="text-btn" title={controlHelp('name')} onClick={() => store.saveOmniPatch(trackId)}>Save</button>
        <select
          aria-label="Load patch"
          title={controlHelp('name')}
          value=""
          onChange={(event) => event.target.value && store.loadOmniPatch(trackId, event.target.value)}
        >
          <option value="">Load</option>
          {(store.project.omniLibrary ?? []).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" className="text-btn" onClick={() => store.openPatch(trackId)} aria-label="Close patch">Close</button>
      </header>
      <div className="patch-tabs" role="tablist">
        {TABS.map(([id, label, help]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { setTab(id); show(help) }}>{label}</button>
        ))}
      </div>
      <p className="patch-hint">{hint}</p>
      {tab === 'layers' && layer && (
        <div className="patch-body">
          <div className="patch-chips">
            {patch.layers.map((item, index) => (
              <button key={item.id} type="button" className={item.id === layer.id ? 'on' : ''} onClick={() => setLayerId(item.id)}>
                {index + 1} {item.enabled ? '' : '·'}
              </button>
            ))}
            {patch.layers.length < MAX_LAYERS && (
              <button type="button" title={controlHelp('addLayer')} onClick={() => { show('addLayer'); store.updateOmni(trackId, (current) => { const added = addLayer(current, 'wavetable'); if (added) setLayerId(added.id) }) }}>+</button>
            )}
          </div>
          <LayerEditor
            layer={layer}
            buffers={[...store.buffers.values()]}
            more={more}
            show={show}
            onMore={() => setMore((value) => !value)}
            onKind={(kind) => { show('kind'); store.updateOmni(trackId, (current) => setLayerKind(current, layer.id, kind)) }}
            onToggle={() => { show('layerOn'); edit(layer.id, { enabled: !layer.enabled }) }}
            onRemove={() => { store.updateOmni(trackId, (current) => removeLayer(current, layer.id)); setLayerId('') }}
            onChange={(partial, draft) => edit(layer.id, partial, draft)}
            onFile={(file) => void loadAudio(file, store, trackId, layer.id)}
            end={() => store.endDraft()}
          />
        </div>
      )}
      {tab === 'grain' && (
        <div className="patch-body">
          {!grain && patch.layers.length < MAX_LAYERS && (
            <button type="button" className="text-btn" title={controlHelp('addLayer')} onClick={() => { show('addLayer'); store.updateOmni(trackId, (current) => { const added = addLayer(current, 'granular'); if (added) setLayerId(added.id) }) }}>
              Add grains
            </button>
          )}
          {!grain && patch.layers.length >= MAX_LAYERS && <p className="patch-hint">Remove a layer to make room for grains.</p>}
          {grain && (
            <>
              <div className="patch-chips">
                {patch.layers.filter((item) => item.kind === 'granular').map((item, index) => (
                  <button key={item.id} type="button" className={item.id === grain.id ? 'on' : ''} onClick={() => setLayerId(item.id)}>Grain {index + 1}</button>
                ))}
              </div>
              <BufferRow
                layer={grain}
                buffers={[...store.buffers.values()]}
                show={show}
                onChange={(partial, draft) => edit(grain.id, partial, draft)}
                onFile={(file) => void loadAudio(file, store, trackId, grain.id)}
                end={() => store.endDraft()}
              />
              <div className="patch-knobs">
                <Knob label="Position" help="position" min={0} max={1} step={0.001} value={grain.granular.position} show={show} end={() => store.endDraft()} onChange={(value, draft) => edit(grain.id, { granular: { ...grain.granular, position: value } }, draft)} />
                <Knob label="Size" help="size" min={10} max={400} step={1} value={grain.granular.size} show={show} end={() => store.endDraft()} onChange={(value, draft) => edit(grain.id, { granular: { ...grain.granular, size: value } }, draft)} />
                <Knob label="Density" help="density" min={1} max={40} step={0.1} value={grain.granular.density} show={show} end={() => store.endDraft()} onChange={(value, draft) => edit(grain.id, { granular: { ...grain.granular, density: value } }, draft)} />
                <Knob label="Spray" help="spray" min={0} max={1} step={0.001} value={grain.granular.spray} show={show} end={() => store.endDraft()} onChange={(value, draft) => edit(grain.id, { granular: { ...grain.granular, spray: value } }, draft)} />
                <Knob label="Pitch" help="pitch" min={-24} max={24} step={0.1} value={grain.granular.pitch} show={show} end={() => store.endDraft()} onChange={(value, draft) => edit(grain.id, { granular: { ...grain.granular, pitch: value } }, draft)} />
              </div>
              <button type="button" className={`text-btn ${grain.granular.freeze ? 'on' : ''}`} title={controlHelp('freeze')} onClick={() => { show('freeze'); edit(grain.id, { granular: { ...grain.granular, freeze: !grain.granular.freeze } }) }}>
                {grain.granular.freeze ? 'Frozen' : 'Moving'}
              </button>
            </>
          )}
        </div>
      )}
      {tab === 'mod' && (
        <div className="patch-body">
          <div className="patch-chips">
            {patch.routes.map((item, index) => (
              <button key={item.id} type="button" className={item.id === route?.id ? 'on' : ''} onClick={() => setRouteId(item.id)}>{index + 1}</button>
            ))}
            <button type="button" title={controlHelp('addRoute')} onClick={() => { show('addRoute'); store.updateOmni(trackId, (current) => { const added = addRoute(current); if (added) setRouteId(added.id) }) }}>+</button>
          </div>
          <div className="patch-knobs">
            <Knob label="Macro 1" help="macro1" min={0} max={1} step={0.01} value={patch.macro1 ?? 0} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setPerformance(current, { macro1: value }), draft)} />
            <Knob label="Macro 2" help="macro2" min={0} max={1} step={0.01} value={patch.macro2 ?? 0} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setPerformance(current, { macro2: value }), draft)} />
          </div>
          {route && (
            <div className="patch-route">
              <label title={controlHelp('source')}>
                Source
                <select aria-label="Mod source" value={route.source} onFocus={() => show('source')} onChange={(event) => store.updateOmni(trackId, (current) => editRoute(current, route.id, { source: event.target.value as typeof route.source }))}>
                  {MOD_SOURCES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label title={controlHelp('target')}>
                Target
                <select aria-label="Mod target" value={route.target} onFocus={() => show('target')} onChange={(event) => store.updateOmni(trackId, (current) => editRoute(current, route.id, { target: event.target.value }))}>
                  {destinationsFor(patch).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <Knob label="Depth" help="depth" min={-1} max={1} step={0.01} value={route.depth} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => editRoute(current, route.id, { depth: value }), draft)} />
              <button type="button" className="text-btn" onClick={() => { store.updateOmni(trackId, (current) => removeRoute(current, route.id)); setRouteId('') }}>Remove</button>
            </div>
          )}
          <details className="patch-more">
            <summary onClick={() => show('lfo1')}>Motion</summary>
            <div className="patch-knobs">
              <Knob label="LFO 1" help="lfo1" min={0.05} max={12} step={0.01} value={patch.lfo1Rate} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setRates(current, { lfo1Rate: value }), draft)} />
              <Knob label="LFO 2" help="lfo2" min={0.05} max={12} step={0.01} value={patch.lfo2Rate} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setRates(current, { lfo2Rate: value }), draft)} />
              <Knob label="Attack" help="envAttack" min={1} max={2000} step={1} value={patch.env1Attack} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setRates(current, { env1Attack: value }), draft)} />
              <Knob label="Release" help="envRelease" min={5} max={4000} step={1} value={patch.env1Release} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setRates(current, { env1Release: value }), draft)} />
            </div>
          </details>
        </div>
      )}
      {tab === 'xy' && (
        <div className="patch-body">
          <div
            className="xy-pad"
            role="slider"
            aria-label="Morph pad"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(patch.morph.x * 100)}
            title={controlHelp('morph')}
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); show('morph'); movePad(event, store, trackId) }}
            onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) movePad(event, store, trackId) }}
            onPointerUp={() => store.endDraft()}
          >
            <span className="xy-dot" style={{ left: `${patch.morph.x * 100}%`, top: `${patch.morph.y * 100}%` }} />
            {patch.morph.corners.map((corner) => <em key={corner.id} className={`xy-name ${corner.name}`}>{corner.name}</em>)}
          </div>
          {morphActive(patch) && <p className="patch-hint">The pad is blending saved corners. Knobs edit the nearest one.</p>}
          <div className="patch-corners">
            {patch.morph.corners.map((corner, index) => (
              <button key={corner.id} type="button" className={corner.captured ? 'on' : ''} title={controlHelp('corner')} onClick={() => { show('corner'); store.updateOmni(trackId, (current) => captureCorner(current, index)) }}>
                Keep {corner.name}
              </button>
            ))}
          </div>
          <div className="patch-knobs">
            <Knob label="Wheel" help="modwheel" min={0} max={1} step={0.01} value={patch.modWheel} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setPerformance(current, { modWheel: value }), draft)} />
            <Knob label="Pressure" help="aftertouch" min={0} max={1} step={0.01} value={patch.aftertouch} show={show} end={() => store.endDraft()} onChange={(value, draft) => store.updateOmni(trackId, (current) => setPerformance(current, { aftertouch: value }), draft)} />
          </div>
        </div>
      )}
      <div className="patch-keys">
        {KEYS.map((note, index) => (
          <button
            key={NAMES[index] + index}
            type="button"
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); engine.previewPatch(trackId, note, true) }}
            onPointerUp={() => engine.previewPatch(trackId, note, false)}
            onPointerCancel={() => engine.previewPatch(trackId, note, false)}
          >
            {NAMES[index]}
          </button>
        ))}
      </div>
    </section>
  )
}

function LayerEditor({
  layer, buffers, more, show, onMore, onKind, onToggle, onRemove, onChange, onFile, end,
}: {
  layer: PatchLayer
  buffers: { id: string; name: string }[]
  more: boolean
  show: (id: string) => void
  onMore: () => void
  onKind: (kind: LayerKind) => void
  onToggle: () => void
  onRemove: () => void
  onChange: (partial: Parameters<typeof editLayer>[2], draft?: boolean) => void
  onFile: (file: File) => void
  end: () => void
}) {
  return (
    <>
      <div className="patch-row">
        <select aria-label="Layer source" title={controlHelp('kind')} value={layer.kind} onFocus={() => show('kind')} onChange={(event) => onKind(event.target.value as LayerKind)}>
          {LAYER_KINDS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" className={`text-btn ${layer.enabled ? 'on' : ''}`} title={controlHelp('layerOn')} onClick={onToggle}>{layer.enabled ? 'Live' : 'Muted'}</button>
        <button type="button" className="text-btn" onClick={onMore}>{more ? 'Less' : 'More'}</button>
        <button type="button" className="text-btn" onClick={onRemove}>Remove</button>
      </div>
      {(layer.kind === 'sampler' || layer.kind === 'granular' || layer.kind === 'wavetable') && (
        <BufferRow layer={layer} buffers={buffers} show={show} onChange={onChange} onFile={onFile} end={end} />
      )}
      <div className="patch-knobs">
        <Knob label="Level" help="level" min={0} max={1} step={0.01} value={layer.level} show={show} end={end} onChange={(value, draft) => onChange({ level: value }, draft)} />
        <Knob label="Pan" help="pan" min={-1} max={1} step={0.01} value={layer.pan} show={show} end={end} onChange={(value, draft) => onChange({ pan: value }, draft)} />
        <Knob label="Cutoff" help="cutoff" min={40} max={16000} step={1} value={layer.cutoff} show={show} end={end} onChange={(value, draft) => onChange({ cutoff: value }, draft)} />
        <Knob label="Send" help="fxSend" min={0} max={1} step={0.01} value={layer.fxSend} show={show} end={end} onChange={(value, draft) => onChange({ fxSend: value }, draft)} />
        {more && (
          <>
            <Knob label="Resonance" help="resonance" min={0} max={0.9} step={0.01} value={layer.resonance} show={show} end={end} onChange={(value, draft) => onChange({ resonance: value }, draft)} />
            <Knob label="Low key" help="keyLo" min={0} max={127} step={1} value={layer.keyLo} show={show} end={end} onChange={(value, draft) => onChange({ keyLo: value }, draft)} />
            <Knob label="High key" help="keyHi" min={0} max={127} step={1} value={layer.keyHi} show={show} end={end} onChange={(value, draft) => onChange({ keyHi: value }, draft)} />
            <Knob label="Soft" help="velLo" min={0} max={1} step={0.01} value={layer.velLo} show={show} end={end} onChange={(value, draft) => onChange({ velLo: value }, draft)} />
            <Knob label="Hard" help="velHi" min={0} max={1} step={0.01} value={layer.velHi} show={show} end={end} onChange={(value, draft) => onChange({ velHi: value }, draft)} />
            <label className="patch-knob" title={controlHelp('filterMode')}>
              Filter
              <select aria-label="Filter mode" value={layer.filterMode} onFocus={() => show('filterMode')} onChange={(event) => onChange({ filterMode: Number(event.target.value) })}>
                <option value={0}>Lowpass</option>
                <option value={1}>Highpass</option>
                <option value={2}>Bandpass</option>
              </select>
            </label>
          </>
        )}
      </div>
    </>
  )
}

function BufferRow({
  layer, buffers, show, onChange, onFile, end,
}: {
  layer: PatchLayer
  buffers: { id: string; name: string }[]
  show: (id: string) => void
  onChange: (partial: Parameters<typeof editLayer>[2], draft?: boolean) => void
  onFile: (file: File) => void
  end: () => void
}) {
  return (
    <div className="patch-row">
      <select aria-label="Audio" title={controlHelp('buffer')} value={layer.bufferId} onFocus={() => show('buffer')} onChange={(event) => onChange({ bufferId: event.target.value })}>
        <option value="">No audio</option>
        {buffers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <label className="text-btn" title={controlHelp('buffer')}>
        Load
        <input className="file" type="file" accept="audio/*" onChange={(event) => event.target.files?.[0] && onFile(event.target.files[0])} />
      </label>
      <Knob label="Root" help="root" min={0} max={127} step={1} value={layer.root} show={show} end={end} onChange={(value, draft) => onChange({ root: value }, draft)} />
    </div>
  )
}

function Knob({
  label, help, min, max, step, value, show, onChange, end,
}: {
  label: string
  help: string
  min: number
  max: number
  step: number
  value: number
  show: (id: string) => void
  onChange: (value: number, draft: boolean) => void
  end: () => void
}) {
  const text = controlHelp(help)
  return (
    <label className="patch-knob" title={text}>
      {label}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        aria-label={label}
        onFocus={() => show(help)}
        onPointerDown={() => show(help)}
        onChange={(event) => onChange(Number(event.target.value), true)}
        onPointerUp={end}
        onBlur={end}
      />
    </label>
  )
}

function movePad(event: PointerEvent<HTMLDivElement>, store: ProjectStore, trackId: string) {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)))
  store.updateOmni(trackId, (current) => setPerformance(current, { x, y }), true)
}

async function loadAudio(file: File, store: ProjectStore, trackId: string, layerId: string) {
  const ctx = new AudioContext()
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
    const id = uid('smp')
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
    store.addAsset({ id, name: file.name, sampleRate: decoded.sampleRate, channels })
    const root = channels[0] ? detectRoot(channels[0], decoded.sampleRate) : 60
    store.updateOmni(trackId, (current) => editLayer(current, layerId, { bufferId: id, root }))
  } finally {
    await ctx.close()
  }
}

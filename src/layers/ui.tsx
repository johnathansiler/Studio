import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'
import { soundingFlat } from './matrix'
import { STARTERS } from './presets'
import {
  GLOBAL_PARAMS,
  LAYER_PARAMS,
  MOD_SOURCES,
  sourceParamList,
  type LayerParam,
  type LayerPatch,
} from './types'

const KEYS = [
  [60, 'C'],
  [62, 'D'],
  [64, 'E'],
  [65, 'F'],
  [67, 'G'],
  [69, 'A'],
  [71, 'B'],
  [72, 'C'],
] as const

const SOURCES = [
  { id: 'analog', label: 'Analog' },
  { id: 'wavetable', label: 'Wavetable' },
  { id: 'fm', label: 'FM' },
  { id: 'sample', label: 'Sample' },
  { id: 'granular', label: 'Granular' },
]

const AMP = ['level', 'pan', 'tune', 'fine', 'attack', 'decay', 'sustain', 'release']
const FILTER = ['cutoff', 'res', 'filterMode', 'fAmt', 'fAttack', 'fDecay', 'fSustain', 'fRelease']
const FX = ['drive', 'chorus', 'delay', 'delayTime', 'feedback']
const MOD_ENV = ['mAttack', 'mDecay', 'mSustain', 'mRelease']
const CORNERS = [
  { label: 'A', x: 0, y: 0 },
  { label: 'B', x: 1, y: 0 },
  { label: 'C', x: 0, y: 1 },
  { label: 'D', x: 1, y: 1 },
]

function sourceChoice(kind: string, engine?: string) {
  if (kind === 'synth') return engine || 'analog'
  return kind
}

function stepFor(item: LayerParam) {
  const span = item.max - item.min
  if (span <= 2) return 0.01
  if (span <= 40) return 0.1
  return 1
}

function show(value: number, unit: string) {
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2
  const text = value.toFixed(digits)
  return unit ? `${text} ${unit}` : text
}

function Knob({
  item,
  value,
  onChange,
  onDone,
}: {
  item: LayerParam
  value: number
  onChange: (value: number) => void
  onDone: () => void
}) {
  return (
    <label className="layer-knob">
      <span>{item.name}<em>{show(value, item.unit)}</em></span>
      <input
        aria-label={item.name}
        type="range"
        min={item.min}
        max={item.max}
        step={stepFor(item)}
        value={Number.isFinite(value) ? value : item.default}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onDone}
        onBlur={onDone}
        onKeyUp={onDone}
      />
    </label>
  )
}

function paramById(id: string) {
  return LAYER_PARAMS.find((item) => item.id === id) ?? GLOBAL_PARAMS.find((item) => item.id === id)
}

export function LayerSheet({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const [tab, setTab] = useState<'layers' | 'mod' | 'pad'>('layers')
  const [layerIndex, setLayerIndex] = useState(0)
  const trackId = store.layerTrackId
  const track = trackId ? store.track(trackId) : undefined
  const patch = track?.layerPatch
  if (!track || !patch) return null
  const sounding = soundingFlat(patch)
  const layer = patch.layers[Math.min(layerIndex, patch.layers.length - 1)]
  const buffers = [...store.buffers.values()]
  const setSound = (key: string, value: number) => store.setLayerSounding(track.id, key, value, true)
  const done = () => store.endDraft()
  const play = (pitch: number, hold: boolean) => engine.previewLayer(track.id, pitch, hold)
  return (
    <div className="layer-sheet" role="dialog" aria-label="Layer patch">
      <header>
        <strong>{track.name}</strong>
        <input aria-label="Patch name" value={patch.name} onChange={(event) => store.setLayerName(track.id, event.target.value)} />
        <select aria-label="Starter patch" value="" onChange={(event) => event.target.value && store.loadLayerStarter(track.id, event.target.value)}>
          <option value="">Starter</option>
          {STARTERS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" onClick={() => store.closeLayers()}>Close</button>
      </header>
      <div className="layer-tabs" role="tablist">
        {(['layers', 'mod', 'pad'] as const).map((id) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            {id === 'layers' ? 'Layers' : id === 'mod' ? 'Mod' : 'XY'}
          </button>
        ))}
      </div>
      <div className="layer-body">
        {tab === 'layers' && layer && (
          <>
            <div className="layer-chips">
              {patch.layers.map((item, index) => (
                <button key={item.id} type="button" className={item.id === layer.id ? 'on' : ''} onClick={() => setLayerIndex(index)}>
                  {item.name}
                </button>
              ))}
              <button type="button" onClick={() => store.addPatchLayer(track.id)} disabled={patch.layers.length >= 4}>Add</button>
            </div>
            <div className="layer-row">
              <input aria-label="Layer name" value={layer.name} onChange={(event) => store.setPatchLayerName(track.id, layer.id, event.target.value)} />
              <button type="button" className={layer.enabled ? 'on' : ''} onClick={() => store.setPatchLayerEnabled(track.id, layer.id, !layer.enabled)}>
                {layer.enabled ? 'On' : 'Off'}
              </button>
              <button type="button" onClick={() => store.removePatchLayer(track.id, layer.id)} disabled={patch.layers.length < 2}>Remove</button>
            </div>
            <label className="layer-knob">
              <span>Source</span>
              <select
                aria-label="Layer source"
                value={sourceChoice(layer.source.kind, layer.source.engine)}
                onChange={(event) => store.setPatchLayerSource(track.id, layer.id, event.target.value)}
              >
                {SOURCES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            {(layer.source.kind === 'sample' || layer.source.kind === 'granular') && (
              <label className="layer-knob">
                <span>Wave</span>
                <select
                  aria-label="Sample source"
                  value={layer.source.bufferId || ''}
                  onChange={(event) => store.setPatchLayerBuffer(track.id, layer.id, event.target.value)}
                >
                  <option value="">Built-in wave (CC0)</option>
                  {buffers.map((buffer) => <option key={buffer.id} value={buffer.id}>{buffer.name}</option>)}
                </select>
              </label>
            )}
            <div className="layer-knobs">
              {sourceParamList(layer.source).map((item) => (
                <Knob key={item.id} item={item} value={sounding[`${layer.id}:s:${item.id}`] ?? item.default} onChange={(value) => setSound(`${layer.id}:s:${item.id}`, value)} onDone={done} />
              ))}
              {AMP.map((id) => paramById(id)).filter((item): item is LayerParam => !!item).map((item) => (
                <Knob key={item.id} item={item} value={sounding[`${layer.id}:${item.id}`] ?? item.default} onChange={(value) => setSound(`${layer.id}:${item.id}`, value)} onDone={done} />
              ))}
            </div>
            <details>
              <summary>Filter</summary>
              <div className="layer-knobs">
                {FILTER.map((id) => paramById(id)).filter((item): item is LayerParam => !!item).map((item) => (
                  <Knob key={item.id} item={item} value={sounding[`${layer.id}:${item.id}`] ?? item.default} onChange={(value) => setSound(`${layer.id}:${item.id}`, value)} onDone={done} />
                ))}
              </div>
            </details>
            <details>
              <summary>FX</summary>
              <div className="layer-knobs">
                {FX.map((id) => paramById(id)).filter((item): item is LayerParam => !!item).map((item) => (
                  <Knob key={item.id} item={item} value={sounding[`${layer.id}:${item.id}`] ?? item.default} onChange={(value) => setSound(`${layer.id}:${item.id}`, value)} onDone={done} />
                ))}
              </div>
            </details>
          </>
        )}
        {tab === 'mod' && (
          <>
            <p className="layer-note">LFOs run free. Envelopes, velocity, the mod wheel, and aftertouch follow each note.</p>
            <div className="layer-knobs">
              {GLOBAL_PARAMS.filter((item) => item.id !== 'master').map((item) => (
                <Knob key={item.id} item={item} value={sounding[`g:${item.id}`] ?? item.default} onChange={(value) => setSound(`g:${item.id}`, value)} onDone={done} />
              ))}
              {layer && MOD_ENV.map((id) => paramById(id)).filter((item): item is LayerParam => !!item).map((item) => (
                <Knob key={item.id} item={{ ...item, name: `${layer.name} ${item.name}` }} value={sounding[`${layer.id}:${item.id}`] ?? item.default} onChange={(value) => setSound(`${layer.id}:${item.id}`, value)} onDone={done} />
              ))}
            </div>
            <div className="layer-routes">
              {patch.routes.map((route) => (
                <div className="layer-route" key={route.id}>
                  <select aria-label="Mod source" value={route.source} onChange={(event) => store.setLayerRoute(track.id, route.id, { source: event.target.value })}>
                    {MOD_SOURCES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                  <select aria-label="Mod destination" value={route.destination} onChange={(event) => store.setLayerRoute(track.id, route.id, { destination: event.target.value })}>
                    <DestinationOptions patch={patch} />
                  </select>
                  <input
                    aria-label="Mod amount"
                    type="range"
                    min={-1}
                    max={1}
                    step={0.01}
                    value={route.amount}
                    onChange={(event) => store.setLayerRoute(track.id, route.id, { amount: Number(event.target.value) }, true)}
                    onPointerUp={done}
                    onBlur={done}
                  />
                  <button type="button" onClick={() => store.removeLayerRoute(track.id, route.id)}>Remove</button>
                </div>
              ))}
              <button type="button" onClick={() => store.addLayerRoute(track.id)} disabled={patch.routes.length >= 12}>Add route</button>
            </div>
          </>
        )}
        {tab === 'pad' && (
          <>
            <p className="layer-note">Drag the pad to blend corners A, B, C, and D. Jump to a corner, then move a knob, to edit that state.</p>
            <div
              className="layer-pad"
              role="slider"
              aria-label="Morph pad"
              aria-valuemin={0}
              aria-valuemax={1}
              aria-valuenow={patch.xy.x}
              onPointerDown={(event) => {
                event.currentTarget.setPointerCapture(event.pointerId)
                point(event, (x, y) => store.setLayerXY(track.id, x, y, true))
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                point(event, (x, y) => store.setLayerXY(track.id, x, y, true))
              }}
              onPointerUp={done}
              onPointerCancel={done}
            >
              <i className="layer-dot" style={{ left: `${patch.xy.x * 100}%`, top: `${(1 - patch.xy.y) * 100}%` }} />
              <span className="corner a">A</span>
              <span className="corner b">B</span>
              <span className="corner c">C</span>
              <span className="corner d">D</span>
            </div>
            <div className="layer-row">
              {CORNERS.map((corner) => (
                <button key={corner.label} type="button" onClick={() => store.setLayerXY(track.id, corner.x, corner.y, false)}>{corner.label}</button>
              ))}
            </div>
            <div className="layer-row">
              {CORNERS.map((corner, index) => (
                <button key={corner.label} type="button" onClick={() => store.captureLayerCorner(track.id, index)}>Store {corner.label}</button>
              ))}
            </div>
            <div className="layer-knobs">
              <Knob item={{ id: 'modWheel', name: 'Mod wheel', min: 0, max: 1, default: 0, unit: '' }} value={patch.modWheel} onChange={(value) => store.setLayerModWheel(track.id, value, true)} onDone={done} />
              <Knob item={{ id: 'aftertouch', name: 'Aftertouch', min: 0, max: 1, default: 0, unit: '' }} value={patch.aftertouch} onChange={(value) => store.setLayerAftertouch(track.id, value, true)} onDone={done} />
              <Knob item={GLOBAL_PARAMS[0]} value={sounding['g:master'] ?? 0.75} onChange={(value) => setSound('g:master', value)} onDone={done} />
            </div>
          </>
        )}
      </div>
      <div className="layer-keys">
        {KEYS.map(([pitch, label]) => (
          <button
            key={pitch}
            type="button"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId)
              play(pitch, true)
            }}
            onPointerUp={() => engine.releaseLayer(track.id, pitch)}
            onPointerCancel={() => engine.releaseLayer(track.id, pitch)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function DestinationOptions({ patch }: { patch: LayerPatch }) {
  return (
    <>
      <optgroup label="Patch">
        {GLOBAL_PARAMS.map((item) => <option key={item.id} value={`g:${item.id}`}>{item.name}</option>)}
      </optgroup>
      {patch.layers.map((layer) => (
        <optgroup key={layer.id} label={layer.name}>
          {LAYER_PARAMS.map((item) => <option key={item.id} value={`${layer.id}:${item.id}`}>{item.name}</option>)}
          {sourceParamList(layer.source).map((item) => <option key={item.id} value={`${layer.id}:s:${item.id}`}>{item.name}</option>)}
        </optgroup>
      ))}
    </>
  )
}

function point(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }, set: (x: number, y: number) => void) {
  const rect = event.currentTarget.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  const y = Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / Math.max(1, rect.height)))
  set(x, y)
}

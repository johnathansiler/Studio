import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { activePresetName, descriptor, FACTORY } from '../audio/plugins/catalog'
import { PresetBar } from './PresetBar'
import { GestureReadout, useDragValue } from './kit/controls'
import {
  AMPS,
  CABS,
  MICS,
  PEDALS,
  SLOT_COUNT,
  TUNE_PRESETS,
  addPedal,
  chainHasLoop,
  noteName,
  removePedal,
  reorderSlots,
  targetNote,
  tunePitch,
} from '../audio/plugins/ampDsp'
import type { PluginInstance } from '../model/types'
import type { ParamSpec } from '../audio/plugins/types'
import { selectChain } from '../state/select'
import type { ProjectStore } from '../state/store'

const AMP_KNOBS = ['gain', 'bass', 'mid', 'treble', 'presence', 'master'] as const

export function AmpPop({
  store,
  engine,
  trackId,
  plugin,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string | 'master'
  plugin: PluginInstance
}) {
  const chain = selectChain(store, trackId)
  const spec = descriptor('amp')
  const [selected, setSelected] = useState(0)
  const [info, setInfo] = useState(() => engine.monitorInfo(trackId === 'master' ? undefined : trackId))
  const drag = useRef<number | null>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setInfo(engine.monitorInfo(trackId === 'master' ? undefined : trackId)), 200)
    return () => window.clearInterval(timer)
  }, [engine, trackId])
  if (!spec) return null
  const set = (id: string, value: number) => store.updatePlugin(trackId, plugin.id, { params: { [id]: value } })
  const params = plugin.params
  const tuner = engine.tuner(plugin.id)
  const preset = Math.round(params.preset ?? 1)
  const heard = tuner && tuner.hz > 1 ? tuner : null
  const target = heard ? targetNote(heard.note + heard.cents / 100, preset) : (TUNE_PRESETS[preset]?.strings[0] ?? 40)
  const cents = heard ? (heard.note + heard.cents / 100 - target) * 100 : 0
  return (
    <div className="board-pop" data-board="open" role="dialog" aria-label="Amp">
      <header>
        <strong>Amp</strong>
        <PresetBar
          label="Rig"
          names={presetList(store)}
          active={activePresetName('amp', params, store.project.presets)}
          onPick={(name) => store.applyPluginPreset(trackId, plugin.id, name)}
        />
        <button type="button" className={info.direct ? 'on' : ''} hidden={!info.directAvailable} onClick={() => engine.setDirectMonitor(!info.direct)}>Direct</button>
        <button type="button" className={(params.mute ?? 0) >= 0.5 ? 'on' : ''} onClick={() => set('mute', (params.mute ?? 0) >= 0.5 ? 0 : 1)}>Mute</button>
        <button type="button" className="text-btn" onClick={() => store.focusPlugin(null)} aria-label="Close amp">×</button>
      </header>
      <div className="board-stage">
        <section className="board-amp faceplate" aria-label="Amp faceplate">
          <TunerFace name={heard ? noteName(target) : '—'} cents={heard ? cents : 0} live={!!heard} />
          <div className="board-row">
            <select aria-label="Amp model" value={Math.round(params.model ?? 0)} onChange={(event) => set('model', Number(event.target.value))}>
              {AMPS.map((name, index) => (
                <option key={name} value={index}>{name}</option>
              ))}
            </select>
            <button type="button" className={(params.bright ?? 0) >= 0.5 ? 'on' : ''} aria-pressed={(params.bright ?? 0) >= 0.5} onClick={() => set('bright', (params.bright ?? 0) >= 0.5 ? 0 : 1)}>Bright</button>
            <select aria-label="Tuning" value={preset} onChange={(event) => set('preset', Number(event.target.value))}>
              {TUNE_PRESETS.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}
            </select>
            <label>A4 {Math.round(params.cal ?? 440)}
              <input aria-label="A4" type="range" min={430} max={450} step={1} value={params.cal ?? 440} onChange={(event) => set('cal', Number(event.target.value))} />
            </label>
          </div>
          <div className="face-knobs">
            {AMP_KNOBS.map((id) => {
              const knob = spec.params.find((item) => item.id === id)
              if (!knob) return null
              return (
                <Knob
                  key={id}
                  spec={knob}
                  pluginId="amp"
                  value={params[id] ?? knob.default}
                  onChange={(value) => set(id, value)}
                />
              )
            })}
          </div>
        </section>
        <section className="board-side">
          <div className="cab-grid">
            <select aria-label="Cabinet A" value={Math.round(params.cabA ?? 0)} onChange={(event) => set('cabA', Number(event.target.value))}>
              {CABS.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
            <select aria-label="Cabinet B" value={Math.round(params.cabB ?? 2)} onChange={(event) => set('cabB', Number(event.target.value))}>
              {CABS.map((name, index) => <option key={`b-${name}`} value={index}>{name}</option>)}
            </select>
            <select aria-label="Mic" value={Math.round(params.mic ?? 0)} onChange={(event) => set('mic', Number(event.target.value))}>
              {MICS.map((name, index) => <option key={name} value={index}>{name}</option>)}
            </select>
            <button type="button" className={(params.axis ?? 0) >= 0.5 ? 'on' : ''} onClick={() => set('axis', (params.axis ?? 0) >= 0.5 ? 0 : 1)}>
              {(params.axis ?? 0) >= 0.5 ? 'Off axis' : 'On axis'}
            </button>
            <label>Blend
              <input aria-label="Cab blend" type="range" min={0} max={1} step={0.01} value={params.blend ?? 0} onChange={(event) => set('blend', Number(event.target.value))} />
            </label>
            <label>Distance
              <input aria-label="Mic distance" type="range" min={0} max={1} step={0.01} value={params.distance ?? 0.2} onChange={(event) => set('distance', Number(event.target.value))} />
            </label>
          </div>
          <div className="pedal-row" aria-label="Pedalboard">
            {Array.from({ length: SLOT_COUNT }, (_, index) => {
              const id = Math.round(params[`s${index}`] ?? 0)
              if (!id) return null
              return (
                <button
                  key={index}
                  type="button"
                  data-slot={index}
                  className={`pedal ${selected === index ? 'on' : ''} ${(params[`z${index}`] ?? 0) >= 0.5 ? 'post' : ''}`}
                  onPointerDown={(event) => {
                    drag.current = index
                    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* synthetic */ }
                  }}
                  onPointerUp={(event) => {
                    const from = drag.current
                    drag.current = null
                    const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-slot]')
                    const to = Number(hit?.getAttribute('data-slot'))
                    if (from == null || !Number.isFinite(to) || to === from) {
                      setSelected(index)
                      return
                    }
                    store.updatePlugin(trackId, plugin.id, { params: reorderSlots(params, from, to) })
                    setSelected(to)
                  }}
                >
                  {PEDALS[id] ?? 'Pedal'}
                </button>
              )
            })}
            <select aria-label="Add pedal" className="pedal-add" value="" onChange={(event) => {
              const id = Number(event.target.value)
              if (!id) return
              store.updatePlugin(trackId, plugin.id, { params: addPedal(params, id) })
              event.target.value = ''
            }}>
              <option value="">Add</option>
              {PEDALS.slice(1).map((name, index) => (
                <option key={name} value={index + 1}>{name}</option>
              ))}
            </select>
          </div>
          <PedalDetail
            params={params}
            index={selected}
            trackPlugins={chain}
            onChange={set}
            onRemove={() => {
              store.updatePlugin(trackId, plugin.id, { params: removePedal(params, selected) })
            }}
            onLoop={(mode) => set('loop', mode)}
            onOpenLoop={() => {
              const loop = chain.find((item) => item.pluginId === 'loop')
              if (loop) store.focusPlugin(trackId, loop.id)
            }}
          />
          <p className="monitor-read" data-monitor>
            {info.direct ? 'Direct' : `Monitor ${Math.round(info.ms)} ms`} · {info.eco ? 'Eco' : 'Full'}
          </p>
          <p className="face-hint">Drag a pedal to reorder. Post sits after the amp.</p>
        </section>
      </div>
    </div>
  )
}

function presetList(store: ProjectStore) {
  const names = new Set<string>()
  for (const item of FACTORY.amp ?? []) names.add(item.name)
  for (const item of store.project.presets) if (item.pluginId === 'amp') names.add(item.name)
  return [...names]
}

export function TunerPop({
  engine,
  onClose,
}: {
  engine: AudioEngine
  onClose: () => void
}) {
  const [preset, setPreset] = useState(1)
  const [a4, setA4] = useState(440)
  const [muted, setMuted] = useState(false)
  const [read, setRead] = useState<{ name: string; cents: number; live: boolean }>({ name: '—', cents: 0, live: false })
  const [info, setInfo] = useState(() => engine.monitorInfo())
  useEffect(() => {
    const timer = window.setInterval(() => {
      const frame = engine.inputFrame()
      const pitch = frame ? tunePitch(frame, engine.sampleRate, a4) : null
      if (pitch) {
        const target = targetNote(pitch.midi, preset)
        setRead({ name: noteName(target), cents: (pitch.midi - target) * 100, live: true })
      } else {
        setRead({ name: '—', cents: 0, live: false })
      }
      setInfo(engine.monitorInfo())
    }, 80)
    return () => window.clearInterval(timer)
  }, [engine, a4, preset])
  return (
    <div className="board-pop tune-pop" data-tuner="open" role="dialog" aria-label="Tuner">
      <header>
        <strong>Tuner</strong>
        <button type="button" className={info.direct ? 'on' : ''} hidden={!info.directAvailable} onClick={() => engine.setDirectMonitor(!info.direct)}>Direct</button>
        <button type="button" className={muted ? 'on' : ''} aria-pressed={muted} onClick={() => {
          const next = !muted
          setMuted(next)
          engine.setTuneMute(next)
        }}>Mute</button>
        <button type="button" className="text-btn" onClick={() => { engine.setTuneMute(false); onClose() }} aria-label="Close tuner">×</button>
      </header>
      <div className="tune-hero">
        <TunerFace name={read.name} cents={read.live ? read.cents : 0} live={read.live} />
        <div className="board-row">
          <select aria-label="Tuning" value={preset} onChange={(event) => setPreset(Number(event.target.value))}>
            {TUNE_PRESETS.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}
          </select>
          <label>A4 {Math.round(a4)}
            <input aria-label="A4" type="range" min={430} max={450} step={1} value={a4} onChange={(event) => setA4(Number(event.target.value))} />
          </label>
        </div>
        <p className="monitor-read" data-monitor>
          {info.direct ? 'Direct' : `Monitor ${Math.round(info.ms)} ms`} · {info.eco ? 'Eco' : 'Full'}
        </p>
      </div>
    </div>
  )
}

function TunerFace({ name, cents, live }: { name: string; cents: number; live: boolean }) {
  const clamped = Math.max(-50, Math.min(50, cents))
  const angle = (clamped / 50) * 40
  const speed = Math.abs(cents) < 1.2 ? 0 : Math.max(0.12, 8 / Math.abs(cents))
  return (
    <div className="tune-hero-face" aria-label={live ? `${name} ${cents.toFixed(0)} cents` : 'No note'}>
      <div className="needle tune-needle">
        <div className="needle-face">
          <i style={{ transform: `rotate(${angle}deg)` }} />
        </div>
      </div>
      <div
        className="strobe"
        style={{
          animationDuration: `${speed || 1}s`,
          animationDirection: cents < 0 ? 'reverse' : 'normal',
          animationPlayState: speed ? 'running' : 'paused',
        }}
      />
      <strong>{name}</strong>
      <em>{live ? `${cents > 0 ? '+' : ''}${cents.toFixed(0)} c` : '—'}</em>
    </div>
  )
}

function PedalDetail({
  params,
  index,
  trackPlugins,
  onChange,
  onRemove,
  onLoop,
  onOpenLoop,
}: {
  params: Record<string, number>
  index: number
  trackPlugins: { pluginId: string }[]
  onChange: (id: string, value: number) => void
  onRemove: () => void
  onLoop: (mode: number) => void
  onOpenLoop: () => void
}) {
  const id = Math.round(params[`s${index}`] ?? 0)
  if (!id) return <p className="face-hint">Add a pedal.</p>
  const delay = id === 16
  const room = id === 17
  return (
    <div className="pedal-detail">
      <strong>{PEDALS[id]}</strong>
      <label>Level
        <input aria-label="Pedal level" type="range" min={0} max={1} step={0.01} value={params[`a${index}`] ?? 0.5} onChange={(event) => onChange(`a${index}`, Number(event.target.value))} />
      </label>
      {delay || room ? (
        <select aria-label={delay ? 'Delay mode' : 'Reverb mode'} value={modeValue(params[`b${index}`] ?? 0)} onChange={(event) => onChange(`b${index}`, Number(event.target.value))}>
          {delay ? (
            <>
              <option value={0}>Analog</option>
              <option value={0.5}>Tape</option>
              <option value={1}>Digital</option>
            </>
          ) : (
            <>
              <option value={0}>Spring</option>
              <option value={0.5}>Plate</option>
              <option value={1}>Hall</option>
            </>
          )}
        </select>
      ) : (
        <label>Tone
          <input aria-label="Pedal tone" type="range" min={0} max={1} step={0.01} value={params[`b${index}`] ?? 0.35} onChange={(event) => onChange(`b${index}`, Number(event.target.value))} />
        </label>
      )}
      <button type="button" className={(params[`z${index}`] ?? 0) >= 0.5 ? 'on' : ''} onClick={() => onChange(`z${index}`, (params[`z${index}`] ?? 0) >= 0.5 ? 0 : 1)}>
        {(params[`z${index}`] ?? 0) >= 0.5 ? 'Post' : 'Pre'}
      </button>
      {id === 20 && (
        <>
          <button type="button" onClick={() => onLoop((params.loop ?? 0) >= 0.5 && (params.loop ?? 0) < 1.5 ? 0 : 1)}>Rec</button>
          <button type="button" onClick={() => onLoop((params.loop ?? 0) >= 1.5 ? 0 : 2)}>Play</button>
          {chainHasLoop(trackPlugins) && <button type="button" onClick={onOpenLoop}>Open Loop</button>}
        </>
      )}
      <button type="button" onClick={onRemove}>Remove</button>
    </div>
  )
}

function modeValue(value: number) {
  if (value < 0.34) return 0
  if (value < 0.67) return 0.5
  return 1
}

function Knob({ spec, value, onChange }: { spec: ParamSpec; value: number; pluginId: string; onChange: (value: number) => void }) {
  const { ref, readout, dragging } = useDragValue<HTMLButtonElement>({
    min: spec.min,
    max: spec.max,
    value,
    fallback: spec.default,
    onChange: (next) => onChange(next),
  })
  const span = spec.max - spec.min || 1
  const unit = Math.max(0, Math.min(1, (value - spec.min) / span))
  const angle = -140 + unit * 280
  const shown = `${Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100}${spec.unit ? ` ${spec.unit}` : ''}`
  return (
    <div className="knob">
      <button
        ref={ref}
        type="button"
        role="slider"
        className={dragging ? 'dragging' : ''}
        aria-label={spec.name}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Math.round(value * 100) / 100}
        aria-valuetext={shown}
      >
        <span style={{ transform: `rotate(${angle}deg)` }} />
      </button>
      <em>{spec.name}</em>
      <small>{shown}</small>
      <GestureReadout readout={readout} />
    </div>
  )
}

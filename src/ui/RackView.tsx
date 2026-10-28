import { useState } from 'react'
import { Keyboard, Knob } from './kit/controls'
import type { AudioEngine } from '../audio/engine'
import { noteName } from '../audio/sample/pitch'
import { LibraryPanel } from './LibraryPanel'
import { DEVICE_KINDS, DEVICE_NAMES, DEVICE_PARAMS, FACTORY_PRESETS, isInstrument, type DeviceKind } from '../model/rack'
import { selectRack } from '../state/select'
import type { ProjectStore } from '../state/store'
import './kit/kit.css'
import './instrument.css'

const LOOP = ['Loop', 'Ping', 'Once']

export function RackView({ store, engine, trackId, onOpenKnock }: { store: ProjectStore; engine: AudioEngine; trackId: string; onOpenKnock?: () => void }) {
  const rackState = selectRack(store, trackId)
  const track = rackState.track
  const rack = rackState.rack
  const [selected, setSelected] = useState(0)
  const [from, setFrom] = useState<{ id: string; port: string } | null>(null)
  const [more, setMore] = useState(false)
  if (!track || !rack) return null
  const device = rack.devices[Math.min(selected, rack.devices.length - 1)]
  const sampler = track.plugins.find((plugin) => plugin.pluginId === 'sampler' && plugin.sampler?.bufferId)
  const sampled = track.instrument === 'library' || track.instrument === 'sampler'
  const sampleName = sampler?.sampler?.bufferId ? store.buffers.get(sampler.sampler.bufferId)?.name : ''
  const play = (note: number, velocity = 0.85) => {
    engine.unlock()
    engine.previewRack(track.id, note, false, true, velocity)
  }
  const setParam = (param: string, value: number) => {
    const spec = DEVICE_PARAMS[device.kind].find((item) => item.id === param)
    const rolling = engine.status === 'playing' || engine.status === 'recording'
    store.setAutomated(
      { trackId: track.id, target: 'instrument', param, deviceId: device.id, min: spec?.min ?? 0, max: spec?.max ?? 1 },
      value,
      rolling,
      engine.currentTimelineSample(),
    )
  }
  const samplerParam = (id: string, value: number) => {
    if (!sampler) return
    store.updatePlugin(track.id, sampler.id, { params: { [id]: value } })
  }
  return (
    <div className={`rack inst-panel${sampled ? ' sampled' : ''}`}>
      <header className="inst-head">
        <strong>{track.instrument === 'library' && track.library ? track.library.name : track.name}</strong>
        {!sampled && (
          <div className="inst-devices" role="tablist" aria-label="Instrument devices">
            {rack.devices.map((item, index) => (
              <button key={item.id} type="button" className={`bevel${item.id === device.id ? ' on' : ''}`} role="tab" aria-selected={item.id === device.id} title={item.name === DEVICE_NAMES[item.kind] ? DEVICE_NAMES[item.kind] : `${DEVICE_NAMES[item.kind]}. ${item.name}`} onClick={() => setSelected(index)}>{item.name === 'Init' ? DEVICE_NAMES[item.kind] : item.name}</button>
            ))}
          </div>
        )}
        <button type="button" className="bevel inst-close" aria-label="Close the instrument panel." title="Close the instrument panel." onClick={() => store.openRack(track.id)}>×</button>
      </header>
      {track.instrument === 'library' && <LibraryPanel store={store} engine={engine} trackId={track.id} />}
      {sampled ? (
        <div className="inst-body">
          {track.instrument === 'sampler' && (
            <p className="inst-sample">{sampleName || 'No sample yet'}</p>
          )}
          <div className="inst-knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
            {track.instrument === 'sampler' && sampler?.sampler ? (
              <>
                <RootStep label="Root" value={sampler.sampler.root} onChange={(root) => store.setSamplerRoot(track.id, root)} />
                <Knob label="Attack" min={1} max={2000} value={sampler.params.attack ?? 6} fallback={6} unit="ms" onChange={(value) => samplerParam('attack', value)} />
                <Knob label="Decay" min={5} max={3000} value={sampler.params.decay ?? 200} fallback={200} unit="ms" onChange={(value) => samplerParam('decay', value)} />
                <Knob label="Sustain" min={0} max={1} value={sampler.params.sustain ?? 0.85} fallback={0.85} onChange={(value) => samplerParam('sustain', value)} />
                <Knob label="Release" min={5} max={4000} value={sampler.params.release ?? 180} fallback={180} unit="ms" onChange={(value) => samplerParam('release', value)} />
                <Knob label="Tone" min={80} max={16000} value={sampler.params.cutoff ?? 16000} fallback={16000} unit="Hz" onChange={(value) => samplerParam('cutoff', value)} />
              </>
            ) : track.library ? (
              <LibraryKnobs store={store} trackId={track.id} />
            ) : null}
          </div>
          {track.instrument === 'sampler' && sampler?.sampler && (
            <div className="inst-row">
              <button
                type="button"
                className={`bevel${sampler.sampler.loopMode === 0 ? ' on' : ''}`}
                title="Loop the sample, bounce it, or play it once."
                onClick={() => store.setSamplerLoop(track.id, ((sampler.sampler?.loopMode ?? 2) + 1) % 3)}
              >{LOOP[sampler.sampler.loopMode] ?? 'Once'}</button>
              <button type="button" className="bevel" title="Open the full sampler, with the waveform and pads." onClick={() => store.focusPlugin(track.id, sampler.id)}>Edit sample</button>
            </div>
          )}
          <Keyboard compact onDown={(note, velocity) => play(note, velocity)} onUp={(note) => engine.releaseRack(track.id, note)} />
        </div>
      ) : store.rackFlip ? (
        <div className="rack-body flip">
          {rack.devices.map((item) => (
            <div className="device" key={item.id}>
              <b>{item.name}</b>
              <button type="button" className={`bevel${from?.id === item.id && from.port === 'audio' ? ' on' : ''}`} onClick={() => setFrom({ id: item.id, port: 'audio' })}>Out</button>
              <button type="button" className="bevel" onClick={() => from && store.addCable(track.id, from.id, from.port, item.id, 'audio')}>In</button>
            </div>
          ))}
          <div className="cables">
            {rack.cables.map((cable) => (
              <button type="button" className="bevel" key={cable.id} onClick={() => store.removeCable(track.id, cable.id)}>
                {rack.devices.find((item) => item.id === cable.from)?.name} {cable.fromPort}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="inst-body">
          <div className="inst-row">
            <select className="bevel" aria-label="Preset" title="Load a preset for this device." value="" onChange={(event) => event.target.value && store.applyDevicePreset(track.id, device.id, event.target.value)}>
              <option value="">Preset</option>
              {FACTORY_PRESETS[device.kind].map((item) => (
                <option key={item.name} value={item.name}>{item.name}</option>
              ))}
            </select>
            <select className="bevel" aria-label="Add device" title="Add a device to this instrument." value="" onChange={(event) => event.target.value && store.addDevice(track.id, event.target.value as DeviceKind)}>
              <option value="">Add</option>
              {DEVICE_KINDS.map((kind) => (
                <option key={kind} value={kind}>{DEVICE_NAMES[kind]}</option>
              ))}
            </select>
            <button type="button" className={`bevel${more ? ' on' : ''}`} title="Show every knob, or just the main four." onClick={() => { setMore((value) => !value); store.toggleRackDetail() }}>More</button>
            <button type="button" className={`bevel${store.rackFlip ? ' on' : ''}`} title="Patch cables between devices." onClick={() => store.flipRack()}>Wire</button>
          </div>
          <div className="inst-knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
            {(more ? DEVICE_PARAMS[device.kind] : DEVICE_PARAMS[device.kind].slice(0, 4)).map((param) => (
              <Knob
                key={param.id}
                label={param.name}
                min={param.min}
                max={param.max}
                value={device.params[param.id] ?? param.default}
                fallback={param.default}
                unit={param.unit}
                onChange={(value) => setParam(param.id, value)}
              />
            ))}
          </div>
          {device.kind === 'knock' && (
            <button type="button" className="bevel" title="Open the Knock drum instrument." onClick={() => onOpenKnock?.()}>Open Knock</button>
          )}
          {isInstrument(device.kind) && (
            <Keyboard compact onDown={(note, velocity) => play(note, velocity)} onUp={(note) => engine.releaseRack(track.id, note)} />
          )}
        </div>
      )}
    </div>
  )
}

function LibraryKnobs({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const program = store.track(trackId)?.library
  if (!program) return null
  const zone = program.zones[0]
  const play = program.play ?? {
    tune: 0,
    attack: zone?.ampeg.attack ?? 0.004,
    decay: zone?.ampeg.decay ?? 0.2,
    sustain: zone?.ampeg.sustain ?? 0.85,
    release: zone?.ampeg.release ?? 0.2,
    tone: 20000,
  }
  const set = (patch: Partial<typeof play>) => store.setInstrumentPlay(trackId, patch)
  return (
    <>
      <RootStep label="Tune" value={60 + play.tune} onChange={(note) => set({ tune: note - 60 })} />
      <Knob label="Attack" min={0} max={2} value={play.attack} fallback={0.004} unit="s" onChange={(attack) => set({ attack })} />
      <Knob label="Decay" min={0} max={4} value={play.decay} fallback={0.2} unit="s" onChange={(decay) => set({ decay })} />
      <Knob label="Sustain" min={0} max={1} value={play.sustain} fallback={0.85} onChange={(sustain) => set({ sustain })} />
      <Knob label="Release" min={0.01} max={4} value={play.release} fallback={0.2} unit="s" onChange={(release) => set({ release })} />
      <Knob label="Tone" min={80} max={20000} value={play.tone} fallback={20000} unit="Hz" onChange={(tone) => set({ tone })} />
    </>
  )
}

function RootStep({ label, value, onChange }: { label: string; value: number; onChange: (note: number) => void }) {
  const note = Math.max(0, Math.min(127, Math.round(value)))
  return (
    <div className="root-step" title={`${label}. The sample plays unchanged on this note. Other keys change the pitch.`}>
      <button type="button" className="bevel" aria-label={`Lower ${label}`} onClick={() => onChange(note - 1)}>−</button>
      <span>
        <em>{label}</em>
        <b>{noteName(note)}</b>
      </span>
      <button type="button" className="bevel" aria-label={`Raise ${label}`} onClick={() => onChange(note + 1)}>+</button>
    </div>
  )
}

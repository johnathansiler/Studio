import { useState } from 'react'
import { Keyboard, Knob } from './kit/controls'
import type { AudioEngine } from '../audio/engine'
import { LibraryPanel } from './LibraryPanel'
import { SamplerFace } from './SamplerFace'
import { DEVICE_KINDS, DEVICE_NAMES, DEVICE_PARAMS, FACTORY_PRESETS, isInstrument, type DeviceKind } from '../model/rack'
import { selectRack } from '../state/select'
import type { ProjectStore } from '../state/store'
import './kit/kit.css'
import './instrument.css'

export function RackView({ store, engine, trackId, onOpenKnock }: { store: ProjectStore; engine: AudioEngine; trackId: string; onOpenKnock?: () => void }) {
  const rackState = selectRack(store, trackId)
  const track = rackState.track
  const rack = rackState.rack
  const [selected, setSelected] = useState(0)
  const [from, setFrom] = useState<{ id: string; port: string } | null>(null)
  const [more, setMore] = useState(false)
  if (!track) return null
  const sampled = track.instrument === 'library' || track.instrument === 'sampler'
  if (!rack && !sampled) return null
  const device = rack?.devices[Math.min(selected, Math.max(0, rack.devices.length - 1))]
  const play = (note: number, velocity = 0.85) => {
    engine.unlock()
    engine.previewRack(track.id, note, false, true, velocity)
  }
  const setParam = (param: string, value: number) => {
    if (!device) return
    const spec = DEVICE_PARAMS[device.kind].find((item) => item.id === param)
    const rolling = engine.status === 'playing' || engine.status === 'recording'
    store.setAutomated(
      { trackId: track.id, target: 'instrument', param, deviceId: device.id, min: spec?.min ?? 0, max: spec?.max ?? 1 },
      value,
      rolling,
      engine.currentTimelineSample(),
    )
  }
  return (
    <div className={`rack inst-panel${sampled ? ' sampled' : ''}`}>
      <header className="inst-head">
        <strong>{track.instrument === 'library' && track.library ? track.library.name : track.name}</strong>
        {!sampled && rack && (
          <div className="inst-devices" role="tablist" aria-label="Instrument devices">
            {rack.devices.map((item, index) => (
              <button key={item.id} type="button" className={`bevel${device && item.id === device.id ? ' on' : ''}`} role="tab" aria-selected={!!device && item.id === device.id} title={item.name === DEVICE_NAMES[item.kind] ? DEVICE_NAMES[item.kind] : `${DEVICE_NAMES[item.kind]}. ${item.name}`} onClick={() => setSelected(index)}>{item.name === 'Init' ? DEVICE_NAMES[item.kind] : item.name}</button>
            ))}
          </div>
        )}
        <button type="button" className="bevel inst-close" aria-label="Close the instrument panel." title="Close the instrument panel." onClick={() => store.openRack(track.id)}>×<span className="fold-word">Close</span></button>
      </header>
      {sampled ? (
        <SamplerFace store={store} engine={engine} trackId={track.id} />
      ) : rack && store.rackFlip ? (
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
      ) : device ? (
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
      ) : null}
      {track.instrument === 'library' && <LibraryPanel store={store} engine={engine} trackId={track.id} />}
    </div>
  )
}

import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { DEVICE_KINDS, DEVICE_NAMES, DEVICE_PARAMS, FACTORY_PRESETS, type DeviceKind } from '../model/rack'
import { samplesToBeats } from '../model/time'
import type { ProjectStore } from '../state/store'

export function RackView({ store, engine, trackId, onOpenKnock }: { store: ProjectStore; engine: AudioEngine; trackId: string; onOpenKnock?: () => void }) {
  const track = store.track(trackId)
  const rack = track?.rack
  const [selected, setSelected] = useState(0)
  const [from, setFrom] = useState<{ id: string; port: string } | null>(null)
  if (!track || !rack) return null
  const device = rack.devices[Math.min(selected, rack.devices.length - 1)]
  const names = [
    ...FACTORY_PRESETS[device.kind].map((item) => item.name),
    ...store.project.devicePresets.filter((item) => item.kind === device.kind).map((item) => item.name),
  ]
  const setParam = (param: string, value: number) => {
    store.setDeviceParam(track.id, device.id, param, value)
    if (engine.status === 'recording' || engine.status === 'playing') {
      const beat = samplesToBeats(engine.currentTimelineSample(), engine.sampleRate, store.project.tempo)
      store.addRackPoint(device.id, param, beat, value)
    }
  }
  return (
    <div className="rack">
      <header>
        <strong>{track.name}</strong>
        <select value="" onChange={(event) => event.target.value && store.addDevice(track.id, event.target.value as DeviceKind)}>
          <option value="">+</option>
          {DEVICE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{DEVICE_NAMES[kind]}</option>
          ))}
        </select>
        <select value="" onChange={(event) => event.target.value && store.loadRackPatch(track.id, event.target.value)}>
          <option value="">Patch</option>
          {store.project.rackPatches.map((patch) => (
            <option key={patch.id} value={patch.name}>{patch.name}</option>
          ))}
        </select>
        <button className="text-btn" onClick={() => {
          const name = window.prompt('Patch')
          if (name) store.saveRackPatch(track.id, name.trim())
        }}>Save</button>
        <button className={`text-btn ${store.rackFlip ? 'on' : ''}`} onClick={() => store.flipRack()}>Flip</button>
        <button className="text-btn" onClick={() => store.openRack(track.id)}>×</button>
      </header>
      {store.rackFlip ? (
        <div className="rack-body flip">
          {rack.devices.map((item) => (
            <div className="device" key={item.id}>
              <b>{item.name}</b>
              <button className={from?.id === item.id && from.port === 'audio' ? 'on' : ''} onClick={() => setFrom({ id: item.id, port: 'audio' })}>out</button>
              <button onClick={() => from && store.addCable(track.id, from.id, from.port, item.id, 'audio')}>in</button>
              {item.kind === 'sub' && <button className={from?.id === item.id && from.port === 'lfo1' ? 'on' : ''} onClick={() => setFrom({ id: item.id, port: 'lfo1' })}>lfo</button>}
              {item.kind === 'seq' && <button className={from?.id === item.id && from.port === 'cv' ? 'on' : ''} onClick={() => setFrom({ id: item.id, port: 'cv' })}>cv</button>}
              {DEVICE_PARAMS[item.kind].slice(0, 4).map((param) => (
                <button key={param.id} onClick={() => from && store.addCable(track.id, from.id, from.port, item.id, param.id)}>{param.name}</button>
              ))}
            </div>
          ))}
          <div className="cables">
            {rack.cables.map((cable) => (
              <button key={cable.id} onClick={() => store.removeCable(track.id, cable.id)}>
                {rack.devices.find((item) => item.id === cable.from)?.name} {cable.fromPort} → {cable.toPort}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="rack-body">
          <div className="device-list">
            {rack.devices.map((item, index) => (
              <button key={item.id} className={item.id === device.id ? 'on' : ''} onClick={() => setSelected(index)}>{item.name}</button>
            ))}
          </div>
          <div className="device-edit">
            <div className="row">
              <select value="" onChange={(event) => event.target.value && store.applyDevicePreset(track.id, device.id, event.target.value)}>
                <option value="">Preset</option>
                {names.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <button className="text-btn" onClick={() => {
                const name = window.prompt('Preset')
                if (name) store.saveDevicePreset(device.kind, name.trim(), device.params)
              }}>Save</button>
              <button className="text-btn" onClick={() => store.moveDevice(track.id, device.id, -1)}>←</button>
              <button className="text-btn" onClick={() => store.moveDevice(track.id, device.id, 1)}>→</button>
              <button className="text-btn" onClick={() => store.removeDevice(track.id, device.id)}>×</button>
            </div>
            <div className="knobs">
              {DEVICE_PARAMS[device.kind].map((param) => (
                <label key={param.id}>
                  {param.name} {Math.round((device.params[param.id] ?? param.default) * 100) / 100}{param.unit ? ` ${param.unit}` : ''}
                  <input
                    type="range"
                    min={param.min}
                    max={param.max}
                    step={(param.max - param.min) <= 2 ? 0.01 : (param.max - param.min) <= 40 ? 0.1 : 1}
                    value={device.params[param.id] ?? param.default}
                    aria-label={param.name}
                    onChange={(event) => setParam(param.id, Number(event.target.value))}
                  />
                </label>
              ))}
            </div>
            {device.kind === 'knock' && (
              <button className="text-btn" onClick={() => onOpenKnock?.()}>Open Knock</button>
            )}
            {(device.kind === 'sampler' || device.kind === 'knock') && (
              <select aria-label="Sample" value="" onChange={(event) => event.target.value && store.addZone(track.id, device.id, event.target.value)}>
                <option value="">Sample</option>
                {[...store.buffers.values()].map((buffer) => (
                  <option key={buffer.id} value={buffer.id}>{buffer.name}</option>
                ))}
              </select>
            )}
            {device.kind === 'drum' && (
              <div className="steps">
                {device.pattern.map((mask, step) => (
                  <button key={step} className={mask & 1 ? 'on' : ''} onClick={() => store.toggleStep(track.id, device.id, step, 0)}>{step + 1}</button>
                ))}
              </div>
            )}
            {device.kind === 'sub' && (
              <button className="text-btn" onClick={() => engine.previewRack(track.id, 60)}>C</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { DEVICE_KINDS, DEVICE_NAMES, DEVICE_PARAMS, FACTORY_PRESETS, isInstrument, MACRO_TARGETS, PRESET_CATEGORIES, type DeviceKind } from '../model/rack'
import type { ProjectStore } from '../state/store'

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

export function RackView({ store, engine, trackId, onOpenKnock }: { store: ProjectStore; engine: AudioEngine; trackId: string; onOpenKnock?: () => void }) {
  const track = store.track(trackId)
  const rack = track?.rack
  const [selected, setSelected] = useState(0)
  const [from, setFrom] = useState<{ id: string; port: string } | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [preset, setPreset] = useState('')
  if (!track || !rack) return null
  const device = rack.devices[Math.min(selected, rack.devices.length - 1)]
  const favorites = store.project.presetFavorites ?? []
  const rows = [
    ...FACTORY_PRESETS[device.kind].map((item) => ({ name: item.name, category: item.category || '' })),
    ...store.project.devicePresets.filter((item) => item.kind === device.kind).map((item) => ({ name: item.name, category: item.category || '' })),
  ]
  const visible = rows.filter((item) => {
    if (query && !item.name.toLowerCase().includes(query.toLowerCase())) return false
    if (category && item.category !== category) return false
    if (favoritesOnly && !favorites.includes(`${device.kind}:${item.name}`)) return false
    return true
  })
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
  const macros = [1, 2, 3, 4].map((slot) => {
    const target = MACRO_TARGETS[Math.round(device.params[`m${slot}t`] ?? slot - 1)] || `M${slot}`
    const mapped = DEVICE_PARAMS[device.kind].some((item) => item.id === target)
    return { id: `m${slot}`, name: mapped ? target : `M${slot}` }
  })
  return (
    <div className="rack">
      <header>
        <strong>{track.name}</strong>
        <select aria-label="Add device" value="" onChange={(event) => event.target.value && store.addDevice(track.id, event.target.value as DeviceKind)}>
          <option value="">+</option>
          {DEVICE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{DEVICE_NAMES[kind]}</option>
          ))}
        </select>
        <select aria-label="Patch" value="" onChange={(event) => event.target.value && store.loadRackPatch(track.id, event.target.value)}>
          <option value="">Patch</option>
          {store.project.rackPatches.map((patch) => (
            <option key={patch.id} value={patch.name}>{patch.name}</option>
          ))}
        </select>
        <button className={`text-btn ${store.rackDetail ? 'on' : ''}`} onClick={() => store.toggleRackDetail()}>Edit</button>
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
              {(item.kind === 'sub' || item.kind === 'wave') && <button className={from?.id === item.id && from.port === 'lfo1' ? 'on' : ''} onClick={() => setFrom({ id: item.id, port: 'lfo1' })}>lfo</button>}
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
              <button key={item.id} className={item.id === device.id ? 'on' : ''} onClick={() => { setSelected(index); setPreset('') }}>{item.name}</button>
            ))}
          </div>
          <div className="device-edit">
            <div className="row">
              <input aria-label="Search" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select aria-label="Category" value={category} onChange={(event) => setCategory(event.target.value)}>
                <option value="">All</option>
                {PRESET_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
              <button className={`text-btn ${favoritesOnly ? 'on' : ''}`} aria-label="Favorites" onClick={() => setFavoritesOnly((value) => !value)}>★</button>
              <select aria-label="Preset" value={preset} onChange={(event) => {
                const name = event.target.value
                setPreset(name)
                if (name) store.applyDevicePreset(track.id, device.id, name)
              }}>
                <option value="">Preset</option>
                {visible.map((item) => (
                  <option key={item.name} value={item.name}>{favorites.includes(`${device.kind}:${item.name}`) ? `★ ${item.name}` : item.name}</option>
                ))}
              </select>
              <button className="text-btn" onClick={() => preset && store.togglePresetFavorite(device.kind, preset)}>Fav</button>
              <button className="text-btn" onClick={() => store.mutateDevice(track.id, device.id)}>Vary</button>
              <button className="text-btn" onClick={() => {
                const name = window.prompt('Preset')
                if (name) store.saveDevicePreset(device.kind, name.trim(), device.params)
              }}>Save</button>
            </div>
            {store.rackDetail ? (
              <div className="knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
                {DEVICE_PARAMS[device.kind].map((param) => (
                  <label key={param.id}>
                    {param.name}
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
            ) : (
              <div className="knobs macros" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
                {macros.map((macro) => {
                  const spec = DEVICE_PARAMS[device.kind].find((item) => item.id === macro.id)
                  if (!spec) return null
                  return (
                    <label key={macro.id}>
                      {macro.name}
                      <input
                        type="range"
                        min={spec.min}
                        max={spec.max}
                        step={0.01}
                        value={device.params[macro.id] ?? spec.default}
                        aria-label={macro.name}
                        onChange={(event) => setParam(macro.id, Number(event.target.value))}
                      />
                    </label>
                  )
                })}
              </div>
            )}
            {device.kind === 'knock' && (
              <button className="text-btn" onClick={() => onOpenKnock?.()}>Open Knock</button>
            )}
            {(device.kind === 'sampler' || device.kind === 'wave' || device.kind === 'knock') && (
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
            {isInstrument(device.kind) && (
              <div className="rack-keys">
                {KEYS.map(([note, label]) => (
                  <button key={note} className="text-btn" onClick={() => engine.previewRack(track.id, note)}>{label}</button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

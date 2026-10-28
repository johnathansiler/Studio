import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { peaks } from '../audio/sample/engine'
import { uid, type PluginInstance } from '../model/types'
import { samplesToBeats } from '../model/time'
import { selectTransport } from '../state/select'
import type { ProjectStore } from '../state/store'

const PADS = Array.from({ length: 16 }, (_, index) => index)

export function SamplePanel({ store, engine, trackId, plugin }: { store: ProjectStore; engine: AudioEngine; trackId: string | 'master'; plugin: PluginInstance }) {
  const [more, setMore] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const sampler = plugin.sampler
  const looper = plugin.looper
  const bufferId = sampler?.bufferId || looper?.layers[0]?.bufferId || ''
  const channel = bufferId ? store.buffers.get(bufferId)?.channels[0] : undefined
  useEffect(() => {
    const view = canvas.current
    const ctx = view?.getContext('2d')
    if (!view || !ctx) return
    ctx.clearRect(0, 0, view.width, view.height)
    ctx.fillStyle = '#73c48f'
    const bars = channel ? peaks(channel, 64) : []
    bars.forEach((bar, index) => {
      const mid = view.height / 2
      const top = mid - bar.max * mid
      const height = Math.max(1, (bar.max - bar.min) * mid)
      ctx.fillRect(index * (view.width / 64), top, Math.max(1, view.width / 64 - 1), height)
    })
  }, [channel, plugin.id])
  useEffect(() => {
    if (plugin.pluginId !== 'looper') return
    const timer = window.setInterval(() => {
      const audio = engine.takeLoop(plugin.id)
      if (audio) store.addLooperLayer(trackId, plugin.id, audio)
    }, 240)
    return () => window.clearInterval(timer)
  }, [engine, plugin.id, plugin.pluginId, store, trackId])
  const transport = selectTransport(store)
  const beat = () => samplesToBeats(engine.currentTimelineSample(), engine.sampleRate, transport.tempo)
  const loadFile = async (file: File) => {
    const ctx = new AudioContext()
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer())
    const id = uid('smp')
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index).slice())
    store.addAsset({ id, name: file.name, sampleRate: decoded.sampleRate, channels })
    if (sampler) store.setSampleBuffer(trackId, plugin.id, id)
    else store.addLooperLayer(trackId, plugin.id, channels[0])
    await ctx.close()
  }
  return (
    <div
      className="sample-panel"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault()
        const file = event.dataTransfer.files[0]
        if (file) void loadFile(file)
      }}
    >
      <canvas ref={canvas} width={320} height={56} className="spectrum" />
      {sampler && (
        <>
          <div className="row">
            <select
              aria-label="Source"
              value={sampler.bufferId || plugin.sidechain}
              onChange={(event) => {
                const value = event.target.value
                if (!value || store.buffers.has(value)) store.setSampleBuffer(trackId, plugin.id, value)
                else store.updatePlugin(trackId, plugin.id, { sidechain: value })
              }}
            >
              <option value="">Input</option>
              {[...store.buffers.values()].map((asset) => (
                <option key={asset.id} value={asset.id}>{asset.name}</option>
              ))}
              {store.project.tracks.map((track) => (
                <option key={track.id} value={track.id}>{track.name}</option>
              ))}
              <option value="master">Master</option>
            </select>
            <label className="text-btn">
              Load
              <input className="file" type="file" accept="audio/*" onChange={(event) => event.target.files?.[0] && void loadFile(event.target.files[0])} />
            </label>
            <button className={`text-btn ${plugin.params.keys >= 0.5 ? 'on' : ''}`} onClick={() => store.updatePlugin(trackId, plugin.id, { params: { keys: plugin.params.keys >= 0.5 ? 0 : 1 } })}>Keys</button>
            <button className={`text-btn ${more ? 'on' : ''}`} onClick={() => setMore((value) => !value)}>More</button>
          </div>
          {plugin.params.keys >= 0.5 ? (
            <div className="pads keys">
              {['C', 'D', 'E', 'F', 'G', 'A', 'B', 'C'].map((label, index) => {
                const note = [60, 62, 64, 65, 67, 69, 71, 72][index]
                return <button key={label + index} className="text-btn" onClick={() => engine.previewSample(plugin.id, note)}>{label}</button>
              })}
            </div>
          ) : (
            <div className="pads">
              {PADS.map((pad) => (
                <button key={pad} className="text-btn" onClick={() => engine.previewSample(plugin.id, 36 + pad)}>{pad + 1}</button>
              ))}
            </div>
          )}
          {more && (
            <div className="row">
              <button className="text-btn" onClick={() => store.chopSample(trackId, plugin.id, 'transient')}>Transient</button>
              <button className="text-btn" onClick={() => store.chopSample(trackId, plugin.id, 'grid')}>Grid</button>
              <button className="text-btn" onClick={() => store.chopSample(trackId, plugin.id, 'beat')}>Beat</button>
              <button className="text-btn" onClick={() => store.exportSlices(trackId, plugin.id)}>MIDI</button>
              <button className="text-btn" onClick={() => store.editSample(trackId, plugin.id, 'norm')}>Norm</button>
              <button className="text-btn" onClick={() => store.editSample(trackId, plugin.id, 'reverse')}>Rev</button>
              <button className="text-btn" onClick={() => store.editSample(trackId, plugin.id, 'trim')}>Trim</button>
              <button className="text-btn" onClick={() => store.editSample(trackId, plugin.id, 'fade')}>Fade</button>
              <button className="text-btn" onClick={() => store.editSample(trackId, plugin.id, 'snap')}>Snap</button>
              <button className="text-btn" onClick={() => store.updatePlugin(trackId, plugin.id, { params: { record: plugin.params.record >= 0.5 ? 0 : 1 } })}>Rec</button>
            </div>
          )}
        </>
      )}
      {looper && (
        <>
          <div className="row">
            <button className="text-btn" onClick={() => store.armLooper(trackId, plugin.id, 2, beat())}>Rec</button>
            <button className="text-btn" onClick={() => store.armLooper(trackId, plugin.id, 3, beat())}>Dub</button>
            <button className="text-btn" onClick={() => store.armLooper(trackId, plugin.id, 1, beat())}>Play</button>
            <button className="text-btn" onClick={() => store.armLooper(trackId, plugin.id, 0, beat())}>Stop</button>
            <button className="text-btn" onClick={() => store.undoLooper(trackId, plugin.id)}>Undo</button>
            <button className="text-btn" onClick={() => store.redoLooper(trackId, plugin.id)}>Redo</button>
            <button className={`text-btn ${more ? 'on' : ''}`} onClick={() => setMore((value) => !value)}>More</button>
          </div>
          {more && (
            <div className="row">
              <button className="text-btn" onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, bars: Math.min(8, looper.bars + 1) } })}>{looper.bars} bar</button>
              <button className={`text-btn ${looper.sync ? 'on' : ''}`} onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, sync: !looper.sync } })}>Sync</button>
              <button className="text-btn" onClick={() => store.updatePlugin(trackId, plugin.id, { params: { speed: (plugin.params.speed || 1) < 1 ? 1 : 0.5 }, looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, speed: (layer.speed || 1) < 1 ? 1 : 0.5 } : layer) } })}>Half</button>
              <button className="text-btn" onClick={() => store.updatePlugin(trackId, plugin.id, { params: { speed: (plugin.params.speed || 1) > 1 ? 1 : 2 }, looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, speed: (layer.speed || 1) > 1 ? 1 : 2 } : layer) } })}>Double</button>
              <button className="text-btn" onClick={() => store.updatePlugin(trackId, plugin.id, { looper: { ...looper, layers: looper.layers.map((layer, index) => index === looper.layers.length - 1 ? { ...layer, reverse: !layer.reverse } : layer) } })}>Rev</button>
              <button className="text-btn" onClick={() => store.clearLooper(trackId, plugin.id)}>Clear</button>
              {trackId !== 'master' && <button className="text-btn" onClick={() => store.bounceLooper(trackId, plugin.id, engine.currentTimelineSample())}>Bounce</button>}
              <label className="text-btn">
                Load
                <input className="file" type="file" accept="audio/*" onChange={(event) => event.target.files?.[0] && void loadFile(event.target.files[0])} />
              </label>
            </div>
          )}
        </>
      )}
    </div>
  )
}

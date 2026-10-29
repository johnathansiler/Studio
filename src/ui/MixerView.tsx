import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS } from '../model/layoutWidth'
import { selectMixer } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { AutoFader, AutomationModeBar, LinkGroup, MixFlags } from './AutomationLane'
import { useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'
import { MasterSheet } from './MasterSheet'
import { InsertList, RouteFields, SendList } from './PluginSheet'

export function MixerView({ store, engine, onTune }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void }) {
  return <MixerBody key={store.project.id} store={store} engine={engine} onTune={onTune} />
}

function MixerBody({ store, engine, onTune }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void }) {
  const project = selectMixer(store).project
  const { layout, setStrip, resetStrip } = useLayoutWidths(project.id)
  const areaRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef(layout.strip)
  stripRef.current = layout.strip
  usePinchResize(areaRef, () => stripRef.current, setStrip, STRIP_BOUNDS)
  const [masterOpen, setMasterOpen] = useState(false)
  return (
    <>
    <div className="mixer-view" ref={areaRef} data-strip-width={layout.strip} style={{ ['--strip' as string]: `${layout.strip}px` }}>
      <WidthBar axis="strip" value={layout.strip} onChange={setStrip} onReset={resetStrip} />
      <div className="mixer">
      <AutomationModeBar store={store} />
      {project.tracks.map((track) => (
        <div className="strip" data-track={track.id} key={track.id}>
          <h3 style={{ color: track.color }}>{track.name}</h3>
          <RouteFields store={store} trackId={track.id} />
          <LinkGroup store={store} trackId={track.id} />
          <InsertList store={store} trackId={track.id} />
          <SendList store={store} trackId={track.id} engine={engine} />
          <AutoFader className="pan" store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} />
          <div className="fader-row">
            <Meter engine={engine} id={track.id} />
            <AutoFader store={store} engine={engine} label={`${track.name} volume. How loud this track is.`} value={track.volume} spec={{ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }} />
          </div>
          <div className="row">
            <MixFlags store={store} trackId={track.id} />
            {track.type === 'audio' && onTune && (
              <button type="button" className="mini tune-btn" aria-label={`Tune ${track.name}. Check the pitch of this input.`} title="Check the pitch of this input." onClick={() => onTune(track.id)}>Tune</button>
            )}
          </div>
        </div>
      ))}
      <AddTrackButton store={store} />
      <div className="strip master">
        <h3>Master</h3>
        <button id="master-open" className="text-btn master-open" aria-label="Master. Loudness, tone, and the limiter." title="Loudness, tone, and the limiter." onClick={() => setMasterOpen(true)}>Master</button>
        <MasterReadout engine={engine} />
        <div className="fader-row">
          <Meter engine={engine} id="master" />
          <input type="range" min={0} max={1.25} step={0.01} aria-label="Master volume. How loud the whole mix is." title="How loud the whole mix is." value={project.masterVolume} onChange={(event) => store.setMasterVolume(Number(event.target.value))} />
        </div>
      </div>
      </div>
    </div>
    {masterOpen && <MasterSheet store={store} engine={engine} onClose={() => setMasterOpen(false)} />}
    </>
  )
}

function MasterReadout({ engine }: { engine: AudioEngine }) {
  const [text, setText] = useState({ lufs: '—', integrated: '—', peak: '—', cpu: '0' })
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const meters = engine.mixMeters()
      const reading = engine.masterReading()
      const next = {
        lufs: Number.isFinite(meters.lufs) ? meters.lufs.toFixed(1) : '—',
        integrated: reading && reading.integrated > -70 ? reading.integrated.toFixed(1) : '—',
        peak: reading && reading.truePeak > -70 ? reading.truePeak.toFixed(1) : (Number.isFinite(meters.truePeak) ? meters.truePeak.toFixed(1) : '—'),
        cpu: String(Math.round((meters.cpu || 0) * 100)),
      }
      setText((prev) => (prev.lufs === next.lufs && prev.integrated === next.integrated && prev.peak === next.peak && prev.cpu === next.cpu ? prev : next))
      timer = window.setTimeout(tick, 200)
    }
    timer = window.setTimeout(tick, 200)
    return () => window.clearTimeout(timer)
  }, [engine])
  return (
    <div className="master-read" id="master-meters">
      <span>LUFS</span>
      <b>{text.lufs}</b>
      <span>Integrated</span>
      <b>{text.integrated}</b>
      <span>Peak {text.peak} dB</span>
      <span>CPU {text.cpu}%</span>
    </div>
  )
}

function Meter({ engine, id }: { engine: AudioEngine; id: string }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const levels = engine.levels()
      const value = Math.min(1, (id === 'master' ? levels.master : levels.tracks[id] || 0) * 3.2)
      setLevel((prev) => (Math.abs(prev - value) < 0.03 ? prev : value))
      timer = window.setTimeout(tick, 80)
    }
    timer = window.setTimeout(tick, 80)
    return () => window.clearTimeout(timer)
  }, [engine, id])
  return (
    <div className="meter">
      <b style={{ height: `${level * 100}%` }} />
    </div>
  )
}

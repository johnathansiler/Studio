import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip } from '../model/layoutWidth'
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
  const [viewport, setViewport] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    const apply = () => setViewport(window.innerWidth)
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const strip = displayedStrip(layout.strip, viewport)
  return (
    <>
    <div className="mixer-view" ref={areaRef} data-strip-width={strip} style={{ ['--strip' as string]: `${strip}px` }}>
      <WidthBar axis="strip" value={layout.strip} onChange={setStrip} onReset={resetStrip} />
      <div className="mixer">
      {project.tracks.map((track) => (
        <div className="strip" data-track={track.id} key={track.id}>
          <h3 style={{ color: track.color }}>{track.name}</h3>
          <AutomationModeBar store={store} embedded />
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
        <MasterMeters engine={engine} />
        <Readout engine={engine} />
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

function MasterMeters({ engine }: { engine: AudioEngine }) {
  const [text, setText] = useState('I —   TP —')
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const reading = engine.masterReading()
      const integrated = reading && reading.integrated > -60 ? reading.integrated.toFixed(1) : '—'
      const peak = reading && reading.truePeak > -60 ? reading.truePeak.toFixed(1) : '—'
      const next = `I ${integrated}   TP ${peak}`
      setText((prev) => (prev === next ? prev : next))
      timer = window.setTimeout(tick, 250)
    }
    timer = window.setTimeout(tick, 250)
    return () => window.clearTimeout(timer)
  }, [engine])
  return <div className="readout" id="master-meters">{text}</div>
}

function Readout({ engine }: { engine: AudioEngine }) {
  const [text, setText] = useState('0% · -70.0 LUFS · -70.0 dB')
  useEffect(() => {
    let timer = 0
    const tick = () => {
      const meters = engine.mixMeters()
      const next = `${Math.round(meters.cpu * 100)}% · ${meters.lufs.toFixed(1)} LUFS · ${meters.truePeak.toFixed(1)} dB`
      setText((prev) => (prev === next ? prev : next))
      timer = window.setTimeout(tick, 200)
    }
    timer = window.setTimeout(tick, 200)
    return () => window.clearTimeout(timer)
  }, [engine])
  return <div className="readout">{text}</div>
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

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip, isNarrowStrip, mixerFlow } from '../model/layoutWidth'
import { selectMixer } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { AutoFader, ChannelAutomation, LinkGroup, MixFlags } from './AutomationLane'
import { showHint } from './Hint'
import { useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'
import { MasterSheet } from './MasterSheet'
import { InsertList, RouteFields, SendList } from './PluginSheet'
import { TouchSlider } from './kit/controls'

export function MixerView({ store, engine, onTune }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void }) {
  return <MixerBody key={store.project.id} store={store} engine={engine} onTune={onTune} />
}

function readViewport() {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function MixerBody({ store, engine, onTune }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void }) {
  const project = selectMixer(store).project
  const { layout, setStrip, setMixer, resetStrip } = useLayoutWidths(project.id)
  const areaRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef(layout.strip)
  stripRef.current = layout.strip
  usePinchResize(areaRef, () => stripRef.current, setStrip, STRIP_BOUNDS)
  const [masterOpen, setMasterOpen] = useState(false)
  const [viewport, setViewport] = useState(readViewport)
  const [fxTrack, setFxTrack] = useState<string | 'master' | null>(null)
  const [levelsOpen, setLevelsOpen] = useState(false)
  useEffect(() => {
    const apply = () => setViewport(readViewport())
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const strip = displayedStrip(layout.strip, viewport.width)
  const flow = mixerFlow(layout.mixer, viewport.width, viewport.height)
  const narrow = flow === 'columns' && isNarrowStrip(strip)
  const rows = flow === 'rows'
  const compact = narrow || rows
  return (
    <>
    <div
      className="mixer-view"
      ref={areaRef}
      data-strip-width={strip}
      data-layout={flow}
      data-narrow={narrow ? '1' : undefined}
      style={{ ['--strip' as string]: `${strip}px` }}
    >
      <WidthBar axis="strip" value={layout.strip} onChange={setStrip} onReset={resetStrip} mixer={flow} onMixer={setMixer} />
      {levelsOpen && <LevelBar engine={engine} onClose={() => setLevelsOpen(false)} />}
      {fxTrack ? (
        <StripSlots store={store} engine={engine} trackId={fxTrack} onBack={() => setFxTrack(null)} />
      ) : (
      <div className="mixer">
      {project.tracks.map((track) => (
        <div className={`strip${store.selectedTrackId === track.id ? ' is-selected' : ''}`} data-track={track.id} key={track.id} onClick={() => store.selectTrack(track.id)}>
          <StripName name={track.name} narrow={narrow} color={track.color} />
          <ChannelAutomation store={store} trackId={track.id} />
          {compact ? (
            <button type="button" className="mini fx-open" aria-label={`${track.name} effects. Inserts and sends.`} title="Inserts and sends." onClick={() => setFxTrack(track.id)}>FX</button>
          ) : (
            <>
              <RouteFields store={store} trackId={track.id} />
              <LinkGroup store={store} trackId={track.id} />
              <InsertList store={store} trackId={track.id} />
              <SendList store={store} trackId={track.id} engine={engine} />
            </>
          )}
          <AutoFader className="pan" store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} />
          <div className="fader-row">
            <Meter engine={engine} id={track.id} />
            <AutoFader vertical={!rows} store={store} engine={engine} label={`${track.name} volume. How loud this track is.`} value={track.volume} spec={{ trackId: track.id, target: 'volume', param: 'volume', min: 0, max: 1.25 }} />
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
        <StripName name="Master" narrow={narrow} />
        <ChannelAutomation store={store} trackId="master" />
        <button id="master-open" className="text-btn master-open" aria-label="Master. Loudness, tone, and the limiter." title="Loudness, tone, and the limiter." onClick={() => setMasterOpen(true)}>
          <span className="master-full">Master</span>
          <span className="master-stack">
            <span className="master-short">Mst</span>
            <small className="mode-caption">Master</small>
          </span>
        </button>
        {compact ? (
          <button type="button" className="mini fx-open" aria-label="Master effects. Inserts on the master bus." title="Master inserts." onClick={() => setFxTrack('master')}>FX</button>
        ) : null}
        {narrow ? (
          <LevelButton engine={engine} onOpen={() => setLevelsOpen(true)} />
        ) : (
          <MasterReadout engine={engine} />
        )}
        <div className="fader-row">
          <Meter engine={engine} id="master" />
          <TouchSlider
            vertical={!rows}
            label="Master volume. How loud the whole mix is."
            title="How loud the whole mix is."
            min={0}
            max={1.25}
            step={0.01}
            value={project.masterVolume}
            fallback={0.9}
            onStart={() => store.beginAutomationTouch()}
            onCommit={() => store.endAutomationTouch()}
            onChange={(value) => store.setMasterVolume(value)}
          />
        </div>
      </div>
      </div>
      )}
    </div>
    {masterOpen && <MasterSheet store={store} engine={engine} onClose={() => setMasterOpen(false)} />}
    </>
  )
}

function StripName({ name, narrow, color }: { name: string; narrow: boolean; color?: string }) {
  const timer = useRef(0)
  const shown = narrow && name === 'Master' ? 'Mst' : name
  const hold = (event: ReactPointerEvent<HTMLHeadingElement>) => {
    const point = { x: event.clientX, y: event.clientY }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => showHint(name, point.x, point.y), 520)
  }
  const cancel = () => window.clearTimeout(timer.current)
  return (
    <h3
      className="strip-name"
      style={color ? { color } : undefined}
      title={name}
      onPointerDown={hold}
      onPointerUp={cancel}
      onPointerCancel={cancel}
      onPointerLeave={cancel}
    >
      <span className="strip-title">{shown}</span>
      {narrow && name === 'Master' ? <small className="mode-caption">Master</small> : null}
    </h3>
  )
}

function StripSlots({
  store,
  engine,
  trackId,
  onBack,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string | 'master'
  onBack: () => void
}) {
  const name = trackId === 'master' ? 'Master' : store.track(trackId)?.name ?? 'Channel'
  return (
    <div className="strip-slots" aria-label={`${name} inserts and sends`}>
      <button type="button" onClick={onBack} aria-label={`Back to ${name}. Close inserts and sends.`}>Back</button>
      <h3>{name}</h3>
      {trackId !== 'master' && <RouteFields store={store} trackId={trackId} />}
      {trackId !== 'master' && <LinkGroup store={store} trackId={trackId} />}
      <InsertList store={store} trackId={trackId} roomy />
      {trackId !== 'master' && <SendList store={store} trackId={trackId} engine={engine} roomy />}
    </div>
  )
}

function useMasterText(engine: AudioEngine) {
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
  return text
}

function LevelButton({ engine, onOpen }: { engine: AudioEngine; onOpen: () => void }) {
  const text = useMasterText(engine)
  const detail = `LUFS ${text.lufs}. Integrated ${text.integrated}. Peak ${text.peak} dB. CPU ${text.cpu} percent.`
  return (
    <button type="button" className="mini lvl-open" aria-label={`Master levels. ${detail}`} title={detail} onClick={onOpen}>
      <span className="lvl-mark">Lvl</span>
      <small className="mode-caption">Level</small>
    </button>
  )
}

function LevelBar({ engine, onClose }: { engine: AudioEngine; onClose: () => void }) {
  const text = useMasterText(engine)
  return (
    <div className="level-bar" id="master-meters" aria-label="Master levels">
      <span>LUFS <b>{text.lufs}</b></span>
      <span title="Integrated loudness">Integrated <b>{text.integrated}</b></span>
      <span>Peak <b>{text.peak} dB</b></span>
      <span>CPU <b>{text.cpu}%</b></span>
      <button type="button" onClick={onClose} aria-label="Hide master levels">Hide</button>
    </div>
  )
}

function MasterReadout({ engine }: { engine: AudioEngine }) {
  const text = useMasterText(engine)
  return (
    <div className="master-read" id="master-meters">
      <span title="Short-term loudness">LUFS <b>{text.lufs}</b></span>
      <span title="Integrated loudness">I <b>{text.integrated}</b></span>
      <span title="True peak">TP <b>{text.peak}</b></span>
      <span>CPU <b>{text.cpu}%</b></span>
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

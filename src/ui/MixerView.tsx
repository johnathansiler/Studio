import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip, isNarrowStrip, mixerFlow } from '../model/layoutWidth'
import { gainToDb } from '../model/time'
import { mixGroupsOf, selectMixer, trackGroupId } from '../state/select'
import type { ProjectStore } from '../state/store'
import { AddTrackButton } from './AddTrack'
import { AutoFader, ChannelAutomation, LinkGroup, MixFlags, PanKnob } from './AutomationLane'
import { GuideLayer } from './GuideLayer'
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
          {rows ? (
            <>
              <div className="strip-top">
                <StripName name={track.name} color={track.color} />
                <MixFlags store={store} trackId={track.id} part="hear" />
              </div>
              <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical={false} />
              <div className="strip-extra">
                <ChannelAutomation store={store} trackId={track.id} />
                <RouteButton store={store} trackId={track.id} />
                <FxButton name={track.name} onOpen={() => setFxTrack(track.id)} />
                <PanKnob store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} />
                <MixFlags store={store} trackId={track.id} part="extra" />
                {track.type === 'audio' && onTune && <TuneButton name={track.name} onTune={() => onTune(track.id)} />}
              </div>
            </>
          ) : (
            <>
              <StripName name={track.name} color={track.color} />
              <div className="strip-tools">
                <ChannelAutomation store={store} trackId={track.id} />
                <RouteButton store={store} trackId={track.id} />
                <FxButton name={track.name} onOpen={() => setFxTrack(track.id)} />
                <PanKnob store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} />
                <MixFlags store={store} trackId={track.id} part="extra" />
                {track.type === 'audio' && onTune && <TuneButton name={track.name} onTune={() => onTune(track.id)} />}
              </div>
              <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical />
              <div className="strip-hear">
                <MixFlags store={store} trackId={track.id} part="hear" />
              </div>
            </>
          )}
        </div>
      ))}
      <AddTrackButton store={store} />
      <div className="strip master">
        {rows ? (
          <>
            <div className="strip-top">
              <StripName name="Master" />
            </div>
            <MasterLane store={store} engine={engine} value={project.masterVolume} vertical={false} />
            <div className="strip-extra">
              <ChannelAutomation store={store} trackId="master" />
              <MasterOpen onOpen={() => setMasterOpen(true)} />
              <FxButton name="Master" master onOpen={() => setFxTrack('master')} />
              <LevelButton engine={engine} onOpen={() => setLevelsOpen(true)} />
            </div>
          </>
        ) : (
          <>
            <StripName name="Master" />
            <div className="strip-tools">
              <ChannelAutomation store={store} trackId="master" />
              <MasterOpen onOpen={() => setMasterOpen(true)} />
              <FxButton name="Master" master onOpen={() => setFxTrack('master')} />
              <LevelButton engine={engine} onOpen={() => setLevelsOpen(true)} />
            </div>
            {!narrow && <MasterReadout engine={engine} />}
            <MasterLane store={store} engine={engine} value={project.masterVolume} vertical />
          </>
        )}
      </div>
      </div>
      )}
    </div>
    {masterOpen && <MasterSheet store={store} engine={engine} onClose={() => setMasterOpen(false)} />}
    </>
  )
}

function FxButton({ name, master = false, onOpen }: { name: string; master?: boolean; onOpen: () => void }) {
  const label = master ? 'Master effects. Inserts on the master bus.' : `${name} effects. Inserts and sends.`
  return (
    <button type="button" className="mini fx-open" aria-label={label} title={master ? 'Master inserts.' : 'Inserts and sends.'} onClick={(event) => { event.stopPropagation(); onOpen() }}>
      <span className="mini-word">Inserts</span>
    </button>
  )
}

function TuneButton({ name, onTune }: { name: string; onTune: () => void }) {
  return (
    <button type="button" className="mini tune-btn" aria-label={`Tune ${name}. Check the pitch of this input.`} title="Check the pitch of this input." onClick={(event) => { event.stopPropagation(); onTune() }}>
      <span className="mini-word">Tune</span>
    </button>
  )
}

function MasterOpen({ onOpen }: { onOpen: () => void }) {
  return (
    <button id="master-open" className="text-btn master-open" aria-label="Master. Loudness, tone, and the limiter." title="Loudness, tone, and the limiter." onClick={(event) => { event.stopPropagation(); onOpen() }}>
      <span className="master-full">Master</span>
    </button>
  )
}

function VolumeLane({
  store,
  engine,
  trackId,
  name,
  value,
  vertical,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  name: string
  value: number
  vertical: boolean
}) {
  return (
    <div className="fader-row volume-row">
      <Meter engine={engine} id={trackId} />
      <AutoFader
        className="volume"
        readout
        vertical={vertical}
        store={store}
        engine={engine}
        label={`${name} volume. How loud this track is.`}
        value={value}
        spec={{ trackId, target: 'volume', param: 'volume', min: 0, max: 1.25 }}
      />
    </div>
  )
}

function MasterLane({ store, engine, value, vertical }: { store: ProjectStore; engine: AudioEngine; value: number; vertical: boolean }) {
  const db = gainToDb(value)
  return (
    <div className="fader-row volume-row">
      <Meter engine={engine} id="master" />
      <TouchSlider
        className="volume"
        vertical={vertical}
        label="Master volume. How loud the whole mix is."
        title="How loud the whole mix is."
        min={0}
        max={1.25}
        step={0.01}
        value={value}
        fallback={0.9}
        format={gainToDb}
        matchLength
        valueText={db}
        onStart={() => store.beginAutomationTouch()}
        onCommit={() => store.endAutomationTouch()}
        onChange={(next) => store.setMasterVolume(next)}
      />
      <span className="fader-db">{db}</span>
    </div>
  )
}

function RouteButton({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const [open, setOpen] = useState(false)
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const outputLabel = !track.output
    ? (track.input.startsWith('remote:') ? 'Cue' : 'Master')
    : targets.find((item) => item.id === track.output)?.name ?? 'Master'
  const groupLabel = targets.find((item) => item.type === 'group' && item.id === track.groupId)?.name ?? 'No group'
  const linkLabel = mixGroupsOf(store.project).find((item) => item.id === trackGroupId(store.project, trackId))?.name ?? 'No link'
  return (
    <>
      <button
        type="button"
        className="mini route-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Routing. Output ${outputLabel}. Group ${groupLabel}. Link ${linkLabel}.`}
        title={`Output ${outputLabel}. Group ${groupLabel}. Link ${linkLabel}.`}
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
      >
        <span className="mini-word">{outputLabel}</span>
      </button>
      {open && (
        <GuideLayer>
          <button type="button" className="guide-scrim picker-scrim" aria-label={`Close ${track.name} routing`} onClick={() => setOpen(false)} />
          <div className="guide-sheet sheet route-sheet" role="dialog" aria-label={`${track.name} routing`} onPointerDown={(event) => event.stopPropagation()}>
            <div className="guide-handle" aria-hidden="true" />
            <header className="guide-head">
              <div>
                <h2>Routing</h2>
                <p>Output, group, and link for {track.name}.</p>
              </div>
              <button type="button" className="guide-x" aria-label={`Close ${track.name} routing`} onClick={() => setOpen(false)}>Close</button>
            </header>
            <RouteFields store={store} trackId={trackId} />
            <LinkGroup store={store} trackId={trackId} />
          </div>
        </GuideLayer>
      )}
    </>
  )
}

function StripName({ name, color }: { name: string; color?: string }) {
  const timer = useRef(0)
  const shown = name
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
      <span className="lvl-word">Level</span>
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

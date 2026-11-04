import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip, isNarrowStrip } from '../model/layoutWidth'
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
import { meterFill } from './levels'
import { TrackPresence } from './presenceMarks'
import { SecondaryRack, type SecondaryItem } from './SecondaryRack'

export function MixerView({ store, engine, onTune, onOpenKeyboard }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void; onOpenKeyboard?: (trackId: string) => void }) {
  return <MixerBody key={store.project.id} store={store} engine={engine} onTune={onTune} onOpenKeyboard={onOpenKeyboard} />
}

function readViewport() {
  if (typeof window === 'undefined') return { width: 1280, height: 800 }
  return { width: window.innerWidth, height: window.innerHeight }
}

function MixerBody({ store, engine, onTune, onOpenKeyboard }: { store: ProjectStore; engine: AudioEngine; onTune?: (trackId: string) => void; onOpenKeyboard?: (trackId: string) => void }) {
  const project = selectMixer(store).project
  const { layout, setStrip, resetStrip } = useLayoutWidths(project.id)
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
  const flow = 'columns' as const
  const narrow = isNarrowStrip(strip)
  const rows = false
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
      <WidthBar axis="strip" value={layout.strip} onChange={setStrip} onReset={resetStrip} />
      {levelsOpen && <LevelBar engine={engine} onClose={() => setLevelsOpen(false)} />}
      {fxTrack ? (
        <StripSlots store={store} engine={engine} trackId={fxTrack} onBack={() => setFxTrack(null)} />
      ) : (
      <div className="mixer">
      {project.tracks.map((track) => (
        <ChannelStrip
          key={track.id}
          store={store}
          engine={engine}
          trackId={track.id}
          rows={rows}
          selected={store.selectedTrackId === track.id}
          onTune={onTune}
          onOpenKeyboard={onOpenKeyboard}
          onFx={() => setFxTrack(track.id)}
        />
      ))}
      <AddTrackButton store={store} />
      <MasterStrip
        store={store}
        engine={engine}
        rows={rows}
        narrow={narrow}
        onOpen={() => setMasterOpen(true)}
        onFx={() => setFxTrack('master')}
        onLevels={() => setLevelsOpen(true)}
      />
      </div>
      )}
    </div>
    {masterOpen && <MasterSheet store={store} engine={engine} onClose={() => setMasterOpen(false)} />}
    </>
  )
}

function routingCaption(store: ProjectStore, trackId: string) {
  const track = store.track(trackId)
  if (!track) return 'Master'
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  if (!track.output) return track.input.startsWith('remote:') ? 'Cue' : 'Master'
  return targets.find((item) => item.id === track.output)?.name ?? 'Master'
}

function ChannelStrip({
  store,
  engine,
  trackId,
  rows,
  selected,
  onTune,
  onOpenKeyboard,
  onFx,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  rows: boolean
  selected: boolean
  onTune?: (trackId: string) => void
  onOpenKeyboard?: (trackId: string) => void
  onFx: () => void
}) {
  const track = store.track(trackId)
  if (!track) return null
  const output = routingCaption(store, trackId)
  const tools: SecondaryItem[] = [
    { id: 'automation', label: 'Touch', node: <ChannelAutomation store={store} trackId={track.id} /> },
    { id: 'routing', label: output, node: <RouteButton store={store} trackId={track.id} /> },
    { id: 'inserts', label: 'Inserts', node: <FxButton name={track.name} onOpen={onFx} /> },
    { id: 'pan', label: 'Pan', width: 40, node: <PanKnob store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} /> },
    { id: 'arm', label: 'Arm', node: <MixFlags store={store} trackId={track.id} part="arm" /> },
    { id: 'safe', label: 'Safe', node: <MixFlags store={store} trackId={track.id} part="safe" /> },
  ]
  if (track.type === 'audio' && onTune) {
    tools.push({ id: 'tune', label: 'Tune', node: <TuneButton name={track.name} onTune={() => onTune(track.id)} /> })
  }
  const hear: SecondaryItem[] = [
    { id: 'mute', label: 'Mute', node: <MixFlags store={store} trackId={track.id} part="mute" /> },
    { id: 'solo', label: 'Solo', node: <MixFlags store={store} trackId={track.id} part="solo" /> },
  ]
  return (
    <div className={`strip${selected ? ' is-selected' : ''}`} data-track={track.id} onClick={() => { store.selectTrack(track.id); onOpenKeyboard?.(track.id) }}>
      {rows ? (
        <>
          <div className="strip-top">
            <StripName name={track.name} color={track.color} />
            <TrackPresence trackId={track.id} />
            <SecondaryRack zone="top" className="strip-hear" items={hear} />
          </div>
          <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical={false} />
          <SecondaryRack zone="tools" className="strip-extra" items={tools} />
        </>
      ) : (
        <>
          <StripName name={track.name} color={track.color} />
          <TrackPresence trackId={track.id} />
          <SecondaryRack zone="tools" className="strip-tools" items={tools} />
          <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical />
          <SecondaryRack zone="hear" className="strip-hear" items={hear} />
        </>
      )}
    </div>
  )
}

function MasterStrip({
  store,
  engine,
  rows,
  narrow,
  onOpen,
  onFx,
  onLevels,
}: {
  store: ProjectStore
  engine: AudioEngine
  rows: boolean
  narrow: boolean
  onOpen: () => void
  onFx: () => void
  onLevels: () => void
}) {
  const tools: SecondaryItem[] = [
    { id: 'automation', label: 'Touch', node: <ChannelAutomation store={store} trackId="master" /> },
    { id: 'master', label: 'Master', node: <MasterOpen onOpen={onOpen} /> },
    { id: 'inserts', label: 'Inserts', node: <FxButton name="Master" master onOpen={onFx} /> },
    { id: 'level', label: 'Level', node: <LevelButton engine={engine} onOpen={onLevels} /> },
  ]
  return (
    <div className="strip master">
      {rows ? (
        <>
          <div className="strip-top">
            <StripName name="Master" />
          </div>
          <MasterLane store={store} engine={engine} value={store.project.masterVolume} vertical={false} />
          <SecondaryRack zone="tools" className="strip-extra" items={tools} />
        </>
      ) : (
        <>
          <StripName name="Master" />
          <SecondaryRack zone="tools" className="strip-tools" items={tools} />
          {!narrow && <MasterReadout engine={engine} />}
          <MasterLane store={store} engine={engine} value={store.project.masterVolume} vertical />
        </>
      )}
    </div>
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
  const outputLabel = routingCaption(store, trackId)
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
      const value = meterFill(id === 'master' ? levels.master : levels.tracks[id] || 0)
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

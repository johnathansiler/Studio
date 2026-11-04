import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip, isNarrowStrip } from '../model/layoutWidth'
import { gainToDb } from '../model/time'
import { mixGroupsOf, selectMixer, trackGroupId } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { Track } from '../model/types'
import { AddTrackButton } from './AddTrack'
import { AutoFader, ChannelAutomation, MixFlags, PanKnob } from './AutomationLane'
import { showHint } from './Hint'
import { useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'
import { MasterSheet } from './MasterSheet'
import { InsertList } from './PluginSheet'
import { TouchSlider } from './kit/controls'
import { holdMeter } from './levels'
import { TrackPresence } from './presenceMarks'
import { useScreenOverlay } from './screenOverlay'
import './mixer.css'

/** Full-screen channel sheet. A view tab closes it with the other overlays. */
function useMixSheet(open: boolean, close: () => void) {
  useScreenOverlay(close, open)
}

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
  const [viewport, setViewport] = useState(readViewport)
  useEffect(() => {
    const apply = () => setViewport(readViewport())
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])
  const strip = displayedStrip(layout.strip, viewport.width)
  const narrow = isNarrowStrip(strip)
  const short = viewport.height < 500 && viewport.width > viewport.height
  const channels = project.tracks.filter((track) => track.type !== 'bus' && track.type !== 'group')
  const buses = project.tracks.filter((track) => track.type === 'bus' || track.type === 'group')
  const flow = buses.length
    ? 'Tracks feed buses. Buses feed the master.'
    : 'Tracks feed the master. A bus sums tracks before it.'
  return (
    <div
      className="mixer-view mixer-console"
      ref={areaRef}
      data-strip-width={strip}
      data-layout="columns"
      data-narrow={narrow ? '1' : undefined}
      data-short={short ? '1' : undefined}
      style={{ ['--strip' as string]: `${strip}px` }}
    >
      <WidthBar axis="strip" value={layout.strip} onChange={setStrip} onReset={resetStrip} />
      <p className="mix-flow" aria-label={`Signal flow. ${flow}`}>{flow}</p>
      <div className="mixer-bay">
        <div className="mixer">
          {channels.map((track) => (
            <ChannelStrip
              key={track.id}
              store={store}
              engine={engine}
              trackId={track.id}
              flow="track"
              selected={store.selectedTrackId === track.id}
              onTune={onTune}
              onOpenKeyboard={onOpenKeyboard}
            />
          ))}
          <AddTrackButton store={store} />
          {buses.map((track) => (
            <ChannelStrip
              key={track.id}
              store={store}
              engine={engine}
              trackId={track.id}
              flow="bus"
              selected={store.selectedTrackId === track.id}
              onTune={onTune}
              onOpenKeyboard={onOpenKeyboard}
            />
          ))}
        </div>
        <div className="mix-divider" aria-hidden="true" />
        <MasterStrip store={store} engine={engine} />
      </div>
    </div>
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
  flow,
  selected,
  onTune,
  onOpenKeyboard,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  flow: 'track' | 'bus'
  selected: boolean
  onTune?: (trackId: string) => void
  onOpenKeyboard?: (trackId: string) => void
}) {
  const track = store.track(trackId)
  if (!track) return null
  const output = routingCaption(store, trackId)
  const kind = flow === 'bus' ? 'Bus' : 'Track'
  return (
    <div
      className={`strip${selected ? ' is-selected' : ''}${flow === 'bus' ? ' is-bus' : ''}`}
      data-track={track.id}
      data-flow={flow}
      onClick={() => { store.selectTrack(track.id); onOpenKeyboard?.(track.id) }}
    >
      <div className="strip-col">
        <div className="strip-head">
          <p className="strip-kind">{kind}</p>
          <StripName name={track.name} color={track.color} />
          <p className="strip-path" title={`${kind} ${track.name} feeds ${output}.`}>To {output}</p>
          <TrackPresence trackId={track.id} />
        </div>
        <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical />
        <div className="strip-foot">
          <MixFlags store={store} trackId={track.id} part="mute" />
          <MixFlags store={store} trackId={track.id} part="solo" />
          <ChannelMore store={store} engine={engine} track={track} output={output} onTune={onTune} />
        </div>
      </div>
    </div>
  )
}

function MasterStrip({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  return (
    <div className="strip master" data-flow="master">
      <div className="strip-col">
        <div className="strip-head">
          <p className="strip-kind">Master</p>
          <StripName name="Master" />
          <p className="strip-path" title="Tracks and buses arrive here, then leave to the speakers.">Output</p>
        </div>
        <MasterLane store={store} engine={engine} value={store.project.masterVolume} vertical />
        <div className="strip-foot">
          <div className="strip-note" title="Tracks and buses arrive on the master."><span>Arrives</span></div>
          <div className="strip-note" title="The mix leaves through the speakers."><span>Leaves</span></div>
          <MasterMore store={store} engine={engine} />
        </div>
      </div>
    </div>
  )
}

function ChannelMore({
  store,
  engine,
  track,
  output,
  onTune,
}: {
  store: ProjectStore
  engine: AudioEngine
  track: Track
  output: string
  onTune?: (trackId: string) => void
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useMixSheet(open, () => {
    if (detailsRef.current) detailsRef.current.open = false
    setOpen(false)
  })
  return (
    <details
      ref={detailsRef}
      className="mix-more"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="more-open" aria-label={`More. Inserts, sends, pan, phase, and routing for ${track.name}.`} title="Inserts, sends, pan, phase, and routing.">
        <span className="more-closed">More</span>
        <span className="more-open-word">Close</span>
      </summary>
      <div className="mix-panel" aria-label={`${track.name} channel`}>
        <button type="button" className="overlay-close" onClick={() => { if (detailsRef.current) detailsRef.current.open = false }}>Close</button>
        <section className="mix-block">
          <h4>Automation</h4>
          <p>Off ignores lanes. Read plays them. Touch and Latch write while you move a control.</p>
          <ChannelAutomation store={store} trackId={track.id} />
        </section>
        <section className="mix-block">
          <h4>Pan</h4>
          <p>Place this channel left or right.</p>
          <PanKnob store={store} engine={engine} label={`${track.name} pan. Left or right.`} value={track.pan} spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }} />
        </section>
        <section className="mix-block">
          <h4>Phase</h4>
          <p>Sweep this channel with a phase effect.</p>
          <PhaseButton store={store} trackId={track.id} name={track.name} />
        </section>
        <section className="mix-block">
          <h4>Record</h4>
          <p>Arm records on this channel. Safe stays audible when other channels are soloed.</p>
          <div className="mix-pair">
            <MixFlags store={store} trackId={track.id} part="arm" />
            <MixFlags store={store} trackId={track.id} part="safe" />
          </div>
          {track.type === 'audio' && onTune && <TuneButton name={track.name} onTune={() => onTune(track.id)} />}
        </section>
        <section className="mix-block">
          <h4>Inserts</h4>
          <p>Instruments and effects on this channel, in order.</p>
          <FxButton name={track.name} />
          <InsertList store={store} trackId={track.id} roomy />
        </section>
        <section className="mix-block">
          <h4>Sends</h4>
          <p>A copy of this channel, sent to a bus.</p>
          <SendRows store={store} engine={engine} trackId={track.id} />
        </section>
        <section className="mix-block">
          <h4>Routing</h4>
          <p>Output {output}. Choose where this channel goes next, and which channels move together.</p>
          <RoutePicks store={store} trackId={track.id} />
        </section>
      </div>
    </details>
  )
}

function MasterMore({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const [mastering, setMastering] = useState(false)
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useMixSheet(open, () => {
    if (detailsRef.current) detailsRef.current.open = false
    setOpen(false)
  })
  return (
    <details
      ref={detailsRef}
      className="mix-more"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="more-open" aria-label="More. Levels, inserts, and mastering for the master." title="Levels, inserts, and mastering.">
        <span className="more-closed">More</span>
        <span className="more-open-word">Close</span>
      </summary>
      <div className="mix-panel" aria-label="Master channel">
        <button type="button" className="overlay-close" onClick={() => { if (detailsRef.current) detailsRef.current.open = false }}>Close</button>
        <section className="mix-block">
          <h4>Automation</h4>
          <p>Off ignores lanes. Read plays them. Touch and Latch write while you move a control.</p>
          <ChannelAutomation store={store} trackId="master" />
        </section>
        <section className="mix-block">
          <h4>Levels</h4>
          <p>Loudness and the highest peak on the master.</p>
          <LevelReadout engine={engine} />
        </section>
        <section className="mix-block">
          <h4>Inserts</h4>
          <p>Effects on the master bus, in order.</p>
          <FxButton name="Master" master />
          <InsertList store={store} trackId="master" roomy />
        </section>
        <section className="mix-block">
          <h4>Mastering</h4>
          <p>Loudness, tone, and the limiter.</p>
          <button
            id="master-open"
            type="button"
            className="text-btn master-open"
            aria-expanded={mastering}
            aria-label="Master. Loudness, tone, and the limiter."
            title="Loudness, tone, and the limiter."
            onClick={() => setMastering((open) => !open)}
          >
            <span className="master-full">{mastering ? 'Close' : 'Master'}</span>
          </button>
          {mastering && <MasterSheet store={store} engine={engine} onClose={() => setMastering(false)} />}
        </section>
      </div>
    </details>
  )
}

function FxButton({ name, master = false }: { name: string; master?: boolean }) {
  const label = master ? 'Master effects. Inserts on the master bus.' : `${name} effects. Inserts and sends.`
  return (
    <button type="button" className="mini fx-open" aria-label={label} title={master ? 'Master inserts.' : 'Inserts and sends.'}>
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

function PhaseButton({ store, trackId, name }: { store: ProjectStore; trackId: string; name: string }) {
  const plugin = store.track(trackId)?.plugins.find((item) => item.pluginId === 'phase')
  return (
    <button
      type="button"
      className="mini phase-btn"
      aria-label={plugin ? `Phase. Open the phase effect on ${name}.` : `Phase. Add a phase effect on ${name}.`}
      title={plugin ? 'Open the phase effect.' : 'Add a phase effect.'}
      onClick={(event) => {
        event.stopPropagation()
        if (plugin) store.focusPlugin(trackId, plugin.id)
        else store.addPlugin(trackId, 'phase')
      }}
    >
      <span className="mini-word">Phase</span>
    </button>
  )
}

const VOLUME_SPAN = 1.25
const FADER_MARKS = [
  { label: '0', gain: 1 },
  { label: '-6', gain: 0.5 },
  { label: '-12', gain: 0.25 },
  { label: '-18', gain: 0.125 },
]

function FaderScale() {
  return (
    <ol className="fader-scale" aria-hidden="true">
      {FADER_MARKS.map((mark) => (
        <li key={mark.label} style={{ bottom: `${(mark.gain / VOLUME_SPAN) * 100}%` }}>{mark.label}</li>
      ))}
    </ol>
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
      <FaderScale />
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
      <FaderScale />
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

function SendRows({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const buses = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== trackId)
  const used = new Set(track.sends.map((send) => send.busId))
  const open = buses.filter((bus) => !used.has(bus.id))
  return (
    <div className="sends">
      {track.sends.map((send) => {
        const busName = buses.find((bus) => bus.id === send.busId)?.name ?? 'Send'
        return (
          <div className="send-row" key={send.id}>
            <span>{busName}</span>
            <small>{send.preFader ? 'Before the fader.' : 'After the fader.'}</small>
            <TouchSlider
              label={`${busName} send level. How much of this channel goes to the bus.`}
              title="Send level. Latch and touch write this while playing."
              min={0}
              max={1}
              step={0.01}
              value={send.gain}
              fallback={0.25}
              onStart={() => store.beginAutomationTouch()}
              onCommit={() => store.endAutomationTouch()}
              onChange={(value) => {
                const rolling = engine.status === 'playing' || engine.status === 'recording'
                store.setAutomated(
                  { trackId, target: 'send', param: 'gain', sendId: send.id, min: 0, max: 1 },
                  value,
                  rolling,
                  engine.currentTimelineSample(),
                )
              }}
            />
            <div className="mix-pair">
              <button
                type="button"
                className={`mini ${send.preFader ? 'on' : ''}`}
                aria-pressed={send.preFader}
                aria-label={send.preFader ? 'Before. This send ignores the fader.' : 'After. This send follows the fader.'}
                title={send.preFader ? 'This send ignores the fader.' : 'This send follows the fader.'}
                onClick={() => store.updateSend(trackId, send.id, { preFader: !send.preFader })}
              >
                <span className="mini-word">{send.preFader ? 'Before' : 'After'}</span>
              </button>
              <button type="button" className="mini" aria-label={`Remove the send to ${busName}.`} title="Take this send away." onClick={() => store.removeSend(trackId, send.id)}>
                <span className="mini-word">Remove</span>
              </button>
            </div>
          </div>
        )
      })}
      {open.map((bus) => (
        <button key={bus.id} type="button" className="mini send-add" aria-label={`Send. Add a send to ${bus.name}.`} title={`Add a send to ${bus.name}.`} onClick={() => store.addSend(trackId, bus.id)}>
          <span className="mini-word">Send</span>
          <small>Add a send to {bus.name}.</small>
        </button>
      ))}
      {buses.length === 0 && <p className="mix-empty">No bus yet. Add a bus, then send this channel to it.</p>}
    </div>
  )
}

function RoutePicks({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const groups = targets.filter((item) => item.type === 'group')
  const output = !track.output ? (track.input.startsWith('remote:') ? 'Cue' : 'Master') : targets.find((item) => item.id === track.output)?.name ?? 'Master'
  const groupLabel = groups.find((item) => item.id === track.groupId)?.name ?? 'No group'
  const links = mixGroupsOf(store.project)
  const linkId = trackGroupId(store.project, trackId) ?? ''
  const link = links.find((item) => item.id === linkId)
  return (
    <div className="route-fields">
      <InlinePick
        label="Output"
        hint="Where this channel goes next."
        value={track.output ?? ''}
        options={[
          { value: '', label: track.input.startsWith('remote:') ? 'Cue' : 'Master' },
          ...targets.map((item) => ({ value: item.id, label: item.name })),
        ]}
        onChange={(next) => store.updateTrack(track.id, { output: next || null })}
      />
      <p className="mix-current">Now {output}.</p>
      <InlinePick
        label="Group"
        hint="A folder that sums this channel."
        value={track.groupId ?? ''}
        options={[{ value: '', label: 'No group' }, ...groups.map((item) => ({ value: item.id, label: item.name }))]}
        onChange={(next) => store.updateTrack(track.id, { groupId: next || null })}
      />
      <p className="mix-current">Now {groupLabel}.</p>
      <InlinePick
        label="Link"
        hint="Channels that move together."
        value={linkId}
        options={[
          { value: '', label: 'No link' },
          ...links.map((item) => ({ value: item.id, label: item.name })),
          { value: 'new', label: 'New link' },
        ]}
        onChange={(next) => store.assignMixGroup(trackId, next)}
      />
      {link && (
        <div className="link-row">
          <Flag store={store} groupId={link.id} on={link.faders} flag="faders" label="Faders" title="Move faders and pans by the same amount." />
          <Flag store={store} groupId={link.id} on={link.mutes} flag="mutes" label="Mutes" title="Mute and unmute the linked tracks together." />
          <Flag store={store} groupId={link.id} on={link.solos} flag="solos" label="Solos" title="Solo and unsolo the linked tracks together." />
          <Flag store={store} groupId={link.id} on={link.edits} flag="edits" label="Edits" title="Move, trim, and split overlapping clips together." />
        </div>
      )}
    </div>
  )
}

function Flag({ store, groupId, on, flag, label, title }: { store: ProjectStore; groupId: string; on: boolean; flag: 'faders' | 'mutes' | 'solos' | 'edits'; label: string; title: string }) {
  return (
    <button type="button" className={on ? 'on' : ''} aria-pressed={on} aria-label={`${label}. ${title}`} title={title} onClick={() => store.setMixLink(groupId, { [flag]: !on })}>
      {label}
    </button>
  )
}

function InlinePick({
  label,
  hint,
  value,
  options,
  onChange,
}: {
  label: string
  hint: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const current = options.find((item) => item.value === value)?.label ?? value
  return (
    <div className={`inline-pick${open ? ' open' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${label}. ${current}. ${hint}`}
        title={hint}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((shown) => !shown)
        }}
      >
        <span>{label}</span>
        <small>{current}. {hint}</small>
      </button>
      {open && (
        <div role="group" aria-label={label}>
          {options.map((item) => (
            <button
              key={item.value || 'none'}
              type="button"
              aria-pressed={item.value === value}
              onClick={(event) => {
                event.stopPropagation()
                onChange(item.value)
                setOpen(false)
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function StripName({ name, color }: { name: string; color?: string }) {
  const timer = useRef(0)
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
      <span className="strip-title">{name}</span>
    </h3>
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

function LevelReadout({ engine }: { engine: AudioEngine }) {
  const text = useMasterText(engine)
  return (
    <div className="level-read" id="master-meters" aria-label="Master levels">
      <p><span>Short-term</span> <b>{text.lufs}</b> <small>Loudness right now, in LUFS.</small></p>
      <p><span>Integrated</span> <b>{text.integrated}</b> <small>Loudness of the whole play.</small></p>
      <p><span>Peak</span> <b>{text.peak} dB</b> <small>Highest true peak.</small></p>
      <p><span>Processor</span> <b>{text.cpu}%</b> <small>How hard the mix is working.</small></p>
    </div>
  )
}

function Meter({ engine, id }: { engine: AudioEngine; id: string }) {
  const [level, setLevel] = useState(0)
  useEffect(() => {
    let frame = 0
    const hold = { value: 0, at: 0 }
    let painted = 0
    const tick = (now: number) => {
      const levels = engine.levels()
      const raw = id === 'master' ? levels.master : (levels.tracks[id] || 0)
      const shown = holdMeter(hold, raw, now)
      if (Math.abs(painted - shown) >= 0.015) {
        painted = shown
        setLevel(shown)
      }
      frame = window.requestAnimationFrame(tick)
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [engine, id])
  return (
    <div className="meter" aria-hidden="true">
      <b style={{ height: `${level * 100}%` }} />
    </div>
  )
}

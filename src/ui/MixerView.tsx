import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import type { AudioEngine } from '../audio/engine'
import { STRIP_BOUNDS, displayedStrip, isNarrowStrip } from '../model/layoutWidth'
import { gainToDb } from '../model/time'
import { mixGroupsOf, selectMixer, trackGroupId } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { Track } from '../model/types'
import { AddTrackButton } from './AddTrack'
import { AutoFader, ChannelAutomation, MixFlags, PanKnob, panWords } from './AutomationLane'
import { useLayoutWidths, usePinchResize, WidthBar } from './layoutWidth'
import { MasterSheet } from './MasterSheet'
import { InsertList, StripInserts } from './PluginSheet'
import { TouchSlider } from './kit/controls'
import { holdMeter } from './levels'
import { TrackPresence } from './presenceMarks'
import { useScreenOverlay } from './screenOverlay'
import { SheetClose } from './SheetClose'
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
  const [masterOn, setMasterOn] = useState(false)
  const focus: string | 'master' = masterOn ? 'master' : (store.selectedTrackId ?? channels[0]?.id ?? 'master')
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const openDetail = (next: string | 'master') => {
    if (next === 'master') setMasterOn(true)
    else {
      setMasterOn(false)
      store.selectTrack(next)
    }
    if (detailsRef.current) detailsRef.current.open = true
  }
  return (
    <div
      className="mixer-view mixer-console"
      ref={areaRef}
      data-strip-width={strip}
      data-layout="columns"
      data-narrow={narrow ? '1' : undefined}
      data-short={short ? '1' : undefined}
      data-insert-order="top-first"
      style={{ ['--strip' as string]: `${strip}px` }}
    >
      <MixToolbar store={store} engine={engine} focus={focus} detailsRef={detailsRef} onTune={onTune} strip={layout.strip} onStrip={setStrip} onResetStrip={resetStrip} />
      <div className="mixer-bay">
        <div className="mixer">
          {channels.map((track) => (
            <ChannelStrip
              key={track.id}
              store={store}
              engine={engine}
              trackId={track.id}
              flow="track"
              column={insertColumn(strip, viewport.width, short)}
              selected={focus === track.id}
              onOpenKeyboard={onOpenKeyboard}
              onSelect={() => { setMasterOn(false); store.selectTrack(track.id) }}
              onOpen={() => openDetail(track.id)}
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
              column={insertColumn(strip, viewport.width, short)}
              selected={focus === track.id}
              onOpenKeyboard={onOpenKeyboard}
              onSelect={() => { setMasterOn(false); store.selectTrack(track.id) }}
              onOpen={() => openDetail(track.id)}
            />
          ))}
        </div>
        <div className="mix-divider" aria-hidden="true" />
        <MasterStrip store={store} engine={engine} column={insertColumn(strip, viewport.width, short)} selected={focus === 'master'} onSelect={() => setMasterOn(true)} onOpen={() => openDetail('master')} />
      </div>
    </div>
  )
}

/** Column width the insert names have to fit. Phone bays share one width across about five strips. */
function insertColumn(strip: number, viewportWidth: number, short: boolean) {
  if (short) return 120
  if (!(viewportWidth > 0) || viewportWidth > 1100) return strip
  const share = Math.max(44, (viewportWidth - 40) / 5)
  return Math.round(Math.min(strip, share))
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
  column,
  selected,
  onOpenKeyboard,
  onSelect,
  onOpen,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  flow: 'track' | 'bus'
  column: number
  selected: boolean
  onOpenKeyboard?: (trackId: string) => void
  onSelect: () => void
  onOpen: () => void
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
      <div className="strip-col" style={{ ['--insert' as string]: track.color }}>
        <div className="strip-head">
          <p className="strip-kind">{kind}</p>
          <StripName name={track.name} color={track.color} onSelect={onSelect} onOpen={onOpen} />
          <p className="strip-path" title={`${kind} ${track.name} feeds ${output}.`}>To {output}</p>
          <TrackPresence trackId={track.id} />
        </div>
        <StripInserts store={store} trackId={track.id} column={column} />
        <StripPan store={store} engine={engine} track={track} />
        <VolumeLane store={store} engine={engine} trackId={track.id} name={track.name} value={track.volume} vertical />
        <div className="strip-foot">
          <MixFlags store={store} trackId={track.id} part="mute" />
          <MixFlags store={store} trackId={track.id} part="solo" />
        </div>
      </div>
    </div>
  )
}

function StripPan({ store, engine, track }: { store: ProjectStore; engine: AudioEngine; track: Track }) {
  const words = panWords(track.pan)
  const side = Math.abs(track.pan) < 0.02 ? 'center' : track.pan < 0 ? 'left' : 'right'
  return (
    <div className="strip-pan" data-pan={side} data-pan-text={words}>
      <PanKnob
        store={store}
        engine={engine}
        label={`${track.name} pan. ${words}. Drag left or right.`}
        value={track.pan}
        spec={{ trackId: track.id, target: 'pan', param: 'pan', min: -1, max: 1 }}
      />
    </div>
  )
}

function MasterStrip({ store, engine, column, selected, onSelect, onOpen }: { store: ProjectStore; engine: AudioEngine; column: number; selected: boolean; onSelect: () => void; onOpen: () => void }) {
  return (
    <div className={`strip master${selected ? ' is-selected' : ''}`} data-flow="master">
      <div className="strip-col">
        <div className="strip-head">
          <p className="strip-kind">Master</p>
          <StripName name="Master" onSelect={onSelect} onOpen={onOpen} />
          <p className="strip-path" title="Tracks and buses arrive here, then leave to the speakers.">Output</p>
        </div>
        <StripInserts store={store} trackId="master" column={column} />
        <MasterLane store={store} engine={engine} value={store.project.masterVolume} vertical />
        <div className="strip-foot">
          <div className="strip-note" title="Tracks and buses arrive on the master."><span>Arrives</span></div>
          <div className="strip-note" title="The mix leaves through the speakers."><span>Leaves</span></div>
        </div>
      </div>
    </div>
  )
}

type MixSection = 'channel' | 'inserts' | 'sends' | 'route'

function MixToolbar({
  store,
  engine,
  focus,
  detailsRef,
  onTune,
  strip,
  onStrip,
  onResetStrip,
}: {
  store: ProjectStore
  engine: AudioEngine
  focus: string | 'master'
  detailsRef: RefObject<HTMLDetailsElement | null>
  onTune?: (trackId: string) => void
  strip: number
  onStrip: (next: number) => void
  onResetStrip: () => void
}) {
  const [open, setOpen] = useState(false)
  const [section, setSection] = useState<MixSection>('channel')
  const [mastering, setMastering] = useState(false)
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const pick = () => {
      const node = document.getElementById('phone-screen-slot')
      setSlot(node instanceof HTMLElement ? node : null)
    }
    pick()
    const observer = new MutationObserver(pick)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
  }, [])
  useMixSheet(open, () => {
    if (detailsRef.current) detailsRef.current.open = false
    setOpen(false)
  })
  const track = focus === 'master' ? null : store.track(focus)
  const name = focus === 'master' ? 'Master' : track?.name ?? 'Channel'
  const sections: { id: MixSection; label: string }[] = focus === 'master'
    ? [
        { id: 'channel', label: 'Channel' },
        { id: 'inserts', label: 'Inserts' },
      ]
    : [
        { id: 'channel', label: 'Channel' },
        { id: 'inserts', label: 'Inserts' },
        { id: 'sends', label: 'Sends' },
        { id: 'route', label: 'Routing' },
      ]
  const shown = sections.some((item) => item.id === section) ? section : 'channel'
  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false
  }
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  useLayoutEffect(() => {
    const root = detailsRef.current
    if (!open || !root) return
    const summary = root.querySelector('summary')
    const panel = root.querySelector('.mix-panel') as HTMLElement | null
    const scrim = root.querySelector('.mix-back') as HTMLElement | null
    if (!summary || !panel) return
    const place = () => {
      const box = summary.getBoundingClientRect()
      const tabs = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--view-tabs-bottom')) || 0
      const phone = document.querySelector('.shell.phone')
      const bar = phone?.querySelector('.tool-slot')?.getBoundingClientRect()
      const transport = phone?.querySelector('.transport')?.getBoundingClientRect()
      const chromeTop = Math.max(
        tabs,
        transport && transport.height > 8 ? transport.bottom : 0,
      )
      const chromeBottom = bar && bar.height > 8 && bar.top < window.innerHeight - 4
        ? Math.max(0, window.innerHeight - bar.top)
        : 0
      const floor = phone ? chromeTop : tabs
      const limit = window.innerHeight - (phone ? chromeBottom : 0)
      const maxH = Math.min(420, Math.max(120, Math.round(limit - floor - 16)))
      const width = Math.min(panel.offsetWidth || 300, window.innerWidth - 16)
      let left = box.left
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width)
      if (phone) {
        const bottom = Math.round(chromeBottom + 8)
        panel.style.top = 'auto'
        panel.style.bottom = `${bottom}px`
        panel.style.maxHeight = `${maxH}px`
        if (scrim) {
          scrim.style.top = `${Math.round(chromeTop)}px`
          scrim.style.bottom = `${Math.round(chromeBottom)}px`
        }
      } else {
        let top = box.bottom + 4
        if (top + 160 > window.innerHeight - 8) top = Math.max(tabs + 4, window.innerHeight - 8 - maxH)
        panel.style.top = `${Math.max(tabs + 4, top)}px`
        panel.style.bottom = 'auto'
        panel.style.maxHeight = `${maxH}px`
        if (scrim) {
          scrim.style.top = ''
          scrim.style.bottom = ''
        }
      }
      panel.style.left = `${left}px`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, shown, focus, detailsRef])
  const toolbar = (
    <>
      <div className="mix-toolbar" role="toolbar" aria-label="Mix">
        <details
          ref={detailsRef}
          className="mix-more"
          data-mix-more=""
          onToggle={(event) => setOpen(event.currentTarget.open)}
        >
          <summary className="mix-toolbar-more more-open" aria-label={`More. Options for ${name}.`} title={`Options for ${name}.`}>
            <span>More</span>
          </summary>
          <div
            className="mix-back"
            onPointerDown={(event) => {
              event.preventDefault()
              event.stopPropagation()
              close()
            }}
          />
          <div
            className="mix-panel"
            role="dialog"
            aria-label={`${name} channel`}
            data-mix-sheet=""
            data-mix-section={shown}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              const button = (event.target as HTMLElement).closest('button')
              if (!button?.closest('.inserts')) return
              if (button.classList.contains('insert-add') || button.classList.contains('plugin-pick')) return
              close()
            }}
          >
            <header className="mix-sheet-head sheet-head">
              <h4>{name}</h4>
              <SheetClose onClick={close} />
            </header>
            <WidthBar axis="strip" value={strip} onChange={onStrip} onReset={onResetStrip} />
            <div className="mix-chips" role="tablist" aria-label="Channel sections">
              {sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={shown === item.id}
                  className={shown === item.id ? 'on' : ''}
                  onClick={() => setSection(item.id)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            {shown === 'channel' && track && (
              <ChannelSection store={store} track={track} onTune={onTune} />
            )}
            {shown === 'channel' && focus === 'master' && (
              <MasterChannel store={store} engine={engine} onMaster={() => { setMastering(true); close() }} />
            )}
            {shown === 'inserts' && (
              <div className="mix-block">
                <InsertList store={store} trackId={focus === 'master' ? 'master' : focus} roomy />
              </div>
            )}
            {shown === 'sends' && focus !== 'master' && <SendRows store={store} engine={engine} trackId={focus} />}
            {shown === 'route' && focus !== 'master' && <RoutePicks store={store} trackId={focus} />}
          </div>
        </details>
        <p className="mix-toolbar-name">{name}</p>
      </div>
      {mastering && <MasterSheet store={store} engine={engine} onClose={() => setMastering(false)} />}
    </>
  )
  if (slot) return createPortal(toolbar, slot)
  return toolbar
}

function ChannelSection({
  store,
  track,
  onTune,
}: {
  store: ProjectStore
  track: Track
  onTune?: (trackId: string) => void
}) {
  return (
    <div className="mix-block">
      <div className="mix-row">
        <span className="mix-label">Automation</span>
        <ChannelAutomation store={store} trackId={track.id} />
      </div>
      <div className="mix-pills">
        <PhaseButton store={store} trackId={track.id} name={track.name} />
        <MixFlags store={store} trackId={track.id} part="arm" />
        <MixFlags store={store} trackId={track.id} part="safe" />
        {track.type === 'audio' && onTune && <TuneButton name={track.name} onTune={() => onTune(track.id)} />}
      </div>
    </div>
  )
}

function MasterChannel({ store, engine, onMaster }: { store: ProjectStore; engine: AudioEngine; onMaster: () => void }) {
  return (
    <div className="mix-block">
      <div className="mix-row">
        <span className="mix-label">Automation</span>
        <ChannelAutomation store={store} trackId="master" />
      </div>
      <LevelReadout engine={engine} />
      <button
        id="master-open"
        type="button"
        className="btn-secondary master-open"
        aria-label="Master. Loudness, tone, and the limiter."
        title="Loudness, tone, and the limiter."
        onClick={onMaster}
      >
        Master
      </button>
    </div>
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
      {open.length > 0 && (
        <MixSelect
          label="Add send"
          value=""
          options={[{ value: '', label: 'Choose' }, ...open.map((bus) => ({ value: bus.id, label: bus.name }))]}
          onChange={(next) => { if (next) store.addSend(trackId, next) }}
        />
      )}
      {buses.length === 0 && <p className="mix-empty">No bus yet.</p>}
    </div>
  )
}

function RoutePicks({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const track = store.track(trackId)
  if (!track) return null
  const targets = store.project.tracks.filter((item) => (item.type === 'bus' || item.type === 'group') && item.id !== track.id)
  const groups = targets.filter((item) => item.type === 'group')
  const links = mixGroupsOf(store.project)
  const linkId = trackGroupId(store.project, trackId) ?? ''
  const link = links.find((item) => item.id === linkId)
  return (
    <div className="route-fields">
      <MixSelect
        label="Output"
        value={track.output ?? ''}
        options={[
          { value: '', label: track.input.startsWith('remote:') ? 'Cue' : 'Master' },
          ...targets.map((item) => ({ value: item.id, label: item.name })),
        ]}
        onChange={(next) => store.updateTrack(track.id, { output: next || null })}
      />
      <MixSelect
        label="Group"
        value={track.groupId ?? ''}
        options={[{ value: '', label: 'No group' }, ...groups.map((item) => ({ value: item.id, label: item.name }))]}
        onChange={(next) => store.updateTrack(track.id, { groupId: next || null })}
      />
      <MixSelect
        label="Link"
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

function MixSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [box, setBox] = useState<{ top: number; left: number } | null>(null)
  const current = options.find((item) => item.value === value)?.label ?? 'Choose'
  return (
    <div className={`mix-select${open ? ' open' : ''}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={`${label}. ${current}.`}
        title={label}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          setBox({ top: rect.bottom + 4, left: rect.left })
          setOpen((shown) => !shown)
        }}
      >
        <span>{label}</span>
        <small>{current}</small>
      </button>
      {open && box && (
        <div className="mix-select-menu" role="listbox" aria-label={label} style={{ top: box.top, left: box.left }} onPointerDown={(event) => event.stopPropagation()}>
          {options.map((item) => (
            <button
              key={item.value || 'none'}
              type="button"
              role="option"
              aria-selected={item.value === value}
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

function StripName({ name, color, onSelect, onOpen }: { name: string; color?: string; onSelect: () => void; onOpen: () => void }) {
  const timer = useRef(0)
  const held = useRef(false)
  const hold = () => {
    held.current = false
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      held.current = true
      onOpen()
    }, 480)
  }
  const cancel = () => window.clearTimeout(timer.current)
  return (
    <h3
      className="strip-name"
      style={color ? { color } : undefined}
      title={name}
      onPointerDown={(event) => {
        event.stopPropagation()
        if (event.button !== 0 && event.pointerType !== 'touch') return
        hold()
      }}
      onPointerUp={(event) => {
        event.stopPropagation()
        cancel()
      }}
      onPointerCancel={cancel}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'touch') cancel()
      }}
      onClick={(event) => {
        event.stopPropagation()
        if (held.current) {
          held.current = false
          return
        }
        onSelect()
      }}
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
      <p title="Loudness right now, in LUFS."><span>Short-term</span> <b>{text.lufs}</b></p>
      <p title="Loudness of the whole play."><span>Integrated</span> <b>{text.integrated}</b></p>
      <p title="Highest true peak."><span>Peak</span> <b>{text.peak} dB</b></p>
      <p title="How hard the mix is working."><span>Processor</span> <b>{text.cpu}%</b></p>
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

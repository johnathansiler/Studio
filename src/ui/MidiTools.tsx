import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import { midiInputs, midiOutputs } from '../midi/access'
import { MidiHost } from '../midi/host'
import { captureLatest, clearCapture, recallCapture, setCaptureEnabled } from '../midi/remember'
import {
  describeMap,
  FX_HINT,
  FX_LABEL,
  FX_RATES,
  hidesHardwareMidi,
  slotFromNode,
  suggestRouting,
  type LearnNode,
  type RoutingChoice,
} from '../model/midiTools'
import { SCALES } from '../model/scale'
import { samplesToBeats } from '../model/time'
import { selectLiveCapture, selectMidiMaps, selectMidiOut, selectTrackFx } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { MidiFx, MidiFxKind, Track } from '../model/types'
import './midiTools.css'

const KINDS: MidiFxKind[] = ['arp', 'chord', 'scale', 'repeat', 'humanize', 'velocity']
const CHORD_NAMES = ['Maj', 'Min', 'Sus2', 'Sus4', '7', 'm7', 'Dim', 'Aug']
const ARP_DIRS = ['Up', 'Down', 'Up/Down', 'Random']
const CURVES = ['Linear', 'Soft', 'Hard', 'Fixed']

export function MidiTools({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const hide = hidesHardwareMidi(typeof navigator === 'undefined' ? '' : navigator.userAgent)
  const [tick, setTick] = useState(0)
  const [section, setSection] = useState<'learn' | 'fx' | 'out' | 'capture' | 'inputs'>('fx')
  const host = useRef<MidiHost | null>(null)
  if (!host.current) host.current = new MidiHost(store, engine)
  const project = store.project
  const track = midiTrack(store)
  const fx = selectTrackFx(track)

  useEffect(() => store.subscribe(() => setTick((value) => value + 1)), [store])
  useEffect(() => {
    if (!store.midiToolsOpen) {
      host.current?.stop()
      return
    }
    host.current?.start(hide)
    return () => host.current?.stop()
  }, [hide, store.midiToolsOpen])
  useEffect(() => {
    engine.liveTrackId = track?.id ?? null
    engine.midiOutChannel = selectMidiOut(project).channel
    setCaptureEnabled(selectLiveCapture(project).enabled)
  }, [engine, project, track?.id, tick])
  useEffect(() => {
    if (!store.midiLearnActive) return
    const down = (event: PointerEvent) => {
      const node = readLearnNode(event.target)
      const slot = slotFromNode(node)
      if (!slot) return
      event.preventDefault()
      event.stopPropagation()
      store.armLearn(slot)
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [store, store.midiLearnActive, tick])

  if (hide || !store.midiToolsOpen) return null
  return (
    <section className="midi-tools" aria-label="MIDI tools">
      <div className="midi-tabs" role="tablist">
        <Tab id="learn" label="Learn" hint="Map a knob or key to a control" section={section} setSection={setSection} store={store} />
        <Tab id="fx" label="FX" hint="Effects before the instrument" section={section} setSection={setSection} store={store} />
        <Tab id="out" label="Out" hint="Send notes to external gear" section={section} setSection={setSection} store={store} />
        <Tab id="capture" label="Capture" hint="Keep what you just played" section={section} setSection={setSection} store={store} />
        <Tab id="inputs" label="Inputs" hint="Record several inputs at once" section={section} setSection={setSection} store={store} />
        <button type="button" title="Hide MIDI tools" onPointerDown={hint(store, 'Hide MIDI tools')} onClick={() => store.setMidiToolsOpen(false)}>Close</button>
      </div>
      {section === 'learn' && <LearnRow store={store} />}
      {section === 'fx' && <FxRow store={store} track={track} fx={fx} />}
      {section === 'out' && <OutRow store={store} />}
      {section === 'capture' && <CaptureRow store={store} engine={engine} track={track} />}
      {section === 'inputs' && <InputsRow store={store} />}
    </section>
  )
}

function Tab({
  id,
  label,
  hint: text,
  section,
  setSection,
  store,
}: {
  id: 'learn' | 'fx' | 'out' | 'capture' | 'inputs'
  label: string
  hint: string
  section: string
  setSection: (id: 'learn' | 'fx' | 'out' | 'capture' | 'inputs') => void
  store: ProjectStore
}) {
  return (
    <button type="button" role="tab" aria-selected={section === id} className={section === id ? 'on' : ''} title={text} onPointerDown={hint(store, text)} onClick={() => setSection(id)}>
      {label}
    </button>
  )
}

function LearnRow({ store }: { store: ProjectStore }) {
  const maps = selectMidiMaps(store.project)
  const learning = store.midiLearnActive
  const slot = store.midiLearnSlot
  return (
    <>
      <div className="midi-row">
        <button type="button" className={learning ? 'on' : ''} title="Tap a control, then move a knob or play a key" onPointerDown={hint(store, 'Tap a control, then move a knob or play a key')} onClick={() => store.setMidiLearn(!learning)}>
          {learning ? 'Listening' : 'Learn'}
        </button>
        <span className="midi-note">{slot ? `Move a knob for ${slot.label}` : learning ? 'Tap a fader, button, or knob' : 'Saved with this project'}</span>
        <button type="button" title="Remove every mapping" onPointerDown={hint(store, 'Remove every mapping')} onClick={() => store.clearMidiMaps()} disabled={!maps.length}>Clear all</button>
      </div>
      <div className="midi-maps">
        {maps.map((entry) => (
          <div className="midi-map" key={entry.id}>
            <strong>{entry.label}</strong>
            <span className="midi-note">{describeMap(entry)}</span>
            <label title="MIDI channel. 0 is any.">
              Ch
              <input aria-label={`${entry.label} channel`} type="number" min={0} max={16} value={entry.channel < 0 ? 0 : entry.channel + 1} onChange={(event) => {
                const next = Number(event.target.value)
                store.updateMidiMap(entry.id, { channel: next <= 0 ? -1 : Math.min(15, next - 1) })
              }} />
            </label>
            <label>
              #
              <input aria-label={`${entry.label} number`} type="number" min={0} max={127} value={entry.number} onChange={(event) => store.updateMidiMap(entry.id, { number: Number(event.target.value) })} />
            </label>
            <button type="button" title={`Remove ${entry.label}`} onClick={() => store.clearMidiMap(entry.id)}>Clear</button>
          </div>
        ))}
        {!maps.length && <span className="midi-note">No mappings yet.</span>}
      </div>
    </>
  )
}

function FxRow({ store, track, fx }: { store: ProjectStore; track: Track | null; fx: MidiFx[] }) {
  const [selected, setSelected] = useState(fx[0]?.id || '')
  const current = fx.find((item) => item.id === selected) || fx[0]
  const clipId = track?.midiClips.some((clip) => clip.id === store.selectedMidiClipId)
    ? store.selectedMidiClipId
    : track?.midiClips[0]?.id
  return (
    <>
      <div className="midi-row">
        <span className="midi-note">{track ? track.name : 'No instrument track'}</span>
        {KINDS.map((kind) => (
          <button key={kind} type="button" title={FX_HINT[kind]} disabled={!track} onPointerDown={hint(store, FX_HINT[kind])} onClick={() => track && store.addMidiFx(track.id, kind)}>
            {FX_LABEL[kind]}
          </button>
        ))}
        <button
          type="button"
          title="Write the effect chain into the selected clip"
          disabled={!track || !clipId}
          onPointerDown={hint(store, 'Write the effect chain into the selected clip')}
          onClick={() => track && clipId && store.printMidiFx(track.id, clipId)}
        >
          Print
        </button>
      </div>
      <div className="midi-fx">
        {fx.map((item, index) => (
          <div className="midi-fx-item" key={item.id}>
            <button type="button" className={item.enabled ? 'on' : ''} title={FX_HINT[item.kind]} onClick={() => { setSelected(item.id); track && store.setMidiFx(track.id, item.id, { enabled: !item.enabled }) }}>
              {FX_LABEL[item.kind]}
            </button>
            <button type="button" title="Move earlier in the chain" disabled={!track || index === 0} onClick={() => track && store.moveMidiFx(track.id, item.id, -1)}>↑</button>
            <button type="button" title="Move later in the chain" disabled={!track || index === fx.length - 1} onClick={() => track && store.moveMidiFx(track.id, item.id, 1)}>↓</button>
            <button type="button" title="Remove this effect" onClick={() => track && store.removeMidiFx(track.id, item.id)}>×</button>
          </div>
        ))}
        {!fx.length && <span className="midi-note">Chain is empty. Notes reach the instrument unchanged.</span>}
      </div>
      {track && current && <FxParams store={store} trackId={track.id} effect={current} />}
    </>
  )
}

function FxParams({ store, trackId, effect }: { store: ProjectStore; trackId: string; effect: MidiFx }) {
  const set = (param: string, value: number) => store.setMidiFx(trackId, effect.id, { params: { [param]: value } })
  const target = (param: string, label: string, min: number, max: number) => ({
    'data-midi': `fx:${trackId}:${effect.id}:${param}`,
    'data-midi-label': label,
    'data-midi-min': min,
    'data-midi-max': max,
  })
  return (
    <div className="midi-row">
      {(effect.kind === 'arp' || effect.kind === 'repeat') && (
        <select aria-label="Rate" value={nearestRate(effect.params.rate)} onChange={(event) => set('rate', Number(event.target.value))}>
          {FX_RATES.map((rate) => <option key={rate.label} value={rate.beats}>{rate.label}</option>)}
        </select>
      )}
      {effect.kind === 'arp' && (
        <>
          <select aria-label="Arp direction" value={effect.params.direction || 0} onChange={(event) => set('direction', Number(event.target.value))}>
            {ARP_DIRS.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <label>Oct
            <input aria-label="Arp octaves" type="number" min={1} max={4} value={effect.params.octaves || 1} onChange={(event) => set('octaves', Number(event.target.value))} />
          </label>
        </>
      )}
      {(effect.kind === 'arp' || effect.kind === 'repeat') && (
        <label>Gate
          <input aria-label="Gate" type="range" min={0.05} max={1} step={0.01} value={effect.params.gate ?? 0.8} {...target('gate', 'Gate', 0.05, 1)} onChange={(event) => set('gate', Number(event.target.value))} />
        </label>
      )}
      {effect.kind === 'chord' && (
        <>
          <select aria-label="Chord type" value={effect.params.type || 0} onChange={(event) => set('type', Number(event.target.value))}>
            {CHORD_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <label>Inv
            <input aria-label="Chord inversion" type="number" min={0} max={3} value={effect.params.inversion || 0} onChange={(event) => set('inversion', Number(event.target.value))} />
          </label>
        </>
      )}
      {effect.kind === 'scale' && (
        <>
          <button type="button" className={effect.params.follow >= 0.5 ? 'on' : ''} title="Use the project key" onClick={() => set('follow', effect.params.follow >= 0.5 ? 0 : 1)}>Project key</button>
          <select aria-label="Scale root" value={effect.params.root || 0} onChange={(event) => set('root', Number(event.target.value))}>
            {['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <select aria-label="Scale" value={effect.params.scale || 0} onChange={(event) => set('scale', Number(event.target.value))}>
            {SCALES.map((scale, index) => <option key={scale.id} value={index}>{scale.name}</option>)}
          </select>
        </>
      )}
      {effect.kind === 'humanize' && (
        <>
          <label>Time
            <input aria-label="Timing drift" type="range" min={0} max={0.25} step={0.005} value={effect.params.time || 0} {...target('time', 'Human time', 0, 0.25)} onChange={(event) => set('time', Number(event.target.value))} />
          </label>
          <label>Vel
            <input aria-label="Velocity drift" type="range" min={0} max={0.5} step={0.01} value={effect.params.vel || 0} {...target('vel', 'Human velocity', 0, 0.5)} onChange={(event) => set('vel', Number(event.target.value))} />
          </label>
        </>
      )}
      {effect.kind === 'velocity' && (
        <>
          <select aria-label="Velocity curve" value={effect.params.curve || 0} onChange={(event) => set('curve', Number(event.target.value))}>
            {CURVES.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
          <label>Amt
            <input aria-label="Curve amount" type="range" min={0} max={1} step={0.01} value={effect.params.amount ?? 1} {...target('amount', 'Curve amount', 0, 1)} onChange={(event) => set('amount', Number(event.target.value))} />
          </label>
        </>
      )}
    </div>
  )
}

function OutRow({ store }: { store: ProjectStore }) {
  const settings = selectMidiOut(store.project)
  const [ports, setPorts] = useState<{ id: string; name: string }[]>([])
  useEffect(() => setPorts(midiOutputs().map((port) => ({ id: port.id, name: port.name }))), [store.version])
  return (
    <div className="midi-row">
      <button type="button" className={settings.enabled ? 'on' : ''} title="Send played notes to a hardware output" onPointerDown={hint(store, 'Send played notes to a hardware output')} onClick={() => store.setMidiOut({ enabled: !settings.enabled })}>
        {settings.enabled ? 'Sending' : 'Send notes'}
      </button>
      <select aria-label="MIDI output" value={settings.port} onChange={(event) => store.setMidiOut({ port: event.target.value })}>
        <option value="">All outputs</option>
        {ports.map((port) => <option key={port.id} value={port.id}>{port.name}</option>)}
      </select>
      <label>Ch
        <input aria-label="Output channel" type="number" min={1} max={16} value={settings.channel + 1} onChange={(event) => store.setMidiOut({ channel: Math.max(0, Math.min(15, Number(event.target.value) - 1)) })} />
      </label>
      <button type="button" className={settings.clock ? 'on' : ''} title="Send MIDI clock while the transport runs" onPointerDown={hint(store, 'Send MIDI clock while the transport runs')} onClick={() => store.setMidiOut({ clock: !settings.clock })}>
        Clock
      </button>
    </div>
  )
}

function CaptureRow({ store, engine, track }: { store: ProjectStore; engine: AudioEngine; track: Track | null }) {
  const settings = selectLiveCapture(store.project)
  return (
    <div className="midi-row">
      <button type="button" className={settings.enabled ? 'on' : ''} title="Keep a buffer of what you play without pressing record" onPointerDown={hint(store, 'Keep a buffer of what you play without pressing record')} onClick={() => store.setLiveCapture({ enabled: !settings.enabled })}>
        {settings.enabled ? 'Buffer on' : 'Buffer off'}
      </button>
      <select aria-label="Capture length" value={settings.bars} onChange={(event) => store.setLiveCapture({ bars: Number(event.target.value) })}>
        {[1, 2, 4, 8, 16].map((bars) => <option key={bars} value={bars}>{bars} bars</option>)}
      </select>
      <button
        type="button"
        title="Turn the buffer into a clip on this instrument"
        disabled={!track}
        onPointerDown={hint(store, 'Turn the buffer into a clip on this instrument')}
        onClick={() => {
          if (!track) return
          const beat = samplesToBeats(engine.currentTimelineSample(), store.project.sampleRate, store.project.tempo)
          const windowBeats = settings.bars * store.project.timeSignature.numerator
          const clip = recallCapture(track.id, Math.max(beat, captureLatest(track.id)), windowBeats)
          if (!clip) {
            store.toast('Nothing new is in the capture buffer.', 'warn')
            return
          }
          store.placeMidiTake(track.id, clip.startBeat, clip.notes, 'Capture')
          clearCapture(track.id)
          store.toast('Saved the phrase you just played.', 'good')
        }}
      >
        To clip
      </button>
      <span className="midi-note">{track ? track.name : 'Pick an instrument'}</span>
    </div>
  )
}

function InputsRow({ store }: { store: ProjectStore }) {
  const [audio, setAudio] = useState<{ id: string; label: string }[]>([])
  const [ports, setPorts] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    setPorts(midiInputs())
    void navigator.mediaDevices?.enumerateDevices?.().then((list) => {
      setAudio(list.filter((item) => item.kind === 'audioinput').map((item) => ({ id: item.deviceId, label: item.label || 'Audio input' })))
    }).catch(() => undefined)
  }, [])
  return (
    <>
      <div className="midi-row">
        <button
          type="button"
          title="Arm each input on its own track"
          onPointerDown={hint(store, 'Arm each input on its own track')}
          onClick={() => {
            const choices: RoutingChoice[] = [{ id: 'default', label: 'Mic', kind: 'audio', channels: 2 }]
            for (const device of audio) {
              if (device.id && device.id !== 'default') choices.push({ id: device.id, label: device.label, kind: 'audio', channels: 1 })
            }
            for (const port of ports) choices.push({ id: port.id, label: port.name, kind: 'midi' })
            const routes = suggestRouting(store.project.tracks, choices)
            store.applyInputRoutes(routes)
            const midiTracks = store.project.tracks.filter((track) => track.type === 'midi').length
            if (ports.length > midiTracks) store.toast('Add an instrument track to record every MIDI input.', 'info')
          }}
        >
          Use all inputs
        </button>
        <span className="midi-note">Record prints each armed track from its own input.</span>
      </div>
      <div className="midi-maps">
        {store.project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi').map((track) => (
          <div className="midi-map" key={track.id}>
            <button type="button" className={track.armed ? 'on' : ''} title={`Arm ${track.name}`} onClick={() => store.updateTrack(track.id, { armed: !track.armed })}>
              {track.armed ? 'Armed' : 'Arm'}
            </button>
            <span>{track.name}</span>
            <select aria-label={`${track.name} input`} value={track.input} onChange={(event) => store.updateTrack(track.id, { input: event.target.value })}>
              {track.type === 'audio' ? (
                <>
                  <option value="mic">Mic · all</option>
                  <option value="mic:0">Mic 1</option>
                  <option value="mic:1">Mic 2</option>
                  <option value="line">Line</option>
                  <option value="none">No input</option>
                  {audio.filter((device) => device.id).map((device) => <option key={device.id} value={`dev:${device.id}`}>{device.label}</option>)}
                </>
              ) : (
                <>
                  <option value="none">No input</option>
                  <option value="midi">All MIDI</option>
                  {ports.map((port) => <option key={port.id} value={`midi:${port.id}`}>{port.name}</option>)}
                </>
              )}
            </select>
          </div>
        ))}
      </div>
    </>
  )
}

function midiTrack(store: ProjectStore): Track | null {
  return store.project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'midi')
    || store.project.tracks.find((track) => track.type === 'midi' && track.armed)
    || store.project.tracks.find((track) => track.type === 'midi')
    || null
}

function nearestRate(value: number | undefined) {
  const rate = value || 0.25
  return FX_RATES.reduce((best, item) => (Math.abs(item.beats - rate) < Math.abs(best - rate) ? item.beats : best), FX_RATES[0].beats)
}

function hint(store: ProjectStore, text: string) {
  return (event: ReactPointerEvent) => {
    const timer = window.setTimeout(() => store.toast(text), 480)
    const clear = () => window.clearTimeout(timer)
    event.currentTarget.addEventListener('pointerup', clear, { once: true })
    event.currentTarget.addEventListener('pointercancel', clear, { once: true })
    event.currentTarget.addEventListener('pointerleave', clear, { once: true })
  }
}

function readLearnNode(target: EventTarget | null): LearnNode | null {
  const el = target instanceof Element ? target : null
  if (!el) return null
  const marked = el.closest('[data-midi]')
  if (marked) {
    return {
      midi: marked.getAttribute('data-midi') || '',
      midiLabel: marked.getAttribute('data-midi-label') || marked.getAttribute('aria-label') || undefined,
      midiMin: numberAttr(marked, 'data-midi-min'),
      midiMax: numberAttr(marked, 'data-midi-max'),
      midiToggle: marked.hasAttribute('data-midi-toggle'),
    }
  }
  if (el.closest('.midi-tools')) return null
  const track = el.closest('[data-track]')
  const button = el.closest('button')
  const range = el.closest('input[type="range"]') as HTMLInputElement | null
  return {
    trackId: track?.getAttribute('data-track') || undefined,
    className: range?.className,
    text: button?.textContent || undefined,
    aria: el.closest('[aria-label]')?.getAttribute('aria-label') || undefined,
    inMaster: Boolean(el.closest('.strip.master')),
    range: Boolean(range),
  }
}

function numberAttr(el: Element, name: string) {
  const value = el.getAttribute(name)
  if (value == null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

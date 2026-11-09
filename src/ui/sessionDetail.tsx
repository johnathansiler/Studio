import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { descriptor } from '../audio/plugins/catalog'
import type { AudioEngine } from '../audio/engine'
import { snapClipTimeline } from '../audio/clipSnap'
import { sourceSamplesOf } from '../audio/stretch/engine'
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, QUANT_LABEL, sceneClip } from '../model/launch'
import { quartersPerBar } from '../model/time'
import { CLIP_SWATCHES, curvePath } from '../model/sessionBoard'
import type { AudioClip, FollowAction, LaunchMode, LaunchQuant, MidiFx, PluginInstance, Track } from '../model/types'
import { NOTE_NAMES, SCALES, type ScaleId } from '../model/scale'
import { suggestKey } from '../theory'
import { EDITOR_TOOLS, TOOL_INFO, activeTool, subscribeTools } from '../state/tools'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { SongLoopStrip } from './LoopRegion'
import { PianoRoll, type PianoActions } from './PianoRoll'
import { WaveformView, type WaveMarker } from './WaveformView'

export function SessionDetail({
  store,
  engine,
  track,
  scene,
  height,
  onResize,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  track: Track | null
  scene: number | null
  height: number
  onResize: (height: number) => void
  onClose?: () => void
}) {
  const phone = useFormFactor() === 'phone'
  const clip = track && scene != null ? sceneClip(track, scene) : null
  const clipId = clip?.id ?? ''
  const [tab, setTab] = useState<'clip' | 'devices'>(clip ? 'clip' : 'devices')
  const [more, setMore] = useState(false)
  const [chords, setChords] = useState(false)
  const actions = useRef<PianoActions | null>(null)
  useEffect(() => { setTab(clipId ? 'clip' : 'devices') }, [clipId])
  const mode = clip ? tab : 'devices'
  const tool = useSyncExternalStore(subscribeTools, activeTool, activeTool)
  const midiClip = clip && !('bufferId' in clip) ? clip : null
  const scale = store.scaleState()

  return (
    <section className="sl-detail" data-session-detail="open" style={{ ['--detail' as string]: `${height}px` }}>
      <div
        className="sl-detail-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize detail. Drag to change its height."
        title="Drag the top edge to resize the detail view."
        onPointerDown={(event) => {
          event.preventDefault()
          const start = event.clientY
          const initial = height
          const cap = Math.min(720, Math.round(window.innerHeight * 0.72))
          const move = (ev: PointerEvent) => onResize(Math.min(cap, Math.max(200, initial + start - ev.clientY)))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="sl-detail-bar">
        {clip && track ? (
          <input aria-label="Clip name" title={clip.name} value={clip.name} onChange={(event) => store.renameClip(track.id, clip.id, event.target.value)} />
        ) : (
          <strong>{track ? track.name : 'Detail'}</strong>
        )}
        {clip && (
          <>
            <button type="button" className={mode === 'clip' ? 'on' : ''} title="Clip settings, notes, or waveform." onClick={() => setTab('clip')}>Clip</button>
            <button type="button" className={mode === 'devices' ? 'on' : ''} title="Devices on this track." onClick={() => setTab('devices')}>Devices</button>
          </>
        )}
        {mode === 'clip' && clip && track && (
          <button type="button" className={clip.loop !== false ? 'on' : ''} title="Loop this clip." onClick={() => store.setClipLaunch(track.id, clip.id, { loop: clip.loop === false })}>Loop</button>
        )}
        {mode === 'clip' && midiClip && track && !phone && (
          <select aria-label="Clip length" title="Length of this clip." value={String(midiClip.durationBeats)} onChange={(event) => store.resizeMidiClip(track.id, midiClip.id, 'end', midiClip.startBeat + Number(event.target.value))}>
            {[1, 2, 4, 8].map((bars) => {
              const beats = bars * quartersPerBar(store.project.timeSignature)
              return <option key={bars} value={beats}>{bars === 1 ? '1 bar' : `${bars} bars`}</option>
            })}
          </select>
        )}
        {mode === 'clip' && midiClip && !phone && (
          <select aria-label="Note grid" title="How long a tapped note is." value={String(store.project.roll?.grid ?? 0.25)} onChange={(event) => store.setRoll({ grid: Number(event.target.value) })}>
            <option value="0">Free</option>
            <option value="0.25">1/16</option>
            <option value="0.5">1/8</option>
            <option value="1">1/4</option>
          </select>
        )}
        {mode === 'clip' && midiClip && <span className="sl-tool" data-active-tool={tool}>{TOOL_INFO[tool].label}</span>}
        {clip && (
          <button type="button" className={more ? 'on' : ''} aria-expanded={more} title="More clip and note controls." onClick={() => setMore((value) => !value)}>⋮</button>
        )}
        {onClose && <button type="button" title="Hide the detail view." onClick={onClose}>Hide</button>}
      </div>
      {more && clip && track && (
        <div className="sl-more">
          <div className="sl-swatches" aria-label="Clip color">
            {CLIP_SWATCHES.map((color) => (
              <button key={color} type="button" title="Clip color." style={{ background: color }} onClick={() => store.recolorClip(track.id, clip.id, color)} />
            ))}
          </div>
          <select aria-label="Launch mode" title="What the triangle does." value={clip.mode ?? 'toggle'} onChange={(event) => store.setClipLaunch(track.id, clip.id, { mode: event.target.value as LaunchMode })}>
            {LAUNCH_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <select aria-label="Clip quantize" title="Launch grid for this clip. Global is the bar setting above." value={clip.quant ?? ''} onChange={(event) => store.setClipLaunch(track.id, clip.id, { quant: (event.target.value || undefined) as LaunchQuant | undefined })}>
            <option value="">Global</option>
            {LAUNCH_QUANTS.map((value) => <option key={value} value={value}>{QUANT_LABEL[value]}</option>)}
          </select>
          <select className="sl-follow" aria-label="Follow action" title="What happens when the clip finishes." value={clip.follow ?? 'none'} onChange={(event) => store.setClipLaunch(track.id, clip.id, { follow: event.target.value as FollowAction })}>
            {FOLLOW_ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <button type="button" title="Duplicate into the next empty scene." onClick={() => store.duplicateSlot(track.id, scene ?? 0)}>Duplicate</button>
          {midiClip && (
            <>
              <select aria-label="Key" title="The key." value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
                {NOTE_NAMES.map((name, index) => <option key={name} value={index}>{name}</option>)}
              </select>
              <select aria-label="Scale" title="Which notes are in key." value={scale.scale} onChange={(event) => store.setScale({ scale: event.target.value as ScaleId })}>
                {SCALES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <button type="button" className={scale.snap ? 'on' : ''} title="New notes land on the scale." onClick={() => store.setScale({ snap: !scale.snap })}>Snap</button>
              <button type="button" title="Guess the key from the notes in this clip." onClick={() => {
                const found = suggestKey(midiClip.notes.map((note) => ({ midi: note.pitch, cents: note.fine, weight: note.durationBeats })))
                store.setScale({ root: found.root, scale: found.scale, library: found.library })
              }}>Detect key</button>
              <button type="button" className={chords ? 'on' : ''} title="Pads of chords in the current key." onClick={() => setChords((value) => !value)}>Chords</button>
              <button type="button" className={store.midiEditor().stepInput ? 'on' : ''} title="Keys write a note at the playhead. Off, they only play the sound." onClick={() => store.setMidiEditor({ stepInput: !store.midiEditor().stepInput })}>Step input</button>
              <button type="button" className={store.midiEditor().follow ? 'on' : ''} title="Scroll the piano roll to keep the playhead in view while playing." onClick={() => store.setMidiEditor({ follow: !store.midiEditor().follow })}>Follow</button>
              {EDITOR_TOOLS.map((id) => (
                <button key={id} type="button" className={tool === id ? 'on' : ''} title={TOOL_INFO[id].hint} onClick={() => store.setTool(id)}>{TOOL_INFO[id].label}</button>
              ))}
              <button type="button" title="Snap the selected notes onto the grid." onClick={() => actions.current?.quantize()}>Quantize</button>
              <button type="button" title="Turn the selected chord into an arpeggio." onClick={() => actions.current?.arpeggiate()}>Arp</button>
              <button type="button" title="Spread the selected chord like a strum." onClick={() => actions.current?.strum()}>Strum</button>
              <button type="button" title="Remove the selected notes." onClick={() => actions.current?.remove()}>Delete</button>
            </>
          )}
        </div>
      )}
      {mode === 'devices' || !clip || !track ? (
        <DeviceChain store={store} track={track} />
      ) : (
        <div className="sl-clipbody">
          {'bufferId' in clip ? (
            <>
              <SongLoopStrip store={store} onSeek={(sample) => engine.seek(sample)} />
              <Waveform store={store} trackId={track.id} clip={clip} engine={engine} />
            </>
          ) : (
            <PianoRoll store={store} engine={engine} chrome={false} chordsOpen={chords} actionsRef={actions} voiceSurface="clip" />
          )}
        </div>
      )}
    </section>
  )
}

function Waveform({ store, trackId, clip, engine }: { store: ProjectStore; trackId: string; clip: AudioClip; engine: AudioEngine }) {
  const asset = store.buffers.get(clip.bufferId)
  const channel = asset?.channels[0]
  const length = Math.max(1, channel?.length ?? clip.offsetSamples + clip.durationSamples)
  const source = sourceSamplesOf(clip)
  const ratio = clip.durationSamples / Math.max(1, source)
  const [snap, setSnap] = useState(true)
  const offset = Math.min(length - 1, Math.max(0, clip.offsetSamples))
  const endSource = Math.min(length, Math.max(offset + 1, clip.offsetSamples + source))
  const markers: WaveMarker[] = [
    { id: 'start', at: offset / length, className: 'mark', marker: 'start', name: 'Start', label: 'Clip start. Drag to trim the beginning.', title: 'Clip start. Drag to set the start offset on a zero crossing.' },
    { id: 'end', at: endSource / length, className: 'mark', marker: 'end', name: 'End', label: 'Clip end. Drag to trim the length.', title: 'Clip end. Drag to set the end on a zero crossing.' },
  ]
  const home = { start: offset, end: endSource }
  return (
    <WaveformView
      channel={channel}
      className="sl-wave"
      dataWaveform="clip"
      ariaLabel="Clip waveform"
      color="rgba(255,255,255,0.9)"
      chrome="above"
      snap={snap}
      onSnap={setSnap}
      bounds={{ start: 0, end: length }}
      home={home}
      markers={markers}
      toolbarExtra={(
        <button
          type="button"
          className="wave-zoom-btn"
          title="Split the clip at the playhead, on a zero crossing."
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            const at = engine.currentTimelineSample()
            const inside = at > clip.startSample && at < clip.startSample + clip.durationSamples
            const timeline = inside ? at : clip.startSample + clip.durationSamples / 2
            const snapped = snapClipTimeline(clip, channel, timeline, snap)
            store.splitAt(trackId, clip.id, snapped.sample)
          }}
        >Split</button>
      )}
      onMarker={(id, fraction, phase) => {
        if (phase !== 'commit') return
        const edge = id === 'end' ? 'end' : 'start'
        const sourceIndex = fraction * length
        const timeline = clip.startSample + (sourceIndex - clip.offsetSamples) * ratio
        const current = edge === 'start' ? clip.startSample : clip.startSample + clip.durationSamples
        if (Math.round(timeline) === current) return
        store.trimClip(trackId, clip.id, edge, timeline, snap)
      }}
    >
      {clip.loop !== false && <i className="loopbar" />}
    </WaveformView>
  )
}

function DeviceChain({ store, track }: { store: ProjectStore; track: Track | null }) {
  if (!track) return <p className="sl-note">Select a track to see its devices.</p>
  const audio = track.plugins ?? []
  const midi = track.midiFx ?? []
  if (!audio.length && !midi.length) return <p className="sl-note">Drag an effect from the browser onto this track.</p>
  return (
    <div className="sl-devices" data-devices={track.id}>
      {midi.map((fx) => (
        <MidiFace key={fx.id} store={store} trackId={track.id} fx={fx} />
      ))}
      {audio.map((plugin) => (
        <AudioFace key={plugin.id} store={store} trackId={track.id} plugin={plugin} />
      ))}
    </div>
  )
}

function AudioFace({ store, trackId, plugin }: { store: ProjectStore; trackId: string; plugin: PluginInstance }) {
  const spec = descriptor(plugin.pluginId)
  const title = plugin.pluginId === 'tune' ? 'Auto-Tune' : spec?.name ?? plugin.pluginId
  const params = (spec?.params ?? []).filter((param) => param.id !== 'mask').slice(0, 6)
  return (
    <article className="sl-device" data-device={plugin.pluginId}>
      <header>
        <strong>{title}</strong>
        <button type="button" className={plugin.enabled ? 'on' : ''} title="Turn this device on or off." onClick={() => store.updatePlugin(trackId, plugin.id, { enabled: !plugin.enabled })}>{plugin.enabled ? 'On' : 'Off'}</button>
        <button type="button" title="Remove this device." onClick={() => store.removePlugin(trackId, plugin.id)}>×</button>
      </header>
      <Curve kind={plugin.pluginId} values={plugin.params} />
      <div className="sl-knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
        {params.map((param) => (
          <label key={param.id}>
            {param.name}
            <input
              type="range"
              min={param.min}
              max={param.max}
              step={(param.max - param.min) / 100}
              value={plugin.params[param.id] ?? param.default}
              aria-label={`${title} ${param.name}`}
              onChange={(event) => store.updatePlugin(trackId, plugin.id, { params: { [param.id]: Number(event.target.value) } })}
            />
          </label>
        ))}
      </div>
    </article>
  )
}

function MidiFace({ store, trackId, fx }: { store: ProjectStore; trackId: string; fx: MidiFx }) {
  const title = fx.kind === 'scale' ? 'Scaler' : fx.kind
  const entries = Object.entries(fx.params).slice(0, 6)
  return (
    <article className="sl-device" data-device={fx.kind}>
      <header>
        <strong>{title}</strong>
        <button type="button" className={fx.enabled ? 'on' : ''} title="Turn this device on or off." onClick={() => store.setMidiFx(trackId, fx.id, { enabled: !fx.enabled })}>{fx.enabled ? 'On' : 'Off'}</button>
        <button type="button" title="Remove this device." onClick={() => store.removeMidiFx(trackId, fx.id)}>×</button>
      </header>
      <Curve kind={fx.kind} values={fx.params} />
      <div className="sl-knobs" onPointerDown={() => store.beginAutomationTouch()} onPointerUp={() => store.endAutomationTouch()} onPointerCancel={() => store.endAutomationTouch()}>
        {entries.map(([id, value]) => (
          <label key={id}>
            {id}
            <input
              type="range"
              min={0}
              max={id === 'root' ? 11 : 1}
              step={id === 'root' ? 1 : 0.01}
              value={value}
              aria-label={`${title} ${id}`}
              onChange={(event) => store.setMidiFx(trackId, fx.id, { params: { [id]: Number(event.target.value) } })}
            />
          </label>
        ))}
      </div>
    </article>
  )
}

function Curve({ kind, values }: { kind: string; values: Record<string, number> }) {
  const d = curvePath(kind, values)
  return (
    <svg className="sl-curve" viewBox="0 0 200 54" aria-hidden>
      <path d={d} />
    </svg>
  )
}


import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import { descriptor } from '../audio/plugins/catalog'
import type { AudioEngine } from '../audio/engine'
import { computePeaks } from '../model/demo'
import { FOLLOW_ACTIONS, LAUNCH_MODES, LAUNCH_QUANTS, QUANT_LABEL, sceneClip } from '../model/launch'
import { quartersPerBar } from '../model/time'
import { CLIP_SWATCHES, curvePath } from '../model/sessionBoard'
import type { AudioClip, FollowAction, LaunchMode, LaunchQuant, MidiClip, MidiFx, PluginInstance, Track } from '../model/types'
import { activeTool, subscribeTools } from '../state/tools'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import { PianoRoll } from './PianoRoll'
import { ToolBar } from './ToolBar'

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
  useEffect(() => { setTab(clipId ? 'clip' : 'devices') }, [clipId])
  const mode = clip ? tab : 'devices'
  const tool = useSyncExternalStore(subscribeTools, activeTool, activeTool)

  return (
    <section className="sl-detail" data-session-detail="open" style={{ ['--detail' as string]: `${height}px` }}>
      <div
        className="sl-detail-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize detail. Drag to change its height."
        title="Drag to resize the detail view."
        onPointerDown={(event) => {
          event.preventDefault()
          const start = event.clientY
          const initial = height
          const move = (ev: PointerEvent) => onResize(Math.min(480, Math.max(140, initial + start - ev.clientY)))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="sl-detail-bar">
        <strong>{clip ? clip.name : track ? track.name : 'Detail'}</strong>
        {clip && (
          <>
            <button type="button" className={mode === 'clip' ? 'on' : ''} title="Clip settings, notes, or waveform." onClick={() => setTab('clip')}>Clip</button>
            <button type="button" className={mode === 'devices' ? 'on' : ''} title="Devices on this track." onClick={() => setTab('devices')}>Devices</button>
          </>
        )}
        {mode === 'clip' && clip && track?.type === 'midi' && <span className="sl-tool" data-active-tool={tool}>{tool}</span>}
        {onClose && <button type="button" title="Hide the detail view." onClick={onClose}>Hide</button>}
      </div>
      {mode === 'devices' || !clip || !track ? (
        <DeviceChain store={store} track={track} />
      ) : (
        <div className="sl-clipbody">
          <ClipBar store={store} track={track} clip={clip} scene={scene ?? 0} />
          {'bufferId' in clip ? (
            <Waveform store={store} trackId={track.id} clip={clip} />
          ) : (
            <>
              <ToolBar context="piano" compact={phone} onChange={(next) => store.setTool(next)} onDuplicate={() => store.duplicateSlot(track.id, scene ?? 0)} onDelete={() => store.deleteSelectedClip()} />
              <PianoRoll store={store} engine={engine} />
            </>
          )}
        </div>
      )}
    </section>
  )
}

function ClipBar({
  store,
  track,
  clip,
  scene,
}: {
  store: ProjectStore
  track: Track
  clip: AudioClip | MidiClip
  scene: number
}) {
  return (
    <div className="sl-detail-bar">
      <input
        aria-label="Clip name"
        title="Rename this clip."
        value={clip.name}
        onChange={(event) => store.renameClip(track.id, clip.id, event.target.value)}
      />
      <div className="sl-swatches" aria-label="Clip color">
        {CLIP_SWATCHES.map((color) => (
          <button key={color} type="button" title="Clip color." style={{ background: color }} onClick={() => store.recolorClip(track.id, clip.id, color)} />
        ))}
      </div>
      <button type="button" className={clip.loop !== false ? 'on' : ''} title="Loop this clip." onClick={() => store.setClipLaunch(track.id, clip.id, { loop: clip.loop === false })}>Loop</button>
      <select aria-label="Launch mode" title="What a click does." value={clip.mode ?? 'toggle'} onChange={(event) => store.setClipLaunch(track.id, clip.id, { mode: event.target.value as LaunchMode })}>
        {LAUNCH_MODES.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="Clip quantize" title="Launch grid for this clip. Global is the bar setting above." value={clip.quant ?? ''} onChange={(event) => store.setClipLaunch(track.id, clip.id, { quant: (event.target.value || undefined) as LaunchQuant | undefined })}>
        <option value="">Global</option>
        {LAUNCH_QUANTS.map((value) => <option key={value} value={value}>{QUANT_LABEL[value]}</option>)}
      </select>
      {'durationBeats' in clip && !('bufferId' in clip) && (
        <select aria-label="Clip length" title="Length of this clip." value={String(clip.durationBeats)} onChange={(event) => store.resizeMidiClip(track.id, clip.id, 'end', clip.startBeat + Number(event.target.value))}>
          {[1, 2, 4, 8, 16].map((bars) => {
            const beats = bars * quartersPerBar(store.project.timeSignature)
            return <option key={bars} value={beats}>{bars === 1 ? '1 bar' : `${bars} bars`}</option>
          })}
        </select>
      )}
      <select className="sl-follow" aria-label="Follow action" title="What happens when the clip finishes." value={clip.follow ?? 'none'} onChange={(event) => store.setClipLaunch(track.id, clip.id, { follow: event.target.value as FollowAction })}>
        {FOLLOW_ACTIONS.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <button type="button" className="sl-dup" title="Duplicate into the next empty scene." onClick={() => store.duplicateSlot(track.id, scene)}>Duplicate</button>
    </div>
  )
}

function Waveform({ store, trackId, clip }: { store: ProjectStore; trackId: string; clip: AudioClip }) {
  const asset = store.buffers.get(clip.bufferId)
  const canvas = useRef<HTMLCanvasElement>(null)
  const source = asset?.channels[0]
  const peaks = useMemo(() => {
    if (!source?.length) return []
    const slice = source.subarray(clip.offsetSamples, Math.min(source.length, clip.offsetSamples + Math.max(1, clip.durationSamples)))
    return computePeaks(slice, 240)
  }, [source, clip.offsetSamples, clip.durationSamples])

  useEffect(() => {
    const node = canvas.current
    if (!node) return
    const width = 480
    node.width = width
    node.height = 96
    const ctx = node.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, width, 96)
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    peaks.forEach((peak, index) => {
      const x = Math.floor((index / Math.max(1, peaks.length)) * width)
      const y1 = (1 - peak.max) * 48
      const y2 = (1 - peak.min) * 48
      ctx.fillRect(x, y1, 2, Math.max(1, y2 - y1))
    })
  }, [peaks])

  function drag(edge: 'start' | 'end', event: ReactPointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    const bounds = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
    const origin = event.clientX
    const length = asset?.channels[0]?.length ?? clip.offsetSamples + clip.durationSamples
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up)
      const delta = ((ev.clientX - origin) / Math.max(1, bounds.width)) * clip.durationSamples
      const sample = edge === 'start' ? clip.startSample + delta : clip.startSample + clip.durationSamples + delta
      store.trimClip(trackId, clip.id, edge, sample)
      if (edge === 'end' && sample > clip.startSample + length) return
    }
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="sl-wave" data-waveform="clip">
      <canvas ref={canvas} />
      {clip.loop !== false && <i className="loopbar" />}
      <div className="mark" data-marker="start" title="Clip start. Drag to trim the beginning." onPointerDown={(event) => drag('start', event)} />
      <div className="mark" data-marker="end" title="Clip end. Drag to trim the length." onPointerDown={(event) => drag('end', event)} />
    </div>
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
      <div className="sl-knobs">
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
      <div className="sl-knobs">
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


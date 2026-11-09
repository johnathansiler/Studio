import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { gainToDb } from '../model/time'
import { controlDefault } from './paramDefaults'
import { GestureReadout, TouchSlider, useDragValue } from './kit/controls'
import type { AudioEngine } from '../audio/engine'
import type { ArrangeTool } from '../state/tools'
import type { AutoSpec } from '../model/automation'
import { channelAutomationMode } from '../model/automation'
import { automatedValue, automationWriteMode, laneChoices, lanePoints, mixGroupsOf, trackGroupId } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { AutomationWriteMode } from '../model/types'
import { BevelSelect } from './BevelSelect'
import './automation.css'

const MODES: { id: AutomationWriteMode; label: string; short: string; title: string }[] = [
  { id: 'off', label: 'Off', short: 'O', title: 'Off. This channel ignores automation. The faders and knobs always change the sound.' },
  { id: 'read', label: 'Read', short: 'R', title: 'Read. This channel plays its automation. A control with no lane still changes the sound.' },
  { id: 'touch', label: 'Touch', short: 'T', title: 'Touch. This channel writes only while you hold the control.' },
  { id: 'latch', label: 'Latch', short: 'L', title: 'Latch. This channel keeps writing the value you set until playback stops.' },
]

/** One cycling button. Tap moves Off, Read, Touch, Latch, then back to Off. */
export function ChannelAutomation({ store, trackId }: { store: ProjectStore; trackId: string | 'master' }) {
  const mode = channelAutomationMode(store.project, trackId)
  const name = trackId === 'master' ? 'Master' : store.project.tracks.find((track) => track.id === trackId)?.name ?? 'Channel'
  const index = Math.max(0, MODES.findIndex((item) => item.id === mode))
  const item = MODES[index]
  const next = MODES[(index + 1) % MODES.length]
  const apply = (id: AutomationWriteMode) => (trackId === 'master' ? store.setMasterAutomation(id) : store.setTrackAutomation(trackId, id))
  return (
    <div className="strip-auto auto-mode in-strip" role="group" aria-label={`${name} automation`}>
      <button
        type="button"
        className={mode === 'off' ? '' : 'on'}
        aria-pressed={mode !== 'off'}
        data-mode={mode}
        aria-label={`${item.label}. ${item.title} Next is ${next.label}.`}
        title={`${item.title} Tap for ${next.label}.`}
        onClick={(event) => {
          event.stopPropagation()
          apply(next.id)
        }}
      >
        <span className="mode-full">{item.label}</span>
        <span className="mode-stack">
          <span className="mode-short">{item.short}</span>
          <small className="mode-caption">{item.label}</small>
        </span>
      </button>
    </div>
  )
}

export function AutomationModeBar({ store, embedded = false }: { store: ProjectStore; embedded?: boolean }) {
  const mode = automationWriteMode(store.project)
  return (
    <div className={`auto-mode${embedded ? ' in-strip' : ''}`} role="group" aria-label="Automation write mode">
      {MODES.map((item) => (
        <button key={item.id} type="button" className={mode === item.id ? 'on' : ''} aria-pressed={mode === item.id} aria-label={`${item.label}. ${item.title}`} title={item.title} onClick={() => store.setAutomationMode(item.id)}>
          <span className="mode-full">{item.label}</span>
          <span className="mode-stack">
            <span className="mode-short">{item.short}</span>
            <small className="mode-caption">{item.label}</small>
          </span>
        </button>
      ))}
    </div>
  )
}

/** Keeps a latch write running after the finger lifts, until the transport stops. */
export function AutomationFollow({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const status = useRef(engine.status)
  useEffect(
    () =>
      engine.subscribe(() => {
        const rolling = engine.status === 'playing' || engine.status === 'recording'
        if (rolling) store.sustainAutomation(engine.currentTimelineSample())
        else if (status.current === 'playing' || status.current === 'recording') store.finishAutomationLatch()
        status.current = engine.status
      }),
    [engine, store],
  )
  return null
}

export function MixFlags({ store, trackId, compact = false, part = 'all' }: { store: ProjectStore; trackId: string; compact?: boolean; part?: 'all' | 'hear' | 'extra' | 'mute' | 'solo' | 'arm' | 'safe' }) {
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!track) return null
  const mute = part === 'all' || part === 'hear' || part === 'mute'
  const solo = part === 'all' || part === 'hear' || part === 'solo'
  const arm = part === 'arm' || part === 'extra' || (part === 'all' && !compact)
  const safe = part === 'safe' || part === 'extra' || (part === 'all' && !compact)
  return (
    <>
      {mute && (
        <button type="button" className={`mini ${track.mute ? 'on-m' : ''}`} aria-label={track.mute ? 'Unmute track' : 'Mute track'} title="Mute this track. Linked tracks mute together." onClick={(event) => { event.stopPropagation(); store.toggleTrack(track.id, 'mute') }}>
          <span className="mini-mark">M</span>
          <span className="mini-word">Mute</span>
          <small className="mini-caption">Mute</small>
        </button>
      )}
      {solo && (
        <button type="button" className={`mini ${track.solo ? 'on-s' : ''}`} aria-label={track.solo ? 'Unsolo track' : 'Solo track'} title="Solo this track and keep its path to the master open." onClick={(event) => { event.stopPropagation(); store.toggleTrack(track.id, 'solo') }}>
          <span className="mini-mark">S</span>
          <span className="mini-word">Solo</span>
          <small className="mini-caption">Solo</small>
        </button>
      )}
      {arm && (
        <button type="button" className={`mini arm-flag ${track.armed ? 'on-r' : ''}`} aria-pressed={track.armed} aria-label={track.armed ? 'Disarm track' : 'Arm track. This track records when you press record.'} title="Arm this track. Only armed tracks record." onClick={(event) => { event.stopPropagation(); store.updateTrack(track.id, { armed: !track.armed }) }}>
          <span className="arm-full">Arm</span>
          <span className="arm-compact" aria-hidden="true">A<i className="arm-dot" /></span>
        </button>
      )}
      {safe && (
        <button type="button" className={`mini solo-safe ${track.soloSafe ? 'on' : ''}`} aria-pressed={!!track.soloSafe} aria-label="Solo safe. Stay audible when other tracks are soloed." title="Solo safe: stay audible when other tracks are soloed." onClick={(event) => { event.stopPropagation(); store.updateTrack(track.id, { soloSafe: !track.soloSafe }) }}>
          <span className="arm-full">Safe</span>
          <span className="arm-stack">
            <span className="arm-short">Sf</span>
            <small className="mode-caption">Safe</small>
          </span>
        </button>
      )}
    </>
  )
}

export function LinkGroup({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const groups = mixGroupsOf(store.project)
  const groupId = trackGroupId(store.project, trackId)
  const group = groups.find((item) => item.id === groupId)
  const linkLabel = group?.name ?? 'No link'
  return (
    <div className="link-row">
      <BevelSelect
        className="link-pick"
        label="Link group"
        hint={`Link group. ${linkLabel}`}
        value={groupId ?? ''}
        options={[
          { value: '', label: 'No link' },
          ...groups.map((item) => ({ value: item.id, label: item.name })),
          { value: 'new', label: 'New link' },
        ]}
        onChange={(next) => store.assignMixGroup(trackId, next)}
      />
      {group && (
        <>
          <Flag store={store} groupId={group.id} on={group.faders} flag="faders" label="Faders" title="Move faders and pans by the same amount." />
          <Flag store={store} groupId={group.id} on={group.mutes} flag="mutes" label="Mutes" title="Mute and unmute the linked tracks together." />
          <Flag store={store} groupId={group.id} on={group.solos} flag="solos" label="Solos" title="Solo and unsolo the linked tracks together." />
          <Flag store={store} groupId={group.id} on={group.edits} flag="edits" label="Edits" title="Move, trim, and split overlapping clips together." />
        </>
      )}
    </div>
  )
}

function Flag({ store, groupId, on, flag, label, title }: { store: ProjectStore; groupId: string; on: boolean; flag: 'faders' | 'mutes' | 'solos' | 'edits'; label: string; title: string }) {
  return (
    <button type="button" className={on ? 'on' : ''} aria-pressed={on} title={title} onClick={() => store.setMixLink(groupId, { [flag]: !on })}>
      {label}
    </button>
  )
}

export function LanePicker({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const choices = laneChoices(store.project, trackId)
  if (!store.openLanes[trackId] || !choices.length) return null
  const value = store.laneChoice[trackId] || choices[0].key
  return (
    <select className="auto-pick" aria-label="Automation lane" title="Choose which control this lane draws." value={value} onClick={(event) => event.stopPropagation()} onChange={(event) => store.chooseLane(trackId, event.target.value)}>
      {choices.map((choice) => (
        <option key={choice.key} value={choice.key}>{choice.label}</option>
      ))}
    </select>
  )
}

function useShownValue(store: ProjectStore, engine: AudioEngine, spec: AutoSpec, value: number) {
  const [sample, setSample] = useState(engine.positionSamples)
  const [status, setStatus] = useState(engine.status)
  useEffect(
    () =>
      engine.subscribe(() => {
        setSample(engine.positionSamples)
        setStatus(engine.status)
      }),
    [engine],
  )
  const rolling = status === 'playing' || status === 'recording'
  const mode = channelAutomationMode(store.project, spec.trackId === 'master' ? 'master' : spec.trackId)
  const shown = rolling && mode === 'read' ? automatedValue(store.project, spec, sample, value) : value
  return { rolling, shown: Number.isFinite(shown) ? shown : value }
}

export function panWords(value: number) {
  if (Math.abs(value) < 0.02) return 'Center'
  if (value < 0) return `Left ${Math.round(-value * 100)}`
  return `Right ${Math.round(value * 100)}`
}

export function AutoFader({ store, engine, spec, value, label, className, vertical: verticalProp, readout = false }: { store: ProjectStore; engine: AudioEngine; spec: AutoSpec; value: number; label: string; className?: string; vertical?: boolean; readout?: boolean }) {
  const { rolling, shown } = useShownValue(store, engine, spec, value)
  const span = spec.max - spec.min
  const vertical = verticalProp ?? className !== 'pan'
  const db = gainToDb(shown)
  return (
    <>
      <TouchSlider
        label={label}
        title={label}
        className={className}
        vertical={vertical}
        min={spec.min}
        max={spec.max}
        step={span <= 2 ? 0.01 : span <= 40 ? 0.1 : 1}
        value={shown}
        fallback={controlDefault({ label, className, param: spec.param, target: spec.target, min: spec.min, max: spec.max }) ?? spec.min}
        format={readout ? gainToDb : undefined}
        matchLength={readout}
        valueText={readout ? db : undefined}
        onStart={() => store.beginAutomationTouch()}
        onCommit={() => store.endAutomationTouch()}
        onChange={(next) => store.setAutomated(spec, next, rolling, engine.currentTimelineSample())}
      />
      {readout && <span className="fader-db">{db}</span>}
    </>
  )
}

/** Small pan knob. Drag right to pan right. Shift, or a second finger, moves in finer steps. */
export function PanKnob({ store, engine, spec, value, label }: { store: ProjectStore; engine: AudioEngine; spec: AutoSpec; value: number; label: string }) {
  const { rolling, shown } = useShownValue(store, engine, spec, value)
  const { ref, readout, dragging } = useDragValue<HTMLButtonElement>({
    min: spec.min,
    max: spec.max,
    value: shown,
    fallback: 0,
    axis: 'x',
    format: panWords,
    onStart: () => store.beginAutomationTouch(),
    onCommit: () => store.endAutomationTouch(),
    onChange: (next) => store.setAutomated(spec, next, rolling, engine.currentTimelineSample()),
  })
  const unit = Math.max(0, Math.min(1, (shown - spec.min) / ((spec.max - spec.min) || 1)))
  const angle = -140 + unit * 280
  const words = panWords(shown)
  return (
    <div className={`pan-knob-wrap${dragging ? ' dragging' : ''}`}>
      <button
        ref={ref}
        type="button"
        className="pan-knob"
        role="slider"
        aria-label={label}
        title={label}
        aria-valuemin={spec.min}
        aria-valuemax={spec.max}
        aria-valuenow={Math.round(shown * 100) / 100}
        aria-valuetext={words}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          const span = spec.max - spec.min || 1
          const step = event.shiftKey ? span / 200 : span / 40
          const write = (next: number) => {
            store.beginAutomationTouch()
            store.setAutomated(spec, Math.max(spec.min, Math.min(spec.max, next)), rolling, engine.currentTimelineSample())
            store.endAutomationTouch()
          }
          if (event.key === 'ArrowUp' || event.key === 'ArrowRight') write(shown + step)
          if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') write(shown - step)
          if (event.key === 'Home') write(spec.min)
          if (event.key === 'End') write(spec.max)
        }}
      >
        <i style={{ transform: `rotate(${angle}deg)` }} />
        <span className="pan-state">{words}</span>
      </button>
      <GestureReadout readout={readout} />
    </div>
  )
}

export function AutomationOverlay({ store, trackId, px, tool }: { store: ProjectStore; trackId: string; px: number; tool: ArrangeTool }) {
  const svg = useRef<SVGSVGElement>(null)
  const project = store.project
  const choices = laneChoices(project, trackId)
  const choice = choices.find((item) => item.key === (store.laneChoice[trackId] || choices[0]?.key))
  if (!store.openLanes[trackId] || !choice) return null
  const points = lanePoints(project, choice.spec)
  const height = 76
  const span = choice.spec.max - choice.spec.min || 1
  const xOf = (beat: number) => ((beat * 60) / project.tempo) * px
  const yOf = (value: number) => (1 - (value - choice.spec.min) / span) * height
  const line = points.map((point) => `${xOf(point.beat)},${yOf(point.value)}`).join(' ')

  function at(event: { clientX: number; clientY: number }) {
    const rect = svg.current?.getBoundingClientRect()
    if (!rect) return { beat: 0, value: choice!.spec.min }
    const beat = Math.max(0, ((event.clientX - rect.left) / px) * (project.tempo / 60))
    const t = 1 - Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)))
    return { beat, value: choice!.spec.min + t * span }
  }

  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (tool === 'pan' || tool === 'zoom' || tool === 'box' || tool === 'trim') return
    event.stopPropagation()
    const spec = choice!.spec
    const start = at(event)
    if (tool === 'pencil') store.paintAutomation(spec, start.beat, start.value)
    if (tool === 'erase') store.eraseAutomation(spec, start.beat, Math.max(0.05, 12 / Math.max(8, px)))
    let from = nearest(points, start.beat)
    const move = (ev: PointerEvent) => {
      const next = at(ev)
      if (tool === 'pencil') store.paintAutomation(spec, next.beat, next.value)
      if (tool === 'erase') store.eraseAutomation(spec, next.beat, Math.max(0.05, 12 / Math.max(8, px)))
      if (tool === 'select' && from != null) {
        store.moveAutomationPoint(spec, from, next.beat, next.value)
        from = next.beat
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <svg ref={svg} className="auto-lane" aria-label={`${choice.label} automation`} onPointerDown={down}>
      {line && <polyline points={line} />}
      {points.map((point) => (
        <circle key={`${point.beat}:${point.value}`} cx={xOf(point.beat)} cy={yOf(point.value)} r={3.5} />
      ))}
    </svg>
  )
}

function nearest(points: { beat: number }[], beat: number) {
  let best: number | null = null
  let dist = 0.2
  for (const point of points) {
    const delta = Math.abs(point.beat - beat)
    if (delta < dist) {
      dist = delta
      best = point.beat
    }
  }
  return best
}

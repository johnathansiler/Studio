import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { ArrangeTool } from '../state/tools'
import type { AutoSpec } from '../model/automation'
import { automatedValue, automationWriteMode, laneChoices, lanePoints, mixGroupsOf, trackGroupId } from '../state/select'
import type { ProjectStore } from '../state/store'
import type { AutomationWriteMode } from '../model/types'
import './automation.css'

const MODES: { id: AutomationWriteMode; label: string; title: string }[] = [
  { id: 'read', label: 'Read', title: 'Read automation while playing. Controls follow the lane.' },
  { id: 'latch', label: 'Latch', title: 'Latch writes the value you set until playback stops.' },
  { id: 'touch', label: 'Touch', title: 'Touch writes only while you hold the control.' },
]

export function AutomationModeBar({ store }: { store: ProjectStore }) {
  const mode = automationWriteMode(store.project)
  return (
    <div className="auto-mode" role="group" aria-label="Automation write mode">
      {MODES.map((item) => (
        <button key={item.id} type="button" className={mode === item.id ? 'on' : ''} aria-pressed={mode === item.id} title={item.title} onClick={() => store.setAutomationMode(item.id)}>
          {item.label}
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

export function MixFlags({ store, trackId, compact = false }: { store: ProjectStore; trackId: string; compact?: boolean }) {
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!track) return null
  return (
    <>
      <button type="button" className={`mini ${track.mute ? 'on-m' : ''}`} aria-label={track.mute ? 'Unmute track' : 'Mute track'} title="Mute this track. Linked tracks mute together." onClick={(event) => { event.stopPropagation(); store.toggleTrack(track.id, 'mute') }}>M</button>
      <button type="button" className={`mini ${track.solo ? 'on-s' : ''}`} aria-label={track.solo ? 'Unsolo track' : 'Solo track'} title="Solo this track and keep its path to the master open." onClick={(event) => { event.stopPropagation(); store.toggleTrack(track.id, 'solo') }}>S</button>
      {!compact && (
        <button type="button" className={`mini solo-safe ${track.soloSafe ? 'on' : ''}`} aria-pressed={!!track.soloSafe} aria-label="Solo safe" title="Solo safe: stay audible when other tracks are soloed." onClick={(event) => { event.stopPropagation(); store.updateTrack(track.id, { soloSafe: !track.soloSafe }) }}>Safe</button>
      )}
    </>
  )
}

export function LinkGroup({ store, trackId }: { store: ProjectStore; trackId: string }) {
  const groups = mixGroupsOf(store.project)
  const groupId = trackGroupId(store.project, trackId)
  const group = groups.find((item) => item.id === groupId)
  return (
    <div className="link-row">
      <select className="link-pick" aria-label="Link group" title="Link faders, mutes, solos, and edits with other tracks." value={groupId ?? ''} onClick={(event) => event.stopPropagation()} onChange={(event) => store.assignMixGroup(trackId, event.target.value)}>
        <option value="">No link</option>
        {groups.map((item) => (
          <option key={item.id} value={item.id}>{item.name}</option>
        ))}
        <option value="new">New link</option>
      </select>
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

export function AutoFader({ store, engine, spec, value, label, className }: { store: ProjectStore; engine: AudioEngine; spec: AutoSpec; value: number; label: string; className?: string }) {
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
  const mode = automationWriteMode(store.project)
  const shown = rolling && mode === 'read' ? automatedValue(store.project, spec, sample, value) : value
  const span = spec.max - spec.min
  return (
    <input
      aria-label={label}
      title={label}
      className={className}
      type="range"
      min={spec.min}
      max={spec.max}
      step={span <= 2 ? 0.01 : span <= 40 ? 0.1 : 1}
      value={Number.isFinite(shown) ? shown : value}
      onPointerDown={() => store.beginAutomationTouch()}
      onPointerUp={() => store.endAutomationTouch()}
      onPointerCancel={() => store.endAutomationTouch()}
      onChange={(event) => store.setAutomated(spec, Number(event.target.value), rolling, engine.currentTimelineSample())}
    />
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

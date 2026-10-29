import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { gridPaint, type GridLine } from '../model/gridLines'
import { useFormFactor } from './form'
import { displayedPlayhead } from '../model/transportSync'
import { projectSampleBeat } from '../model/tempoMap'
import {
  gateForDuration,
  laneLabel,
  patternPlayBeat,
  patternToLaneNotes,
  stepFromBeat,
  type LaneNote,
} from '../model/patternMidi'
import { stepGroups } from '../model/channelRack'
import { STEP_BEAT, channelSteps, channelSwing, stepStart } from '../model/steps'
import type { ProjectStore } from '../state/store'
import './drumRoll.css'

type RollEngine = {
  positionSamples: number
  subscribe?: (fn: () => void) => () => void
}

/** The step pattern as one row per drum lane. Columns match the step grid above. */
export function DrumRoll({ store, engine }: { store: ProjectStore; engine: RollEngine }) {
  const project = store.project
  const pattern = store.activePattern()
  const [playhead, setPlayhead] = useState(engine.positionSamples)
  const [selected, setSelected] = useState<string | null>(null)
  const dragRef = useRef<{ cancel: () => void } | null>(null)
  useEffect(() => engine.subscribe?.(() => setPlayhead(engine.positionSamples)), [engine])
  if (!pattern) return null
  const notes = patternToLaneNotes(pattern)
  const count = Math.max(1, pattern.steps)
  const length = Math.max(STEP_BEAT, count * STEP_BEAT)
  const groups = stepGroups(count)
  const beat = projectSampleBeat(project, displayedPlayhead(playhead, project))
  const head = patternPlayBeat(beat, pattern.steps)

  function commit(next: LaneNote[]) {
    store.writeLaneNotes(next)
  }

  function keyOf(note: LaneNote) {
    return `${note.channelId}:${note.step}`
  }

  function addAt(channelId: string, clientX: number, grid: HTMLElement) {
    const channel = pattern!.channels.find((item) => item.id === channelId)
    if (!channel) return
    const slots = [...grid.querySelectorAll<HTMLElement>('.drum-slot')]
    let step = 0
    let slot = slots[0]
    for (const item of slots) {
      const box = item.getBoundingClientRect()
      step = Number(item.dataset.index)
      slot = item
      if (clientX <= box.right) break
    }
    if (!slot || !Number.isInteger(step)) return
    const channelCount = channelSteps(channel, count)
    const swing = channelSwing(channel, pattern!.swing)
    if (notes.some((note) => note.channelId === channelId && note.step === step)) return
    const box = slot.getBoundingClientRect()
    const origin = stepStart(step, STEP_BEAT, swing)
    const nextBeat = step + 1 < count ? stepStart(step + 1, STEP_BEAT, swing) : length
    const span = Math.max(0.02, nextBeat - origin)
    const t = Math.max(0, Math.min(0.98, (clientX - box.left) / Math.max(1, box.width)))
    const at = origin + t * span
    const placed = stepFromBeat(at, channelCount, swing)
    const durationBeats = Math.min(0.2, span * 0.8)
    const gate = gateForDuration(placed.step, channelCount, swing, placed.nudge, durationBeats)
    commit([
      ...notes,
      {
        channelId,
        step: placed.step,
        pitch: channel.note,
        pitchOffset: 0,
        startBeat: at,
        durationBeats,
        velocity: 0.8,
        soundVelocity: 0.8,
        pan: 0,
        fine: 0,
        nudge: placed.nudge,
        gate,
      },
    ])
  }

  function drag(note: LaneNote, event: ReactPointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    const channel = pattern!.channels.find((item) => item.id === note.channelId)
    if (!channel) return
    const channelCount = channelSteps(channel, count)
    const swing = channelSwing(channel, pattern!.swing)
    const slot = (event.currentTarget as HTMLElement).closest('.drum-slot') as HTMLElement | null
    const originBeat = stepStart(note.step, STEP_BEAT, swing)
    const nextBeat = note.step + 1 < channelCount ? stepStart(note.step + 1, STEP_BEAT, swing) : length
    const span = Math.max(0.02, nextBeat - originBeat)
    const px = Math.max(1, (slot?.getBoundingClientRect().width ?? 28) / span)
    const originX = event.clientX
    const originY = event.clientY
    const startBeat = note.startBeat
    const originVel = note.velocity
    setSelected(keyOf(note))
    let latest = note
    let moved = false
    let cancelled = false
    dragRef.current = { cancel: () => { cancelled = true } }
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - originX, ev.clientY - originY) > 3) moved = true
      const dBeat = (ev.clientX - originX) / px
      const velocity = Math.max(0.05, Math.min(1, originVel + (originY - ev.clientY) / 90))
      const placed = stepFromBeat(Math.max(0, startBeat + dBeat), channelCount, swing)
      const gate = gateForDuration(placed.step, channelCount, swing, placed.nudge, note.durationBeats)
      latest = { ...note, step: placed.step, startBeat: Math.max(0, startBeat + dBeat), nudge: placed.nudge, velocity, gate }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      dragRef.current = null
      if (cancelled || !moved) return
      const next = notes
        .filter((item) => keyOf(item) !== keyOf(note))
        .filter((item) => !(item.channelId === latest.channelId && item.step === latest.step))
      next.push(latest)
      commit(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  function remove(note: LaneNote) {
    dragRef.current?.cancel()
    commit(notes.filter((item) => keyOf(item) !== keyOf(note)))
    setSelected(null)
  }

  const form = useFormFactor()
  const stepPx = form === 'phone' ? 44 : 36
  const rollPaint = gridPaint(project, stepPx / STEP_BEAT)
  const headPlace = stepFromBeat(Math.max(0, Math.min(length - 0.001, head)), count, 0)
  const headOrigin = stepStart(headPlace.step, STEP_BEAT, 0)
  const headNext = headPlace.step + 1 < count ? stepStart(headPlace.step + 1, STEP_BEAT, 0) : length
  const headLeft = ((head - headOrigin) / Math.max(0.02, headNext - headOrigin)) * 100

  return (
    <div className="drum-roll" data-drum-roll="open" aria-label="Drum roll. Each row is a drum lane.">
      <p className="drum-roll-title">Roll</p>
      {rollPaint.hint && <p className="grid-hint" role="status">{rollPaint.hint}</p>}
      {pattern.channels.map((channel) => {
        const lane = notes.filter((note) => note.channelId === channel.id)
        const swing = channelSwing(channel, pattern.swing)
        return (
          <div className={`rack-row drum-lane${store.selectedRackChannels.includes(channel.id) ? ' on' : ''}`} key={channel.id} data-lane={channel.id}>
            <button type="button" className={`rack-lead drum-lane-name${store.selectedRackChannels.includes(channel.id) ? ' on' : ''}`} title={laneLabel(channel)} onClick={() => store.selectRackChannel(channel.id)}>
              {laneLabel(channel)}
            </button>
            <div
              className="rack-steps drum-lane-grid"
              onPointerDown={(event) => {
                if ((event.target as HTMLElement).closest('.drum-note')) return
                addAt(channel.id, event.clientX, event.currentTarget)
              }}
            >
              {groups.map((group, groupIndex) => (
                <div className={`rack-group${groupIndex % 2 ? ' alt' : ''}`} key={group[0]}>
                  {group.map((index) => {
                    const note = lane.find((item) => item.step === index)
                    const origin = stepStart(index, STEP_BEAT, swing)
                    const nextBeat = index + 1 < count ? stepStart(index + 1, STEP_BEAT, swing) : length
                    const span = Math.max(0.02, nextBeat - origin)
                    const box = note
                      ? {
                          left: ((note.startBeat - origin) / span) * 100,
                          width: Math.max(18, (note.durationBeats / span) * 100),
                        }
                      : null
                    return (
                      <div className={`drum-slot${slotGrid(index, rollPaint.lines)}`} data-index={index} key={index}>
                        {headPlace.step === index && (
                          <i className="drum-playhead" data-playhead="drums" style={{ left: `${headLeft}%` }} />
                        )}
                        {note && box && (
                          <button
                            type="button"
                            className={`drum-note${selected === keyOf(note) ? ' on' : ''}`}
                            style={{
                              left: `${box.left}%`,
                              width: `${box.width}%`,
                              height: `${Math.max(18, note.velocity * 100)}%`,
                            }}
                            title={`${laneLabel(channel)}. Velocity ${Math.round(note.velocity * 127)}. Drag sideways to move, up to change velocity.`}
                            aria-label={`${laneLabel(channel)} step ${note.step + 1}`}
                            onPointerDown={(event) => drag(note, event)}
                            onDoubleClick={(event) => {
                              event.stopPropagation()
                              remove(note)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Delete' || event.key === 'Backspace') remove(note)
                            }}
                          />
                        )}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function slotGrid(index: number, lines: GridLine[]) {
  const beat = index * STEP_BEAT
  const rank: Record<GridLine['role'], number> = { snap: 1, beat: 2, bar: 3 }
  let best: GridLine['role'] | null = null
  for (const line of lines) {
    if (!(line.beats > 0)) continue
    const steps = beat / line.beats
    if (Math.abs(steps - Math.round(steps)) > 1e-3) continue
    if (!best || rank[line.role] > rank[best]) best = line.role
  }
  return best ? ` grid-${best}` : ''
}

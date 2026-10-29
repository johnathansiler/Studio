import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
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
import { STEP_BEAT, channelSteps, channelSwing } from '../model/steps'
import type { ProjectStore } from '../state/store'
import './drumRoll.css'

type RollEngine = {
  positionSamples: number
  subscribe?: (fn: () => void) => () => void
}

/** The step pattern as one row per drum lane. Edits write back through the same note map. */
export function DrumRoll({ store, engine }: { store: ProjectStore; engine: RollEngine }) {
  const project = store.project
  const pattern = store.activePattern()
  const [playhead, setPlayhead] = useState(engine.positionSamples)
  const [selected, setSelected] = useState<string | null>(null)
  const dragRef = useRef<{ cancel: () => void } | null>(null)
  useEffect(() => engine.subscribe?.(() => setPlayhead(engine.positionSamples)), [engine])
  if (!pattern) return null
  const notes = patternToLaneNotes(pattern)
  const length = Math.max(STEP_BEAT, pattern.steps * STEP_BEAT)
  const px = 64
  const width = Math.max(240, length * px)
  const beat = projectSampleBeat(project, displayedPlayhead(playhead, project))
  const head = patternPlayBeat(beat, pattern.steps)

  function commit(next: LaneNote[]) {
    store.writeLaneNotes(next)
  }

  function keyOf(note: LaneNote) {
    return `${note.channelId}:${note.step}`
  }

  function addAt(channelId: string, clientX: number, row: HTMLElement) {
    const channel = pattern!.channels.find((item) => item.id === channelId)
    if (!channel) return
    const count = channelSteps(channel, pattern!.steps)
    const swing = channelSwing(channel, pattern!.swing)
    const rect = row.getBoundingClientRect()
    const at = Math.max(0, Math.min(length - 0.02, ((clientX - rect.left) / Math.max(1, rect.width)) * length))
    const placed = stepFromBeat(at, count, swing)
    if (notes.some((note) => note.channelId === channelId && note.step === placed.step)) return
    const durationBeats = 0.2
    const gate = gateForDuration(placed.step, count, swing, placed.nudge, durationBeats)
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
    const count = channelSteps(channel, pattern!.steps)
    const swing = channelSwing(channel, pattern!.swing)
    const originX = event.clientX
    const originY = event.clientY
    const originBeat = note.startBeat
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
      const placed = stepFromBeat(Math.max(0, originBeat + dBeat), count, swing)
      const gate = gateForDuration(placed.step, count, swing, placed.nudge, note.durationBeats)
      latest = { ...note, step: placed.step, startBeat: Math.max(0, originBeat + dBeat), nudge: placed.nudge, velocity, gate }
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

  return (
    <div className="drum-roll" data-drum-roll="open" aria-label="Drum roll. Each row is a drum lane.">
      <div className="drum-roll-scroll">
        <div
          className="drum-roll-sheet"
          style={{ ['--timeline' as string]: `${width}px`, ['--head' as string]: `${(head / length) * width}px` }}
        >
          <div className="drum-playhead" data-playhead="drums" />
          {pattern.channels.map((channel) => {
            const lane = notes.filter((note) => note.channelId === channel.id)
            return (
              <div className="drum-lane" key={channel.id} data-lane={channel.id}>
                <button type="button" className="drum-lane-name" title={laneLabel(channel)} onClick={() => store.selectRackChannel(channel.id)}>
                  {laneLabel(channel)}
                </button>
                <div
                  className="drum-lane-grid"
                  style={{ backgroundSize: `${STEP_BEAT * px}px 100%` }}
                  onPointerDown={(event) => {
                    if ((event.target as HTMLElement).closest('.drum-note')) return
                    addAt(channel.id, event.clientX, event.currentTarget)
                  }}
                >
                  {lane.map((note) => (
                    <button
                      key={keyOf(note)}
                      type="button"
                      className={`drum-note${selected === keyOf(note) ? ' on' : ''}`}
                      style={{
                        left: note.startBeat * px,
                        width: Math.max(8, note.durationBeats * px),
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
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
import type { AudioEngine } from '../audio/engine'
import {
  GRAPH_LABELS,
  graphRatio,
  kitChoices,
  libraryChoice,
  rackPlayIndex,
  RACK_COLORS,
  stepGroups,
  stepLooks,
  valueFromRatio,
  type GraphMode,
  type RackChoice,
} from '../model/channelRack'
import { type StepCell, type StepChannel } from '../model/steps'
import { projectSampleBeat } from '../model/tempoMap'
import { fetchSoundBytes } from '../sounds/cache'
import { catalogMessage, loadSoundCatalog } from '../sounds/catalog'
import { decodeSoundBytes, matchProjectRate } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import { selectBeats } from '../state/select'
import type { ProjectStore } from '../state/store'
import { BEAT_BAR, BEAT_ROW, BEAT_SHEET, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { TipButton } from './Hint'
import './channel-rack.css'

type RackEngine = {
  positionSamples: number
  status?: AudioEngine['status']
  subscribe?: (fn: () => void) => () => void
  currentTimelineSample?: () => number
}

function usePlaySample(engine: RackEngine) {
  const [live, setLive] = useState<number | null>(null)
  useEffect(() => {
    if (!engine.subscribe) return
    const read = () => {
      setLive(engine.positionSamples)
    }
    read()
    return engine.subscribe(read)
  }, [engine])
  return live ?? engine.positionSamples
}

function graphBounds(mode: GraphMode) {
  if (mode === 'pan') return { min: -1, max: 1 }
  if (mode === 'pitch') return { min: -12, max: 12 }
  return { min: 0.05, max: 1 }
}

function graphNow(mode: GraphMode, cell: Pick<StepCell, 'velocity' | 'pan' | 'pitch' | 'gate'>) {
  if (mode === 'pan') return cell.pan
  if (mode === 'pitch') return cell.pitch
  if (mode === 'gate') return cell.gate
  return cell.velocity
}

function knobAngle(value: number, min: number, max: number) {
  const span = max - min || 1
  const t = Math.max(0, Math.min(1, (value - min) / span))
  return -140 + t * 280
}

function Knob({
  label,
  hint,
  min,
  max,
  step,
  value,
  onChange,
  onDone,
}: {
  label: string
  hint: string
  min: number
  max: number
  step: number
  value: number
  onChange: (next: number, drag: boolean) => void
  onDone: () => void
}) {
  const drag = useRef<{ y: number; value: number } | null>(null)
  const set = (next: number, fromDrag: boolean) => {
    const snapped = Math.round(Math.max(min, Math.min(max, next)) / step) * step
    onChange(Number(snapped.toFixed(2)), fromDrag)
  }
  return (
    <button
      type="button"
      className="rack-knob"
      role="slider"
      title={`${label}. ${hint}`}
      aria-label={`${label}. ${hint}`}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Number(value.toFixed(2))}
      onPointerDown={(event) => {
        drag.current = { y: event.clientY, value }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        const delta = (drag.current.y - event.clientY) / 90
        set(drag.current.value + delta * (max - min), true)
      }}
      onPointerUp={() => {
        drag.current = null
        onDone()
      }}
      onPointerCancel={() => {
        drag.current = null
        onDone()
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' || event.key === 'ArrowRight') set(value + step, false)
        if (event.key === 'ArrowDown' || event.key === 'ArrowLeft') set(value - step, false)
      }}
    >
      <i style={{ transform: `rotate(${knobAngle(value, min, max)}deg)` }} />
    </button>
  )
}

function StepButtons({
  channel,
  cells,
  count,
  playStep,
  onPaint,
  onDone,
}: {
  channel: StepChannel
  cells: StepCell[]
  count: number
  playStep: number
  onPaint: (index: number, on: boolean) => void
  onDone: () => void
}) {
  const painting = useRef<{ on: boolean; touch: boolean; x: number; y: number; index: number } | null>(null)
  const paintAt = (event: ReactPointerEvent<HTMLDivElement>, force: boolean) => {
    const hit = document.elementFromPoint(event.clientX, event.clientY)
    const step = hit?.closest('.rack-step') as HTMLElement | null
    if (!step || !event.currentTarget.contains(step)) return
    const index = Number(step.dataset.index)
    if (!painting.current) return
    if (painting.current.touch && !force) return
    onPaint(index, painting.current.on)
  }
  return (
    <div
      className="rack-steps"
      role="group"
      aria-label={`${channel.name} steps. Tap a pad to add a hit. Drag to paint.`}
      onPointerDown={(event) => {
        const step = (event.target as HTMLElement).closest('.rack-step') as HTMLElement | null
        if (!step) return
        const index = Number(step.dataset.index)
        const touch = event.pointerType === 'touch'
        const on = !channel.cells[index]?.on
        painting.current = { on, touch, x: event.clientX, y: event.clientY, index }
        if (!touch) {
          event.preventDefault()
          onPaint(index, on)
          event.currentTarget.setPointerCapture(event.pointerId)
        }
      }}
      onPointerMove={(event) => {
        if (!painting.current || painting.current.touch) return
        paintAt(event, false)
      }}
      onPointerUp={(event) => {
        const gesture = painting.current
        painting.current = null
        if (gesture?.touch && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 12) onPaint(gesture.index, gesture.on)
        onDone()
      }}
      onPointerCancel={() => {
        painting.current = null
        onDone()
      }}
    >
      {stepGroups(count).map((group, groupIndex) => (
        <div className={`rack-group${groupIndex % 2 ? ' alt' : ''}`} key={group[0]}>
          {group.map((index) => {
            const cell = cells[index]
            const on = !!cell?.on
            const look = stepLooks(index, channel.steps, count)
            const now = playStep === index
            const className = [
              'rack-step',
              on ? 'on' : '',
              now ? 'now' : '',
              look.past ? 'past' : '',
              look.loop ? 'loop' : '',
            ].filter(Boolean).join(' ')
            const action = look.past ? 'Outside this row\'s loop. Tap to extend it and add a hit.' : 'Tap to add a hit.'
            return (
              <button
                key={index}
                type="button"
                data-index={index}
                className={className}
                style={on ? { background: channel.color } : undefined}
                aria-label={`${channel.name} step ${index + 1}. ${action}`}
                aria-pressed={on}
                aria-current={now ? 'step' : undefined}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

export function ChannelRack({ store, engine }: { store: ProjectStore; engine: RackEngine }) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const beatState = selectBeats(store)
  const project = beatState.project
  const pattern = beatState.pattern
  const sample = usePlaySample(engine)
  const [graph, setGraph] = useState(false)
  const [graphMode, setGraphMode] = useState<GraphMode>('velocity')
  const [editOpen, setEditOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [graphId, setGraphId] = useState<string | null>(null)
  const [picked, setPicked] = useState<{ channelId: string; index: number } | null>(null)
  const [library, setLibrary] = useState<SoundEntry[]>([])
  const [libraryNote, setLibraryNote] = useState('')
  const asked = useRef(false)
  const graphing = useRef(false)
  const phone = useFormFactor() === 'phone'
  const bar = (id: string) => copyOf(BEAT_BAR, id)
  const rowCopy = (id: string) => copyOf(BEAT_ROW, id)
  const sheet = (id: string) => copyOf(BEAT_SHEET, id)

  if (!pattern) return null
  const focus = pattern.channels.find((row) => row.id === graphId) ?? pattern.channels[0]
  const pickedCell = picked ? pattern.channels.find((row) => row.id === picked.channelId)?.cells[picked.index] : undefined
  const outputs = project.tracks.filter((track) => track.type === 'bus' || track.type === 'group' || track.type === 'midi')
  const beat = projectSampleBeat(project, sample)
  const count = pattern.steps
  const soloed = pattern.channels.some((row) => row.solo)
  const toolName = graph ? `Graph · ${GRAPH_LABELS[graphMode]}` : 'Paint'
  const toolHint = graph
    ? `${focus?.name ?? 'Channel'}. Drag across the bars to set ${GRAPH_LABELS[graphMode].toLowerCase()}. Empty steps turn on.`
    : `${focus?.name ?? 'Channel'}. Tap a step to add or remove a hit.`

  function paint(channel: StepChannel, index: number, on: boolean) {
    setGraphId(channel.id)
    setPicked({ channelId: channel.id, index })
    store.setStep(channel.id, index, on)
    if (on && index >= channel.steps) store.setChannel(channel.id, { steps: Math.min(64, index + 1) }, true)
  }

  function openAdd() {
    setAdding((open) => !open)
    if (asked.current) return
    asked.current = true
    void loadSoundCatalog().then((result) => {
      const sounds = result.entries.filter((entry) => entry.type === 'instrument' || entry.type === 'one-shot').slice(0, 24)
      setLibrary(sounds)
      setLibraryNote(sounds.length ? '' : catalogMessage(result, 0, false))
    })
  }

  function addChoice(choice: RackChoice, entry?: SoundEntry) {
    const id = store.addPatternChannel(choice)
    if (id) setGraphId(id)
    setAdding(false)
    if (!entry) return
    const sampleId = choice.sampleId || ''
    if (!sampleId || store.buffers.has(sampleId)) return
    void (async () => {
      try {
        const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
        const decoded = await decodeSoundBytes(bytes)
        const channels = matchProjectRate(decoded.channels, decoded.sampleRate, store.project.sampleRate)
        if (!channels[0]?.length) {
          store.toast('That sound had no audio.', 'warn')
          return
        }
        if (!store.buffers.has(sampleId)) store.addAsset({ id: sampleId, name: entry.name, sampleRate: store.project.sampleRate, channels })
      } catch (error) {
        store.toast(error instanceof Error ? error.message : 'Could not load that sound.', 'warn')
      }
    })()
  }

  function writeGraph(index: number, ratio: number) {
    if (!focus || !Number.isFinite(index)) return
    setPicked({ channelId: focus.id, index })
    const cell = focus.cells[index]
    if (cell && !cell.on) store.setStep(focus.id, index, true)
    store.editStep(focus.id, index, valueFromRatio(graphMode, ratio), true)
    if (index >= focus.steps) store.setChannel(focus.id, { steps: Math.min(64, index + 1) }, true)
  }

  function graphFromBar(bar: HTMLElement, clientY: number) {
    const index = Number(bar.dataset.index)
    const box = bar.getBoundingClientRect()
    const ratio = box.height > 0 ? 1 - (clientY - box.top) / box.height : 0
    writeGraph(index, ratio)
  }

  function placePattern() {
    store.placePattern(Math.max(0, Math.floor(beat)))
  }

  const swing = (
    <label className="rack-swing" title={bar('swing').hint}>
      <span>Swing</span>
      <input
        {...described(bar('swing'))}
        type="range"
        min={0}
        max={0.6}
        step={0.01}
        value={pattern.swing}
        onChange={(event) => store.setPatternSwing(Number(event.target.value))}
      />
    </label>
  )

  return (
    <div className="beats channel-rack" data-length={count} data-tool={graph ? 'graph' : 'paint'}>
      <div className="rack-bar">
        <select {...described(bar('pattern'))} value={pattern.id} onChange={(event) => store.selectPattern(event.target.value)}>
          {project.beats?.patterns.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <div className="rack-lengths" role="group" aria-label={`${bar('steps').label}. ${bar('steps').hint}`}>
          <span className="rack-lengths-label">Steps</span>
          {([16, 32, 64] as const).map((length) => (
            <TipButton
              key={length}
              label={String(length)}
              hint={`Set the pattern to ${length} steps. Extra steps scroll sideways.`}
              className={count === length ? 'on' : ''}
              pressed={count === length}
              onClick={() => store.setPatternLength(length)}
            />
          ))}
        </div>
        {!phone && swing}
        <TipButton label="Graph" hint="Show the step graph for the selected channel. Drag a bar to change velocity, pan, pitch, or gate." pressed={graph} onClick={() => setGraph((open) => !open)} />
        {!phone && <TipButton label="Roll" hint="Open the selected channel in the piano roll." disabled={!focus} onClick={() => focus && store.openChannelRoll(focus.id)} />}
        {!phone && <TipButton label={sheet('place').label} hint={sheet('place').hint} onClick={placePattern} />}
        <TipButton label={bar('edit').label} hint={bar('edit').hint} pressed={editOpen} onClick={() => setEditOpen((open) => !open)} />
        <span className="rack-tool" role="status" aria-live="polite" title={toolHint}>{toolName}</span>
        <span className={`rack-loop ${project.loopEnabled ? 'on' : ''}`} data-loop={project.loopEnabled ? 'on' : 'off'} title="The song loop. It is the same region as Arrange, and the playhead wraps inside it.">
          {project.loopEnabled ? 'Loop on' : 'Loop off'}
        </span>
      </div>
      <div className={`rack-extras${editOpen ? ' open' : ''}`}>
        {phone && swing}
        {phone && <TipButton label="Roll" hint="Open the selected channel in the piano roll." disabled={!focus} onClick={() => focus && store.openChannelRoll(focus.id)} />}
        {phone && <TipButton label={sheet('place').label} hint={sheet('place').hint} onClick={placePattern} />}
        <input className="rack-name-field" {...described(bar('name'))} value={pattern.name} onChange={(event) => store.renamePattern(event.target.value)} />
        <select {...described(sheet('color'))} value={pattern.color} onChange={(event) => store.recolorPattern(event.target.value)}>
          {RACK_COLORS.map((color) => (
            <option key={color} value={color}>{color}</option>
          ))}
        </select>
        <TipButton label={sheet('clone').label} hint={sheet('clone').hint} onClick={() => store.cloneActivePattern()} />
        <TipButton label={sheet('fill-2').label} hint={sheet('fill-2').hint} onClick={() => focus && store.fillChannel(2, focus.id)}>2</TipButton>
        <TipButton label={sheet('fill-4').label} hint={sheet('fill-4').hint} onClick={() => focus && store.fillChannel(4, focus.id)}>4</TipButton>
        <TipButton label={sheet('fill-8').label} hint={sheet('fill-8').hint} onClick={() => focus && store.fillChannel(8, focus.id)}>8</TipButton>
        <TipButton label={sheet('rand').label} hint={sheet('rand').hint} onClick={() => store.randomizePattern()} />
        <TipButton label={sheet('human').label} hint={sheet('human').hint} onClick={() => store.humanizePattern()} />
        <TipButton label={sheet('left').label} hint={sheet('left').hint} onClick={() => store.shiftPattern(-1)}>‹</TipButton>
        <TipButton label={sheet('right').label} hint={sheet('right').hint} onClick={() => store.shiftPattern(1)}>›</TipButton>
        <TipButton label={sheet('slot').label} hint={sheet('slot').hint} onClick={() => store.placePatternScene(0)} />
        {focus && (
          <>
            <TipButton
              label={rowCopy('solo').label}
              hint={`${focus.name}. ${rowCopy('solo').hint}`}
              pressed={focus.solo}
              onClick={() => store.setChannel(focus.id, { solo: !focus.solo })}
            />
            <TipButton label={rowCopy('copy').label} hint={`${focus.name}. ${rowCopy('copy').hint}`} onClick={() => store.copyRow(focus.id)} />
            <TipButton label={rowCopy('paste').label} hint={`${focus.name}. ${rowCopy('paste').hint}`} onClick={() => store.pasteRow(focus.id)} />
            <label className="rack-field" title={rowCopy('output').hint}>
              <span>{focus.name}</span>
              <select
                aria-label={`${focus.name} ${rowCopy('output').label}. ${rowCopy('output').hint}`}
                title={rowCopy('output').hint}
                value={focus.output ?? ''}
                onChange={(event) => store.setChannel(focus.id, { output: event.target.value || null })}
              >
                <option value="">Track</option>
                {outputs.map((track) => (
                  <option key={track.id} value={track.id}>{track.name}</option>
                ))}
              </select>
            </label>
            {phone && (
              <label className="rack-field" title={rowCopy('pan').hint}>
                <span>Pan</span>
                <input
                  aria-label={`${focus.name} ${rowCopy('pan').label}. ${rowCopy('pan').hint}`}
                  title={rowCopy('pan').hint}
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={focus.pan}
                  onChange={(event) => store.setChannel(focus.id, { pan: Number(event.target.value) }, true)}
                  onPointerUp={() => store.endDraft()}
                  onPointerCancel={() => store.endDraft()}
                />
              </label>
            )}
            <label className="rack-field" title={rowCopy('steps').hint}>
              <span>Loop</span>
              <input
                aria-label={`${focus.name} ${rowCopy('steps').label}. ${rowCopy('steps').hint}`}
                title={rowCopy('steps').hint}
                type="number"
                min={1}
                max={64}
                value={focus.steps}
                onChange={(event) => store.setChannel(focus.id, { steps: Number(event.target.value) })}
              />
            </label>
            <label className="rack-field" title={rowCopy('swing').hint}>
              <span>Row swing</span>
              <input
                aria-label={`${focus.name} ${rowCopy('swing').label}. ${rowCopy('swing').hint}`}
                title={rowCopy('swing').hint}
                type="number"
                min={0}
                max={0.9}
                step={0.05}
                placeholder="—"
                value={focus.swing ?? ''}
                onChange={(event) => store.setChannel(focus.id, { swing: event.target.value === '' ? null : Number(event.target.value) })}
              />
            </label>
          </>
        )}
        {picked && pickedCell && (
          <label className="rack-field" title="Tune this hit in cents. Pan, pitch, and gate live on the graph.">
            <span>Fine</span>
            <input aria-label="Fine. Tune this hit in cents." title="Tune this hit in cents." type="number" min={-100} max={100} step={1} value={pickedCell.fine} onChange={(event) => store.editStep(picked.channelId, picked.index, { fine: Number(event.target.value) })} />
          </label>
        )}
      </div>
      <div className="rack-scroll">
        <div className="rack-row rack-ruler" aria-hidden="true">
          <div className="rack-lead"><span>Beat</span></div>
          <div className="rack-steps">
            {stepGroups(count).map((group, groupIndex) => (
              <div className={`rack-group${groupIndex % 2 ? ' alt' : ''}`} key={group[0]}>
                {group.map((index) => (
                  <span key={index} className="rack-tick" data-beat={index === group[0] ? String((groupIndex % 4) + 1) : undefined} />
                ))}
              </div>
            ))}
          </div>
        </div>
        {pattern.channels.map((channel) => {
          const cells = store.quantizePreview?.channels.find((row) => row.id === channel.id)?.cells ?? channel.cells
          const volume = rowCopy('volume')
          const pan = rowCopy('pan')
          const mute = rowCopy('mute')
          const audible = !channel.mute && (!soloed || channel.solo)
          const playStep = rackPlayIndex(beat, channel.steps || count, channel.swing ?? pattern.swing, audible)
          const selected = focus?.id === channel.id
          return (
            <div className={`rack-row${selected ? ' sel' : ''}`} data-channel={channel.name} key={channel.id}>
              <div className="rack-lead">
                <button
                  type="button"
                  className={`rack-mute${channel.mute ? '' : ' live'}`}
                  title={`${mute.label}. ${mute.hint}`}
                  aria-label={`${mute.label} ${channel.name}. ${mute.hint}`}
                  aria-pressed={channel.mute}
                  onClick={() => store.setChannel(channel.id, { mute: !channel.mute })}
                />
                {!phone && (
                  <Knob
                    label={`${channel.name} ${pan.label}`}
                    hint={pan.hint}
                    min={-1}
                    max={1}
                    step={0.01}
                    value={channel.pan}
                    onChange={(next, drag) => store.setChannel(channel.id, { pan: next }, drag)}
                    onDone={() => store.endDraft()}
                  />
                )}
                <Knob
                  label={`${channel.name} ${volume.label}`}
                  hint={volume.hint}
                  min={0}
                  max={1}
                  step={0.01}
                  value={channel.volume}
                  onChange={(next, drag) => store.setChannel(channel.id, { volume: next }, drag)}
                  onDone={() => store.endDraft()}
                />
                <button
                  type="button"
                  className={`rack-name${selected ? ' on' : ''}`}
                  style={{ color: channel.color }}
                  title={`Select ${channel.name}. Fills and the graph follow this channel.`}
                  aria-label={`${channel.name}. Select this channel. Fills and the graph follow it.`}
                  aria-pressed={selected}
                  onClick={() => setGraphId(channel.id)}
                >
                  {channel.name}
                </button>
              </div>
              <StepButtons
                channel={channel}
                cells={cells}
                count={count}
                playStep={playStep}
                onPaint={(index, on) => paint(channel, index, on)}
                onDone={() => store.endDraft()}
              />
            </div>
          )
        })}
        {graph && focus && (
          <div className="rack-row rack-graph" data-mode={graphMode}>
            <div className="rack-lead">
              <span className="rack-graph-name" style={{ color: focus.color }}>{focus.name}</span>
              <select
                aria-label={`Graph property for ${focus.name}. Velocity, pan, pitch, or gate.`}
                title="Velocity, pan, pitch, or gate for the selected channel."
                value={graphMode}
                onChange={(event) => setGraphMode(event.target.value as GraphMode)}
              >
                {(Object.keys(GRAPH_LABELS) as GraphMode[]).map((mode) => (
                  <option key={mode} value={mode}>{GRAPH_LABELS[mode]}</option>
                ))}
              </select>
            </div>
            <div
              className="rack-steps"
              onPointerDown={(event) => {
                const bar = (event.target as HTMLElement).closest('.rack-bar-step') as HTMLElement | null
                if (!bar) return
                if (event.pointerType !== 'touch') event.preventDefault()
                graphing.current = true
                event.currentTarget.setPointerCapture(event.pointerId)
                graphFromBar(bar, event.clientY)
              }}
              onPointerMove={(event) => {
                if (!graphing.current) return
                const hit = document.elementFromPoint(event.clientX, event.clientY)
                const bar = hit?.closest('.rack-bar-step') as HTMLElement | null
                if (!bar || !event.currentTarget.contains(bar)) return
                graphFromBar(bar, event.clientY)
              }}
              onPointerUp={() => {
                graphing.current = false
                store.endDraft()
              }}
              onPointerCancel={() => {
                graphing.current = false
                store.endDraft()
              }}
            >
              {stepGroups(count).map((group, groupIndex) => (
                <div className={`rack-group${groupIndex % 2 ? ' alt' : ''}`} key={group[0]}>
                  {group.map((index) => {
                    const cell = focus.cells[index] ?? { on: false, velocity: 0.8, pan: 0, pitch: 0, fine: 0, gate: 0.8 }
                    const ratio = graphRatio(graphMode, cell)
                    const bounds = graphBounds(graphMode)
                    const shown = graphNow(graphMode, cell)
                    const look = stepLooks(index, focus.steps, count)
                    return (
                      <div
                        key={index}
                        data-index={index}
                        tabIndex={0}
                        className={`rack-bar-step${cell.on ? '' : ' off'}${look.past ? ' past' : ''}`}
                        role="slider"
                        title={`Drag to set ${GRAPH_LABELS[graphMode].toLowerCase()}. Drag across steps to draw.`}
                        aria-label={`${focus.name} step ${index + 1} ${GRAPH_LABELS[graphMode].toLowerCase()}. Drag up or down.`}
                        aria-valuemin={bounds.min}
                        aria-valuemax={bounds.max}
                        aria-valuenow={shown}
                        onKeyDown={(event) => {
                          const delta = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 0.05 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -0.05 : 0
                          if (!delta) return
                          event.preventDefault()
                          writeGraph(index, ratio + delta)
                          store.endDraft()
                        }}
                      >
                        <span style={{ height: `${Math.round(ratio * 100)}%`, background: focus.color }} />
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <button
        type="button"
        className="rack-add"
        title="Add a channel. Choose a kit sound or a library sound."
        aria-label="Add channel. Choose a kit sound or a library sound."
        aria-expanded={adding}
        onClick={openAdd}
      >
        +
      </button>
      {adding && (
        <div className="rack-picker" role="listbox" aria-label="Sounds to add. Kit drums and library instruments.">
          <div className="rack-picker-row">
            {kitChoices().map((choice) => (
              <button
                key={`${choice.note}-${choice.name}`}
                type="button"
                title={`Add ${choice.name}.`}
                aria-label={`Add ${choice.name}. Puts a ${choice.name} row on this pattern.`}
                onClick={() => addChoice(choice)}
              >
                {choice.name}
              </button>
            ))}
          </div>
          {library.length > 0 && (
            <div className="rack-picker-row">
              {library.map((entry, index) => (
                <button
                  key={entry.id}
                  type="button"
                  title={`Add ${entry.name} from the sound library.`}
                  aria-label={`Add ${entry.name}. Puts a library sound on this pattern.`}
                  onClick={() => addChoice(libraryChoice(entry, index), entry)}
                >
                  {entry.name}
                </button>
              ))}
            </div>
          )}
          {libraryNote && <p>{libraryNote}</p>}
        </div>
      )}
    </div>
  )
}

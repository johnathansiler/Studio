import { useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { stepIndexAt } from '../model/steps'
import { samplesToBeats } from '../model/time'
import { selectBeats } from '../state/select'
import type { ProjectStore } from '../state/store'
import { BEAT_BAR, BEAT_SHEET, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { ActionSheet, TipButton } from './Hint'

const COLORS = ['#73c48f', '#ef6b6b', '#79b8d4', '#e0b15a', '#c58be0', '#f09a6a']

export function BeatView({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const beatState = selectBeats(store)
  const project = beatState.project
  const pattern = beatState.pattern
  const painting = useRef<{ channelId: string; on: boolean } | null>(null)
  const [picked, setPicked] = useState<{ channelId: string; index: number } | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const compact = useFormFactor() !== 'desk'
  if (!pattern) return null
  const pickedChannel = picked ? pattern.channels.find((row) => row.id === picked.channelId) : undefined
  const pickedCell = pickedChannel?.cells[picked?.index ?? -1]
  const outputs = project.tracks.filter((track) => track.type === 'bus' || track.type === 'group' || track.type === 'midi')
  const beat = samplesToBeats(engine.positionSamples, project.sampleRate, project.tempo)
  const bar = (id: string) => copyOf(BEAT_BAR, id)
  const sheet = (id: string) => copyOf(BEAT_SHEET, id)
  const extras = (
    <>
      <select {...described(sheet('color'))} value={pattern.color} onChange={(event) => store.recolorPattern(event.target.value)}>
        {COLORS.map((color) => (
          <option key={color} value={color}>{color}</option>
        ))}
      </select>
      <TipButton label={sheet('clone').label} hint={sheet('clone').hint} onClick={() => store.cloneActivePattern()} />
      <TipButton label={sheet('fill-2').label} hint={sheet('fill-2').hint} onClick={() => store.fillChannel(2)}>2</TipButton>
      <TipButton label={sheet('fill-4').label} hint={sheet('fill-4').hint} onClick={() => store.fillChannel(4)}>4</TipButton>
      <TipButton label={sheet('fill-8').label} hint={sheet('fill-8').hint} onClick={() => store.fillChannel(8)}>8</TipButton>
      <TipButton label={sheet('rand').label} hint={sheet('rand').hint} onClick={() => store.randomizePattern()} />
      <TipButton label={sheet('human').label} hint={sheet('human').hint} onClick={() => store.humanizePattern()} />
      <TipButton label={sheet('left').label} hint={sheet('left').hint} onClick={() => store.shiftPattern(-1)}>‹</TipButton>
      <TipButton label={sheet('right').label} hint={sheet('right').hint} onClick={() => store.shiftPattern(1)}>›</TipButton>
      <TipButton label={sheet('place').label} hint={sheet('place').hint} onClick={() => store.placePattern(Math.max(0, Math.floor(beat)))} />
      <TipButton label={sheet('slot').label} hint={sheet('slot').hint} onClick={() => store.placePatternScene(0)} />
    </>
  )
  return (
    <div className="beats">
      <div className="beat-bar">
        <select {...described(bar('pattern'))} value={pattern.id} onChange={(event) => store.selectPattern(event.target.value)}>
          {project.beats?.patterns.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <input {...described(bar('name'))} value={pattern.name} onChange={(event) => store.renamePattern(event.target.value)} />
        <input {...described(bar('steps'))} type="number" min={1} max={64} value={pattern.steps} onChange={(event) => store.setPatternSteps(Number(event.target.value))} />
        <input {...described(bar('swing'))} type="range" min={0} max={0.6} step={0.01} value={pattern.swing} onChange={(event) => store.setPatternSwing(Number(event.target.value))} />
        {compact ? <TipButton label={bar('edit').label} hint={bar('edit').hint} onClick={() => setEditOpen(true)} /> : extras}
        {!compact && picked && pickedCell && (
          <>
            <input aria-label="Velocity" type="number" min={0.05} max={1} step={0.05} value={pickedCell.velocity} onChange={(event) => store.editStep(picked.channelId, picked.index, { velocity: Number(event.target.value) })} />
            <input aria-label="Step pan" type="number" min={-1} max={1} step={0.05} value={pickedCell.pan} onChange={(event) => store.editStep(picked.channelId, picked.index, { pan: Number(event.target.value) })} />
            <input aria-label="Pitch" type="number" min={-48} max={48} step={1} value={pickedCell.pitch} onChange={(event) => store.editStep(picked.channelId, picked.index, { pitch: Number(event.target.value) })} />
            <input aria-label="Fine" type="number" min={-100} max={100} step={1} value={pickedCell.fine} onChange={(event) => store.editStep(picked.channelId, picked.index, { fine: Number(event.target.value) })} />
            <input aria-label="Gate" type="number" min={0.05} max={1} step={0.05} value={pickedCell.gate} onChange={(event) => store.editStep(picked.channelId, picked.index, { gate: Number(event.target.value) })} />
          </>
        )}
      </div>
      {compact && editOpen && (
        <ActionSheet title={bar('edit').label} hint={bar('edit').hint} onClose={() => setEditOpen(false)}>
          <div className="sheet-fields">{extras}</div>
          {picked && pickedCell && (
            <div className="sheet-fields">
              <input aria-label="Velocity. How hard this hit is." title="How hard this hit is." type="number" min={0.05} max={1} step={0.05} value={pickedCell.velocity} onChange={(event) => store.editStep(picked.channelId, picked.index, { velocity: Number(event.target.value) })} />
              <input aria-label="Step pan. Left or right for this hit." title="Left or right for this hit." type="number" min={-1} max={1} step={0.05} value={pickedCell.pan} onChange={(event) => store.editStep(picked.channelId, picked.index, { pan: Number(event.target.value) })} />
              <input aria-label="Pitch. Shift this hit up or down." title="Shift this hit up or down." type="number" min={-48} max={48} step={1} value={pickedCell.pitch} onChange={(event) => store.editStep(picked.channelId, picked.index, { pitch: Number(event.target.value) })} />
              <input aria-label="Fine. Tune this hit in cents." title="Tune this hit in cents." type="number" min={-100} max={100} step={1} value={pickedCell.fine} onChange={(event) => store.editStep(picked.channelId, picked.index, { fine: Number(event.target.value) })} />
              <input aria-label="Gate. How long this hit holds." title="How long this hit holds." type="number" min={0.05} max={1} step={0.05} value={pickedCell.gate} onChange={(event) => store.editStep(picked.channelId, picked.index, { gate: Number(event.target.value) })} />
            </div>
          )}
        </ActionSheet>
      )}
      {pattern.channels.map((channel) => {
        const count = channel.steps || pattern.steps
        const cells = store.quantizePreview?.channels.find((row) => row.id === channel.id)?.cells ?? channel.cells
        const playStep = channel.mute ? -1 : stepIndexAt(beat, count, 0.25, channel.swing ?? pattern.swing)
        return (
          <div className="beat-row" key={channel.id}>
            <button type="button" className="beat-name" style={{ color: channel.color }} title="Open this sound in the piano roll." aria-label={`${channel.name}. Open this sound in the piano roll.`} onClick={() => store.openChannelRoll(channel.id)}>{channel.name}</button>
            <button type="button" className={`mini ${channel.mute ? 'on' : ''}`} title="Silence this row." aria-label={`Mute ${channel.name}. Silence this row.`} onClick={() => store.setChannel(channel.id, { mute: !channel.mute })}>M</button>
            <button type="button" className={`mini ${channel.solo ? 'on' : ''}`} title="Hear only this row." aria-label={`Solo ${channel.name}. Hear only this row.`} onClick={() => store.setChannel(channel.id, { solo: !channel.solo })}>S</button>
            <input aria-label={`${channel.name} volume. How loud this row is.`} title="How loud this row is." type="range" min={0} max={1} step={0.01} value={channel.volume} onChange={(event) => store.setChannel(channel.id, { volume: Number(event.target.value) })} />
            <input aria-label={`${channel.name} pan. Left or right.`} title="Left or right." type="range" min={-1} max={1} step={0.01} value={channel.pan} onChange={(event) => store.setChannel(channel.id, { pan: Number(event.target.value) })} />
            <select aria-label={`${channel.name} output`} value={channel.output ?? ''} onChange={(event) => store.setChannel(channel.id, { output: event.target.value || null })}>
              <option value="">Track</option>
              {outputs.map((track) => (
                <option key={track.id} value={track.id}>{track.name}</option>
              ))}
            </select>
            <input aria-label={`${channel.name} steps`} className="step-count" type="number" min={1} max={64} value={count} onChange={(event) => store.setChannel(channel.id, { steps: Number(event.target.value) })} />
            <input
              aria-label={`${channel.name} swing`}
              className="step-count"
              type="number"
              min={0}
              max={0.9}
              step={0.05}
              placeholder="—"
              value={channel.swing ?? ''}
              onChange={(event) => store.setChannel(channel.id, { swing: event.target.value === '' ? null : Number(event.target.value) })}
            />
            <div
              className="step-grid"
              onPointerDown={(event) => {
                const step = (event.target as HTMLElement).closest('.step') as HTMLElement | null
                if (!step) return
                const index = Number(step.dataset.index)
                const on = !channel.cells[index]?.on
                painting.current = { channelId: channel.id, on }
                setPicked({ channelId: channel.id, index })
                store.setStep(channel.id, index, on)
                event.currentTarget.setPointerCapture(event.pointerId)
              }}
              onPointerMove={(event) => {
                if (!painting.current || painting.current.channelId !== channel.id) return
                const hit = document.elementFromPoint(event.clientX, event.clientY)
                const step = hit?.closest('.step') as HTMLElement | null
                if (!step || !event.currentTarget.contains(step)) return
                const index = Number(step.dataset.index)
                setPicked({ channelId: channel.id, index })
                store.setStep(channel.id, index, painting.current.on)
              }}
              onPointerUp={() => {
                painting.current = null
                store.endDraft()
              }}
              onPointerCancel={() => {
                painting.current = null
                store.endDraft()
              }}
            >
              {Array.from({ length: count }, (_, index) => {
                const cell = cells[index]
                return (
                  <button
                    key={index}
                    type="button"
                    data-index={index}
                    className={`step ${cell?.on ? 'on' : ''} ${playStep === index ? 'now' : ''}`}
                    style={cell?.on ? { background: channel.color } : undefined}
                  />
                )
              })}
            </div>
            <button type="button" className="mini" onClick={() => store.copyRow(channel.id)}>Copy</button>
            <button type="button" className="mini" onClick={() => store.pasteRow(channel.id)}>Paste</button>
          </div>
        )
      })}
    </div>
  )
}

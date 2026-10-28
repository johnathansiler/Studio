import { useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { stepIndexAt } from '../model/steps'
import { samplesToBeats } from '../model/time'
import type { ProjectStore } from '../state/store'
import { HintButton, MoreItem, MoreMenu } from './hint'

const COLORS = ['#73c48f', '#ef6b6b', '#79b8d4', '#e0b15a', '#c58be0', '#f09a6a']

export function BeatView({ store, engine, compact = false }: { store: ProjectStore; engine: AudioEngine; compact?: boolean }) {
  const project = store.project
  const pattern = store.activePattern()
  const painting = useRef<{ channelId: string; on: boolean } | null>(null)
  const [picked, setPicked] = useState<{ channelId: string; index: number } | null>(null)
  if (!pattern) return null
  const pickedChannel = picked ? pattern.channels.find((row) => row.id === picked.channelId) : undefined
  const pickedCell = pickedChannel?.cells[picked?.index ?? -1]
  const outputs = project.tracks.filter((track) => track.type === 'bus' || track.type === 'group' || track.type === 'midi')
  const beat = samplesToBeats(engine.positionSamples, project.sampleRate, project.tempo)
  return (
    <div className="beats">
      <div className="beat-bar">
        <select aria-label="Pattern" value={pattern.id} onChange={(event) => store.selectPattern(event.target.value)}>
          {project.beats?.patterns.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <input aria-label="Pattern name" value={pattern.name} onChange={(event) => store.renamePattern(event.target.value)} />
        <select aria-label="Color" value={pattern.color} onChange={(event) => store.recolorPattern(event.target.value)}>
          {COLORS.map((color) => (
            <option key={color} value={color}>{color}</option>
          ))}
        </select>
        <input aria-label="Steps" type="number" min={1} max={64} value={pattern.steps} onChange={(event) => store.setPatternSteps(Number(event.target.value))} />
        <input aria-label="Swing" title="Swing — delay the off-beats" type="range" min={0} max={0.6} step={0.01} value={pattern.swing} onChange={(event) => store.setPatternSwing(Number(event.target.value))} />
        {compact ? (
          <MoreMenu label="Pattern actions" hint="Fill, shift, and place this pattern" trigger="More">
            <MoreItem label="Clone" hint="Copy this pattern" onClick={() => store.cloneActivePattern()} />
            <MoreItem label="Fill every 2" hint="Turn on every second step" onClick={() => store.fillChannel(2)} />
            <MoreItem label="Fill every 4" hint="Turn on every fourth step" onClick={() => store.fillChannel(4)} />
            <MoreItem label="Fill every 8" hint="Turn on every eighth step" onClick={() => store.fillChannel(8)} />
            <MoreItem label="Randomize" hint="Scatter hits on this pattern" onClick={() => store.randomizePattern()} />
            <MoreItem label="Humanize" hint="Nudge timing and velocity" onClick={() => store.humanizePattern()} />
            <MoreItem label="Shift left" hint="Move every hit one step earlier" onClick={() => store.shiftPattern(-1)} />
            <MoreItem label="Shift right" hint="Move every hit one step later" onClick={() => store.shiftPattern(1)} />
            <MoreItem label="Place" hint="Drop the pattern on the timeline" onClick={() => store.placePattern(Math.max(0, Math.floor(beat)))} />
            <MoreItem label="Slot" hint="Put the pattern in the first scene" onClick={() => store.placePatternScene(0)} />
          </MoreMenu>
        ) : (
          <>
            <HintButton type="button" label="Clone" hint="Copy this pattern" onClick={() => store.cloneActivePattern()}>Clone</HintButton>
            <HintButton type="button" label="Every 2" hint="Turn on every second step" onClick={() => store.fillChannel(2)}>2</HintButton>
            <HintButton type="button" label="Every 4" hint="Turn on every fourth step" onClick={() => store.fillChannel(4)}>4</HintButton>
            <HintButton type="button" label="Every 8" hint="Turn on every eighth step" onClick={() => store.fillChannel(8)}>8</HintButton>
            <HintButton type="button" label="Random" hint="Scatter hits on this pattern" onClick={() => store.randomizePattern()}>Rand</HintButton>
            <HintButton type="button" label="Human" hint="Nudge timing and velocity" onClick={() => store.humanizePattern()}>Human</HintButton>
            <HintButton type="button" label="Shift left" hint="Move every hit one step earlier" onClick={() => store.shiftPattern(-1)}>‹</HintButton>
            <HintButton type="button" label="Shift right" hint="Move every hit one step later" onClick={() => store.shiftPattern(1)}>›</HintButton>
            <HintButton type="button" label="Place" hint="Drop the pattern on the timeline" onClick={() => store.placePattern(Math.max(0, Math.floor(beat)))}>Place</HintButton>
            <HintButton type="button" label="Slot" hint="Put the pattern in the first scene" onClick={() => store.placePatternScene(0)}>Slot</HintButton>
          </>
        )}
        {picked && pickedCell && (
          <>
            <input aria-label="Velocity" type="number" min={0.05} max={1} step={0.05} value={pickedCell.velocity} onChange={(event) => store.editStep(picked.channelId, picked.index, { velocity: Number(event.target.value) })} />
            <input aria-label="Step pan" type="number" min={-1} max={1} step={0.05} value={pickedCell.pan} onChange={(event) => store.editStep(picked.channelId, picked.index, { pan: Number(event.target.value) })} />
            <input aria-label="Pitch" type="number" min={-48} max={48} step={1} value={pickedCell.pitch} onChange={(event) => store.editStep(picked.channelId, picked.index, { pitch: Number(event.target.value) })} />
            <input aria-label="Fine" type="number" min={-100} max={100} step={1} value={pickedCell.fine} onChange={(event) => store.editStep(picked.channelId, picked.index, { fine: Number(event.target.value) })} />
            <input aria-label="Gate" type="number" min={0.05} max={1} step={0.05} value={pickedCell.gate} onChange={(event) => store.editStep(picked.channelId, picked.index, { gate: Number(event.target.value) })} />
          </>
        )}
      </div>
      {pattern.channels.map((channel) => {
        const count = channel.steps || pattern.steps
        const cells = store.quantizePreview?.channels.find((row) => row.id === channel.id)?.cells ?? channel.cells
        const playStep = channel.mute ? -1 : stepIndexAt(beat, count, 0.25, channel.swing ?? pattern.swing)
        return (
          <div className="beat-row" key={channel.id}>
            <HintButton type="button" className="beat-name" label={channel.name} hint="Open this row in the piano roll" style={{ color: channel.color }} onClick={() => store.openChannelRoll(channel.id)}>{channel.name}</HintButton>
            <HintButton type="button" className={`mini ${channel.mute ? 'on' : ''}`} label="Mute" hint={`Silence ${channel.name}`} aria-pressed={channel.mute} onClick={() => store.setChannel(channel.id, { mute: !channel.mute })}>M</HintButton>
            <HintButton type="button" className={`mini ${channel.solo ? 'on' : ''}`} label="Solo" hint={`Hear only ${channel.name}`} aria-pressed={channel.solo} onClick={() => store.setChannel(channel.id, { solo: !channel.solo })}>S</HintButton>
            <input aria-label={`${channel.name} volume`} type="range" min={0} max={1} step={0.01} value={channel.volume} onChange={(event) => store.setChannel(channel.id, { volume: Number(event.target.value) })} />
            <input aria-label={`${channel.name} pan`} type="range" min={-1} max={1} step={0.01} value={channel.pan} onChange={(event) => store.setChannel(channel.id, { pan: Number(event.target.value) })} />
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
            <HintButton type="button" className="mini" label="Copy" hint={`Copy the ${channel.name} row`} onClick={() => store.copyRow(channel.id)}>Copy</HintButton>
            <HintButton type="button" className="mini" label="Paste" hint={`Paste into the ${channel.name} row`} onClick={() => store.pasteRow(channel.id)}>Paste</HintButton>
          </div>
        )
      })}
    </div>
  )
}

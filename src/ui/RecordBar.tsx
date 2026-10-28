import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { SessionClient } from '../remote/session'
import type { ProjectStore } from '../state/store'
import { RECORD_COPY, copyOf, described } from './chrome'
import { useFormFactor } from './form'
import { ActionSheet, TipButton } from './Hint'

export function RecordBar({
  store,
  engine,
  session,
  onQuickPunch,
}: {
  store: ProjectStore
  engine: AudioEngine
  session: SessionClient
  onQuickPunch: () => void
}) {
  const project = store.project
  const record = store.recordSettings()
  const compact = useFormFactor() !== 'desk'
  const [open, setOpen] = useState(false)
  const selectedFolder = project.tracks
    .flatMap((track) => track.clips.map((clip) => ({ track, clip })))
    .find((item) => item.clip.id === store.selectedClipId && item.clip.folder)
  const selectedMidi = project.tracks
    .flatMap((track) => track.midiClips.map((clip) => ({ track, clip })))
    .find((item) => item.clip.id === store.selectedMidiClipId)
  const audioTrack = project.tracks.find((track) => track.id === store.selectedTrackId && track.type === 'audio')
  const copy = (id: string) => copyOf(RECORD_COPY, id)

  const fields = (
    <>
      <TipButton className={record.loop ? 'on' : ''} label={copy('cycle').label} hint={copy('cycle').hint} pressed={record.loop} onClick={() => {
        const next = !record.loop
        store.setRecord({ loop: next })
        if (next) store.setLoop(true, project.loopStartSample, project.loopEndSample)
      }} />
      <TipButton className={record.punchEnabled ? 'on' : ''} label={copy('punch').label} hint={copy('punch').hint} pressed={record.punchEnabled} onClick={() => store.setRecord({ punchEnabled: !record.punchEnabled, quick: false })} />
      <TipButton label={copy('in').label} hint={copy('in').hint} onClick={() => store.setRecord({ punchIn: Math.round(engine.currentTimelineSample()) })} />
      <TipButton label={copy('out').label} hint={copy('out').hint} onClick={() => store.setRecord({ punchOut: Math.round(engine.currentTimelineSample()) })} />
      <TipButton label={copy('quick').label} hint={copy('quick').hint} onClick={onQuickPunch} />
      <label title={copy('pre').hint}>
        Pre
        <input aria-label={described(copy('pre'))['aria-label']} inputMode="decimal" value={record.preRoll} onChange={(event) => store.setRecord({ preRoll: Number(event.target.value) || 0 })} />
      </label>
      <label title={copy('post').hint}>
        Post
        <input aria-label={described(copy('post'))['aria-label']} inputMode="decimal" value={record.postRoll} onChange={(event) => store.setRecord({ postRoll: Number(event.target.value) || 0 })} />
      </label>
      <select {...described(copy('unit'))} value={record.rollUnit} onChange={(event) => store.setRecord({ rollUnit: event.target.value === 'seconds' ? 'seconds' : 'bars' })}>
        <option value="bars">Bars</option>
        <option value="seconds">Seconds</option>
      </select>
      {audioTrack && (
        <select
          {...described(copy('input'))}
          value={audioTrack.input}
          onChange={(event) => store.updateTrack(audioTrack.id, { input: event.target.value })}
        >
          <option value="mic">Mic · all</option>
          <option value="mic:0">Mic 1</option>
          <option value="mic:1">Mic 2</option>
          <option value="mic:2">Mic 3</option>
          <option value="mic:3">Mic 4</option>
          <option value="none">No input</option>
          {session.state.participants
            .filter((person) => person.id !== session.state.selfId)
            .map((person) => (
              <option key={person.id} value={`remote:${person.id}`}>{person.name}</option>
            ))}
        </select>
      )}
      <select {...described(copy('midi-loop'))} value={record.midiLoop} onChange={(event) => store.setRecord({ midiLoop: event.target.value === 'merge' ? 'merge' : 'takes' })}>
        <option value="takes">MIDI takes</option>
        <option value="merge">MIDI merge</option>
      </select>
      {selectedMidi && (
        <TipButton label={copy('save-take').label} hint={copy('save-take').hint} onClick={() => store.commitMidiPass(selectedMidi.track.id, selectedMidi.clip.id, selectedMidi.clip.notes)} />
      )}
      {selectedMidi?.clip.takes && selectedMidi.clip.takes.length > 0 && (
        <select {...described(copy('midi-take'))} value={selectedMidi.clip.activeTakeId || ''} onChange={(event) => store.recallMidi(selectedMidi.track.id, selectedMidi.clip.id, event.target.value)}>
          {selectedMidi.clip.takes.map((take) => (
            <option key={take.id} value={take.id}>{take.name}</option>
          ))}
        </select>
      )}
      {selectedFolder?.clip.folder && (
        <>
          <select
            {...described(copy('comp'))}
            value={selectedFolder.clip.folder.activeCompId}
            onChange={(event) => store.recallTakeComp(selectedFolder.track.id, selectedFolder.clip.id, event.target.value)}
          >
            {selectedFolder.clip.folder.comps.map((comp) => (
              <option key={comp.id} value={comp.id}>{comp.name}</option>
            ))}
          </select>
          <TipButton label={copy('save-comp').label} hint={copy('save-comp').hint} onClick={() => store.saveTakeComp(selectedFolder.track.id, selectedFolder.clip.id)} />
          <TipButton label={copy('flatten').label} hint={copy('flatten').hint} onClick={() => store.flattenTakes(selectedFolder.track.id, selectedFolder.clip.id, false)} />
          <TipButton label={copy('merge').label} hint={copy('merge').hint} onClick={() => store.flattenTakes(selectedFolder.track.id, selectedFolder.clip.id, true)} />
        </>
      )}
    </>
  )

  if (!compact) {
    return (
      <div className="rec-bar" role="group" aria-label="Recording">
        {fields}
      </div>
    )
  }

  const options = copy('options')
  return (
    <div className="rec-bar" role="group" aria-label="Recording">
      <TipButton label={options.label} hint={options.hint} onClick={() => setOpen(true)} />
      {record.loop && <span className="tool-chip">Cycle on</span>}
      {record.punchEnabled && <span className="tool-chip">Punch on</span>}
      {open && (
        <ActionSheet title={options.label} hint={options.hint} onClose={() => setOpen(false)}>
          <div className="sheet-fields">{fields}</div>
        </ActionSheet>
      )}
    </div>
  )
}

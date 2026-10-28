import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { controlsFor } from '../instruments/engine/controls'
import { instrumentBank } from '../instruments/engine/bank'
import { programFromDef } from '../instruments/engine/program'
import type { SampleControl } from '../instruments/engine/types'
import { importInstrument, type LocalFile } from '../instruments/import'
import type { ProjectStore } from '../state/store'

async function readList(list: FileList | null): Promise<LocalFile[]> {
  if (!list?.length) return []
  const files: LocalFile[] = []
  for (const file of list) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    files.push({ name: file.name, path, bytes })
  }
  return files
}

export function SampleSheet({ store, engine, trackId, onClose }: { store: ProjectStore; engine: AudioEngine; trackId: string; onClose: () => void }) {
  const track = store.track(trackId)
  const program = track?.sampleProgram
  const [hint, setHint] = useState(program ? 'Open an SFZ, SoundFont, or Decent Sampler file from this device.' : 'This track has no sample instrument yet.')
  const [focused, setFocused] = useState<SampleControl | null>(null)
  const [busy, setBusy] = useState(false)
  if (!track || !program) return null
  const controls = controlsFor(program.def)
  const description = focused?.description || 'Samples stay in this browser. They are not uploaded.'

  async function take(list: FileList | null) {
    const files = await readList(list)
    if (!files.length) return
    setBusy(true)
    try {
      const imported = await importInstrument(files)
      const bank = instrumentBank()
      for (const sample of imported.samples) await bank.store(sample)
      const next = programFromDef(imported.def, Date.now())
      store.setSampleProgram(trackId, next)
      const missing = imported.warnings.length ? ` ${imported.warnings[0]}.` : ''
      setHint(`${imported.def.name}: ${imported.def.zones.length} zones, ${imported.samples.length} samples.${missing}`)
      engine.playSampleInstrument(trackId, [60], 0.8, 0.6)
    } catch (error) {
      setHint(error instanceof Error ? error.message : 'Could not read that instrument')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal sample-sheet" role="dialog" aria-label="Sample instrument" onClick={(event) => event.stopPropagation()}>
        <header className="sample-head">
          <h2>{program.def.name || track.name}</h2>
          <button type="button" className="text-btn" onClick={onClose}>Close</button>
        </header>
        <p>{description}</p>
        <div className="row-btns">
          <label className="text-btn file-btn">
            {busy ? 'Reading…' : 'Open instrument'}
            <input
              type="file"
              accept=".sfz,.sf2,.dspreset,.wav,.flac,audio/wav"
              multiple
              aria-label="Open instrument files"
              onChange={(event) => {
                void take(event.target.files)
                event.target.value = ''
              }}
            />
          </label>
          <label className="text-btn file-btn">
            Open folder
            <input
              type="file"
              aria-label="Open instrument folder"
              multiple
              ref={(node) => node?.setAttribute('webkitdirectory', '')}
              onChange={(event) => {
                void take(event.target.files)
                event.target.value = ''
              }}
            />
          </label>
        </div>
        <p className="face-hint">{hint}</p>
        {program.def.articulations.length > 0 && (
          <div className="sample-arts">
            {program.def.articulations.map((item) => (
              <button
                key={item.id}
                type="button"
                className={program.articulation === item.id ? 'on' : ''}
                title={item.description}
                onClick={() => store.setSampleArticulation(trackId, item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        )}
        <div className="sample-controls">
          {controls.map((control) => (
            <label key={control.id} title={control.description}>
              {control.name}
              <input
                type="range"
                min={control.min}
                max={control.max}
                step={control.step}
                aria-label={control.name}
                aria-description={control.description}
                value={program.values[control.id] ?? control.default}
                onFocus={() => setFocused(control)}
                onChange={(event) => {
                  setFocused(control)
                  store.setSampleControl(trackId, control.id, Number(event.target.value))
                }}
              />
            </label>
          ))}
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { bindLocalSamples, importInstrument } from '../audio/multisample/import'
import { fetchCatalog, fetchInstrument, STARTER_CATALOG, type LibraryEntry } from '../audio/multisample/library'
import { libraryBaseUrl } from '../audio/multisample/source'
import { selectInstrument } from '../state/select'
import type { ProjectStore } from '../state/store'
import './instrument.css'

export function LibraryPanel({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const instrument = selectInstrument(store, trackId)
  const program = instrument.program
  const [status, setStatus] = useState(program ? `${program.name} · ${program.zones.length} zones` : 'Load a starter instrument or import SFZ, SF2, or DecentSampler.')
  const [hint, setHint] = useState('Samples stay on this device or stream from Hugging Face. Nothing is hosted here.')
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<LibraryEntry[]>(STARTER_CATALOG)
  const show = (text: string) => setHint(text)

  async function loadStarter(entry: LibraryEntry) {
    setBusy(true)
    setStatus(`Downloading ${entry.name} from Hugging Face…`)
    try {
      const imported = await fetchInstrument(libraryBaseUrl(), entry)
      if (imported.pack) engine.holdLibraryPack(trackId, imported.pack)
      store.setLibrary(trackId, imported.program)
      setStatus(`${imported.program.name} · ${imported.program.zones.length} zones · samples stream per note`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  async function refreshCatalog() {
    setBusy(true)
    try {
      const next = await fetchCatalog(libraryBaseUrl())
      setCatalog(next)
      setStatus(`${next.length} instruments in the starter catalog`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Catalog failed')
    } finally {
      setBusy(false)
    }
  }

  async function onFiles(list: FileList | null) {
    const files = [...(list ?? [])]
    const preset = files.find((file) => /\.(sfz|sf2|dspreset)$/i.test(file.name))
    if (!preset) {
      setStatus('Choose an SFZ, SF2, or DecentSampler file. Wavs can be selected with it.')
      return
    }
    setBusy(true)
    setStatus(`Reading ${preset.name}…`)
    try {
      const imported = importInstrument(preset.name, await preset.arrayBuffer())
      const siblings = new Map<string, ArrayBuffer>()
      for (const file of files) {
        if (file === preset) continue
        const bytes = await file.arrayBuffer()
        siblings.set(file.name, bytes)
        const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath
        if (relative) siblings.set(relative, bytes)
      }
      const bound = bindLocalSamples(imported.program, siblings)
      if (imported.pack) engine.holdLibraryPack(trackId, imported.pack)
      engine.holdLibraryAudio(trackId, bound.assets)
      store.adoptLibrary(trackId, bound.program, bound.assets, imported.pack)
      const missing = bound.program.samples.filter((sample) => sample.url && !sample.bufferId && !sample.packId).length
      setStatus(`${bound.program.name} · ${bound.program.zones.length} zones${missing ? ` · ${missing} samples still referenced by path` : ''}`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Import failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="library-panel">
      <div className="library-row">
        {catalog.map((entry) => (
          <button
            key={entry.id}
            type="button"
            disabled={busy}
            title={entry.description}
            onPointerDown={() => show(entry.description)}
            onClick={() => void loadStarter(entry)}
          >{entry.name}</button>
        ))}
        <button type="button" disabled={busy} title="Refresh the starter list from Hugging Face. Sample files are not downloaded." onPointerDown={() => show('Refresh the starter list. Only the catalog is downloaded.')} onClick={() => void refreshCatalog()}>Catalog</button>
        <label className="library-file" title="Read an SFZ, SoundFont, or DecentSampler file from this device. The audio stays in this browser.">
          Import
          <input
            type="file"
            aria-label="Import instrument"
            accept=".sfz,.sf2,.dspreset,.wav,audio/*"
            multiple
            hidden
            onChange={(event) => {
              show('Import an SFZ, SoundFont, or DecentSampler file. Wavs selected with it are stored on this device.')
              void onFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </label>
      </div>
      {instrument.keyswitches.length > 0 && (
        <div className="instrument-switches" role="group" aria-label="Keyswitch">
          {instrument.keyswitches.map((item) => (
            <button
              key={item.key}
              type="button"
              className={instrument.activeSwitch === item.key ? 'on' : ''}
              aria-pressed={instrument.activeSwitch === item.key}
              title={`Play the ${item.label} samples until you pick another articulation.`}
              onPointerDown={() => show(`Play the ${item.label} samples.`)}
              onClick={() => store.setLibrarySwitch(trackId, item.key)}
            >{item.label}</button>
          ))}
        </div>
      )}
      <p className="library-status">{status}</p>
      <p className="instrument-hint">{hint}</p>
      {instrument.mics.length > 1 && (
        <div className="library-mics">
          {instrument.mics.map((mic) => (
            <label key={mic.id} className="instrument-mic" title={`Mix the ${mic.name} microphone. Mute silences only this position.`}>
              {mic.name}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                aria-label={`${mic.name} mic level`}
                title={`How loud the ${mic.name} microphone is.`}
                value={mic.gain}
                onPointerDown={() => show(`How loud the ${mic.name} microphone is.`)}
                onChange={(event) => store.setLibraryMic(trackId, mic.id, Number(event.target.value), mic.mute)}
              />
              <button
                type="button"
                className={`instrument-mute ${mic.mute ? 'on' : ''}`}
                aria-pressed={mic.mute}
                title={mic.mute ? `Unmute the ${mic.name} microphone.` : `Mute the ${mic.name} microphone.`}
                onClick={() => store.setLibraryMic(trackId, mic.id, mic.gain, !mic.mute)}
              >{mic.mute ? 'Muted' : 'Mute'}</button>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

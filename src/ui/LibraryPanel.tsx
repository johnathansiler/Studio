import { useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { bindLocalSamples, importInstrument } from '../audio/multisample/import'
import { fetchCatalog, fetchInstrument, STARTER_CATALOG, type LibraryEntry } from '../audio/multisample/library'
import { libraryBaseUrl } from '../audio/multisample/source'
import type { ProjectStore } from '../state/store'

export function LibraryPanel({ store, engine, trackId }: { store: ProjectStore; engine: AudioEngine; trackId: string }) {
  const track = store.track(trackId)
  const program = track?.library
  const [status, setStatus] = useState(program ? `${program.name} · ${program.zones.length} zones` : 'Load a starter instrument or import SFZ, SF2, or DecentSampler.')
  const [busy, setBusy] = useState(false)
  const [catalog, setCatalog] = useState<LibraryEntry[]>(STARTER_CATALOG)
  const switchLabel = program?.keyswitches.find((item) => item.key === program.defaultSwitch)?.label

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
      store.adoptLibrary(trackId, bound.program, bound.assets)
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
          <button key={entry.id} type="button" disabled={busy} onClick={() => void loadStarter(entry)}>{entry.name}</button>
        ))}
        <button type="button" disabled={busy} onClick={() => void refreshCatalog()}>Catalog</button>
        <label className="library-file">
          Import
          <input
            type="file"
            accept=".sfz,.sf2,.dspreset,.wav,audio/*"
            multiple
            hidden
            onChange={(event) => {
              void onFiles(event.target.files)
              event.target.value = ''
            }}
          />
        </label>
      </div>
      <p className="library-status">{status}{switchLabel ? ` · ${switchLabel}` : ''}</p>
      {program && program.mics.length > 0 && (
        <div className="library-mics">
          {program.mics.map((mic) => (
            <label key={mic.id}>
              {mic.name}
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                aria-label={`${mic.name} mic`}
                value={mic.gain}
                onChange={(event) => store.setLibraryMic(trackId, mic.id, Number(event.target.value), mic.mute)}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

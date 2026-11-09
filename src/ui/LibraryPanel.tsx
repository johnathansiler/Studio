import { useEffect, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { bindLocalSamples, importInstrument } from '../audio/multisample/import'
import { fetchCatalogSound, loadSoundCatalog } from '../sounds/catalog'
import { decodeSoundBytes } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
import { selectInstrument } from '../state/select'
import type { ProjectStore } from '../state/store'
import './instrument.css'

export function LibraryPanel({
  store,
  engine,
  trackId,
  initialSounds,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  /** Tests pass downloaded samples so the picker renders without the network. */
  initialSounds?: SoundEntry[]
}) {
  const instrument = selectInstrument(store, trackId)
  const program = instrument.program
  const [status, setStatus] = useState(program ? `${program.name} · ${program.zones.length} zones` : 'Load one downloaded sample, or import SFZ, SF2, or DecentSampler.')
  const [hint, setHint] = useState('A downloaded file plays as one sample. It is not a multisampled instrument. Import still reads files on this device.')
  const [busy, setBusy] = useState(false)
  const [sounds, setSounds] = useState<SoundEntry[]>(initialSounds ?? [])
  const show = (text: string) => setHint(text)

  useEffect(() => {
    if (initialSounds) return
    let alive = true
    void loadSoundCatalog().then((next) => {
      if (alive) setSounds(next.entries)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [initialSounds])

  async function loadSample(entry: SoundEntry) {
    setBusy(true)
    setStatus(`Downloading ${entry.name}…`)
    try {
      const bytes = await fetchCatalogSound(entry)
      const decoded = await decodeSoundBytes(bytes)
      if (!decoded.channels[0]?.length) {
        setStatus('That file had no audio.')
        return
      }
      store.loadSamplerSound(trackId, {
        id: `lib_${entry.id}`,
        name: entry.name,
        sampleRate: decoded.sampleRate,
        channels: decoded.channels,
      }, undefined, entry.type === 'loop')
      setStatus(`${entry.name} plays as one sample across the keyboard.`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Download failed')
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
        <select
          aria-label="Load sample"
          title="Load one downloaded file onto this track. It plays as a single sample, not a multisampled instrument."
          value=""
          disabled={busy}
          onChange={(event) => {
            const entry = sounds.find((item) => item.id === event.target.value)
            if (!entry) return
            show(`${entry.name} is one ${entry.type === 'loop' ? 'loop' : 'one-shot'}. It is not a multisampled instrument.`)
            void loadSample(entry)
          }}
        >
          <option value="">Load sample</option>
          {sounds.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.name} · {entry.type === 'loop' ? 'Loop' : 'One-shot'}</option>
          ))}
        </select>
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

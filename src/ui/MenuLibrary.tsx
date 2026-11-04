import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import { useFormFactor } from './form'
import { SOUND_MIME } from '../audio/sample/slot'
import { STARTER_CATALOG, starterCatalog, loadStarterOnto, boundLibraryHost, type LibraryEntry } from '../sounds/instruments'
import { catalogMessage, isDrumSound, loadSoundCatalog } from '../sounds/catalog'
import { soundCache } from '../sounds/cache'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import { fetchSoundBytes } from '../sounds/cache'
import type { CatalogResult, SoundEntry } from '../sounds/types'
import type { ProjectStore } from '../state/store'
import { FACTORY_PRESETS, type DeviceKind } from '../model/rack'
import './menuPanels.css'

const HINT_KEY = 'cueharbor-browser-hint'
const INSTRUMENT_PREFIX = 'instrument:'

type Chip = 'drums' | 'loops' | 'instruments' | 'samples' | 'presets' | 'files'

const CHIPS: { id: Chip; label: string }[] = [
  { id: 'drums', label: 'Drums' },
  { id: 'loops', label: 'Loops' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'samples', label: 'Samples' },
  { id: 'presets', label: 'Presets' },
  { id: 'files', label: 'My Files' },
]

type Row = {
  id: string
  name: string
  type: string
  detail: string
  draggable: boolean
  mime: string
}

const PRESET_ROWS: { id: string; name: string; kind: DeviceKind; params: Record<string, number> }[] = (
  ['sub', 'fm', 'wave', 'knock'] as DeviceKind[]
).flatMap((kind) => (FACTORY_PRESETS[kind] ?? []).slice(0, 4).map((preset) => ({
  id: `${kind}:${preset.name}`,
  name: preset.name,
  kind,
  params: preset.params,
})))

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
  holdLibraryPack?: (trackId: string, pack: import('../audio/multisample/types').SamplePack) => void
  auditionLibrary?: (trackId: string, pitch?: number, velocity?: number) => Promise<void>
}

export function MenuLibrary({ store, engine }: { store: ProjectStore; engine: PreviewEngine }) {
  const form = useFormFactor()
  const dragOk = form !== 'phone'
  const [chip, setChip] = useState<Chip>('drums')
  const [text, setText] = useState('')
  const [catalog, setCatalog] = useState<CatalogResult>({ entries: [], status: 'missing' })
  const [loading, setLoading] = useState(true)
  const [starters, setStarters] = useState<LibraryEntry[]>(STARTER_CATALOG.map((entry) => ({ ...entry })))
  const [playing, setPlaying] = useState('')
  const [busy, setBusy] = useState('')
  const [hint, setHint] = useState(() => {
    try { return localStorage.getItem(HINT_KEY) !== '1' } catch { return true }
  })
  const entriesRef = useRef(catalog.entries)
  const startersRef = useRef(starters)
  entriesRef.current = catalog.entries
  startersRef.current = starters

  useEffect(() => {
    let alive = true
    void loadSoundCatalog(fetch, soundCache()).then((next) => {
      if (!alive) return
      setCatalog(next)
      setLoading(false)
    })
    void starterCatalog().then((next) => { if (alive) setStarters(next) }).catch(() => undefined)
    return () => { alive = false }
  }, [])

  useEffect(() => () => engine.stopPreview(), [engine])

  useEffect(() => {
    const allow = (event: DragEvent) => {
      if (!dragOk) return
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes(SOUND_MIME)) return
      event.preventDefault()
    }
    const drop = (event: DragEvent) => {
      if (!dragOk) return
      const id = event.dataTransfer?.getData(SOUND_MIME) || ''
      if (!id) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.menu-library, [data-pads]')) return
      event.preventDefault()
      const at = sampleAtDrop(target, event, store, engine)
      if (id.startsWith(INSTRUMENT_PREFIX)) {
        const starter = startersRef.current.find((item) => item.id === id.slice(INSTRUMENT_PREFIX.length))
        if (starter) void placeInstrument(starter, trackIdFromDrop(target))
        return
      }
      const entry = entriesRef.current.find((item) => item.id === id)
      if (entry) void placeSoundEntry(entry, trackIdFromDrop(target), at)
    }
    window.addEventListener('dragover', allow)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', allow)
      window.removeEventListener('drop', drop)
    }
  }, [dragOk, engine, store])

  function seen() {
    setHint(false)
    try { localStorage.setItem(HINT_KEY, '1') } catch { /* private mode keeps the line */ }
  }

  async function reload() {
    setLoading(true)
    const next = await loadSoundCatalog(fetch, soundCache())
    setCatalog(next)
    setLoading(false)
  }

  async function placeSoundEntry(entry: SoundEntry, trackId?: string | null, startSample?: number) {
    seen()
    if (store.remoteFollow) {
      store.toast('The host owns the arrangement.', 'warn')
      return
    }
    setBusy(entry.id)
    try {
      const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
      const decoded = await decodeSoundBytes(bytes)
      let target = audioTrackFor(store.project, store.selectedTrackId, trackId)
      if (!target) target = store.addQuickTrack('audio')
      if (!target) return
      const placed = placeSound({
        entry,
        channels: decoded.channels,
        fileRate: decoded.sampleRate,
        project: store.project,
        startSample: startSample ?? engine.currentTimelineSample(),
        bufferId: `lib_${entry.id}`,
      })
      if (!placed) return
      if (!store.buffers.has(placed.asset.id)) store.addAsset(placed.asset)
      store.addAudioClip(target, placed.clip)
      store.toast(`${entry.name} is on the track.`, 'good')
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not add that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function placeInstrument(entry: LibraryEntry, trackId?: string | null) {
    seen()
    if (store.remoteFollow) return
    let target = trackId && store.track(trackId)?.type === 'midi' ? trackId : null
    if (!target) {
      const selected = store.track(store.selectedTrackId ?? '')
      target = selected?.type === 'midi' ? selected.id : store.addQuickTrack('instrument')
    }
    if (!target) return
    setBusy(entry.id)
    try {
      await loadStarterOnto(entry, target, boundLibraryHost(engine, (id, program) => store.setLibrary(id, program), true))
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not load that instrument.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function preview(entry: SoundEntry) {
    seen()
    if (playing === entry.id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    setBusy(entry.id)
    try {
      const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
      const decoded = await decodeSoundBytes(bytes)
      const channels = previewChannelsFor(entry, decoded.channels, decoded.sampleRate, store.project, engine.currentTimelineSample())
      engine.unlock()
      engine.previewPcm(channels, store.project.sampleRate)
      setPlaying(entry.id)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not play that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }

  function previewFile(id: string) {
    seen()
    if (playing === id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    const asset = store.buffers.get(id)
    const channels = asset?.channels
    if (!channels?.[0]?.length) return
    engine.unlock()
    engine.previewPcm(channels, asset.sampleRate)
    setPlaying(id)
  }

  function addFile(id: string) {
    seen()
    const asset = store.buffers.get(id)
    if (!asset?.channels[0]?.length) return
    let target = audioTrackFor(store.project, store.selectedTrackId, null)
    if (!target) target = store.addQuickTrack('audio')
    if (!target) return
    store.addAudioClip(target, {
      id: `file-${id}-${Math.round(engine.currentTimelineSample())}`,
      name: asset.name,
      bufferId: id,
      startSample: Math.max(0, Math.round(engine.currentTimelineSample())),
      offsetSamples: 0,
      durationSamples: asset.channels[0].length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local',
    })
  }

  function addPreset(row: (typeof PRESET_ROWS)[number]) {
    seen()
    let trackId = store.track(store.selectedTrackId ?? '')?.type === 'midi' ? store.selectedTrackId : null
    if (!trackId) trackId = store.addQuickTrack('instrument')
    const track = trackId ? store.track(trackId) : null
    const plugin = track?.plugins.find((item) => item.pluginId === row.kind || item.pluginId === 'analog' || item.pluginId === 'sampler')
    if (!trackId || !plugin) {
      store.toast('Add puts this preset on a synth. Open an instrument track first.', 'info')
      return
    }
    store.updatePlugin(trackId, plugin.id, { params: { ...plugin.params, ...row.params } })
    store.toast(`${row.name} is on ${track?.name ?? 'the track'}.`, 'good')
  }

  const needle = text.trim().toLowerCase()
  const sounds = catalog.entries.filter((entry) => {
    if (chip === 'drums' && !isDrumSound(entry)) return false
    if (chip === 'loops' && entry.type !== 'loop') return false
    if (chip === 'samples' && entry.type !== 'one-shot') return false
    if (!needle) return true
    return `${entry.name} ${entry.tags.join(' ')} ${entry.key ?? ''}`.toLowerCase().includes(needle)
  })
  const instrumentRows = starters.filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
  const presetRows = PRESET_ROWS.filter((entry) => !needle || entry.name.toLowerCase().includes(needle))
  const fileRows = [...store.buffers.values()].filter((asset) => !needle || asset.name.toLowerCase().includes(needle))

  const libraryChip = chip === 'drums' || chip === 'loops' || chip === 'samples'
  const failed = !loading && catalog.status !== 'ok' && libraryChip && sounds.length === 0
  const empty = !loading && !failed && (
    (libraryChip && sounds.length === 0)
    || (chip === 'instruments' && instrumentRows.length === 0)
    || (chip === 'presets' && presetRows.length === 0)
    || (chip === 'files' && fileRows.length === 0)
  )

  return (
    <div className="menu-library" role="region" aria-label="Browser">
      <input
        className="menu-search"
        aria-label="Search the browser"
        placeholder="Search"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="menu-chips" role="group" aria-label="Browser categories">
        {CHIPS.map((item) => (
          <button key={item.id} type="button" className={chip === item.id ? 'on' : ''} aria-pressed={chip === item.id} onClick={() => setChip(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {hint && <p className="menu-hint">Tap to hear. Add puts it on the selected track.</p>}
      {dragOk && <p className="menu-hint">Drag a row onto a track or a Beat Machine pad.</p>}
      <div className="menu-rows" role="list">
        {loading && libraryChip && [0, 1, 2].map((item) => <div key={item} className="menu-skel" role="status" aria-label="Loading" />)}
        {failed && (
          <p className="menu-hint" role="status">
            {catalogMessage(catalog, 0, Boolean(text)) || 'The sound library did not answer.'}
            {' '}
            <button type="button" onClick={() => void reload()}>Retry</button>
          </p>
        )}
        {empty && <p className="menu-hint" role="status">{text ? 'Nothing matches.' : 'Nothing in this category yet.'}</p>}
        {libraryChip && !failed && sounds.map((entry) => (
          <LibraryRow
            key={entry.id}
            name={entry.name}
            type={chip === 'drums' ? 'Drum' : entry.type === 'loop' ? 'Loop' : 'Sample'}
            detail={[entry.bpm ? `${Math.round(entry.bpm)} BPM` : '', entry.key ?? ''].filter(Boolean).join(' · ')}
            playing={playing === entry.id}
            busy={busy === entry.id}
            draggable={dragOk}
            onDragStart={(event) => {
              event.dataTransfer.setData(SOUND_MIME, entry.id)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onHear={() => void preview(entry)}
            onAdd={() => void placeSoundEntry(entry)}
          />
        ))}
        {chip === 'instruments' && instrumentRows.map((entry) => (
          <LibraryRow
            key={entry.id}
            name={entry.name}
            type="Instrument"
            detail={entry.category ?? 'Preset'}
            playing={false}
            busy={busy === entry.id}
            draggable={dragOk}
            onDragStart={(event) => {
              event.dataTransfer.setData(SOUND_MIME, `${INSTRUMENT_PREFIX}${entry.id}`)
              event.dataTransfer.effectAllowed = 'copy'
            }}
            onHear={() => void placeInstrument(entry)}
            onAdd={() => void placeInstrument(entry)}
            hearLabel="Play"
          />
        ))}
        {chip === 'presets' && presetRows.map((entry) => (
          <LibraryRow
            key={entry.id}
            name={entry.name}
            type="Preset"
            detail={entry.kind}
            playing={false}
            busy={false}
            draggable={false}
            onHear={() => addPreset(entry)}
            onAdd={() => addPreset(entry)}
            hearLabel="Use"
          />
        ))}
        {chip === 'files' && fileRows.map((asset) => (
          <LibraryRow
            key={asset.id}
            name={asset.name}
            type="File"
            detail=""
            playing={playing === asset.id}
            busy={false}
            draggable={false}
            onHear={() => previewFile(asset.id)}
            onAdd={() => addFile(asset.id)}
          />
        ))}
      </div>
    </div>
  )
}

function sampleAtDrop(target: Element | null, event: DragEvent, store: ProjectStore, engine: PreviewEngine) {
  const inner = target?.closest('.timeline-inner') as HTMLElement | null
  if (!inner) return engine.currentTimelineSample()
  const px = Number(inner.dataset.px) || 90
  const rect = inner.getBoundingClientRect()
  return Math.max(0, ((event.clientX - rect.left) / px) * (store.project.sampleRate || 48000))
}

function LibraryRow({
  name, type, detail, playing, busy, draggable, onDragStart, onHear, onAdd, hearLabel = 'Play',
}: {
  name: string
  type: string
  detail: string
  playing: boolean
  busy: boolean
  draggable: boolean
  onDragStart?: (event: ReactDragEvent<HTMLButtonElement>) => void
  onHear: () => void
  onAdd: () => void
  hearLabel?: string
}) {
  return (
    <div className="menu-row" role="listitem">
      <button
        type="button"
        className="menu-row-main"
        draggable={draggable}
        disabled={busy}
        title={draggable ? 'Tap to hear. Drag onto a track or a pad.' : 'Tap to hear.'}
        onDragStart={onDragStart}
        onClick={onHear}
      >
        <strong>{name}</strong>
        <small>{type}{detail ? ` · ${detail}` : ''}</small>
      </button>
      <button type="button" className="menu-play" aria-label={playing ? `Stop ${name}` : `${hearLabel} ${name}`} disabled={busy} onClick={onHear}>
        {playing ? 'Stop' : hearLabel}
      </button>
      <button type="button" className="menu-add" aria-label={`Add ${name}`} disabled={busy} onClick={onAdd}>Add</button>
    </div>
  )
}

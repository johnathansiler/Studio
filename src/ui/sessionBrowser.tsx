import { useEffect, useState, useSyncExternalStore } from 'react'
import { soundCache } from '../sounds/cache'
import { fetchCatalogSound, filterSounds, loadSoundCatalog, soundCategories, soundCollections, soundKeys, soundTags } from '../sounds/catalog'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor } from '../sounds/place'
import type { SoundEntry, SoundFilter, SoundQuery } from '../sounds/types'
import type { ProjectStore } from '../state/store'
import {
  browserGroup,
  deviceDrag,
  instrumentFor,
  midiKind,
  parseDeviceDrag,
  type BrowserDevice,
  type BrowserGroup,
} from '../model/sessionBoard'
import { parseSessionDrag, type SessionDrag } from '../model/sessionInteract'
import { beginSessionDrag } from './sessionPointer'
import { PACK_LABEL, packLabel } from '../sounds/contract'
import { SoundFilterButton } from './SoundBrowser'

const CATALOG_WAIT_MS = 8000

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
}

function until<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error('Could not load sounds.'))
      },
    )
  })
}

const GROUPS: { id: BrowserGroup; label: string; hint: string }[] = [
  { id: 'sounds', label: 'Sounds', hint: 'Loops and one-shots from the free library.' },
  { id: 'instruments', label: 'Instruments', hint: 'Drag onto a MIDI track.' },
  { id: 'drums', label: 'Drums', hint: 'Drag a drum instrument onto a MIDI track.' },
  { id: 'audio', label: 'Audio effects', hint: 'Drag onto a track to insert it.' },
  { id: 'midi', label: 'MIDI effects', hint: 'Drag onto a MIDI track.' },
]

const sounds = new Map<string, SoundEntry>()

export function rememberSounds(entries: SoundEntry[]) {
  for (const entry of entries) sounds.set(entry.id, entry)
}

export function soundById(id: string) {
  return sounds.get(id) ?? null
}

export async function dropLibrarySound(store: ProjectStore, trackId: string, scene: number, id: string) {
  const entry = soundById(id)
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!entry || !track) return
  if (track.type !== 'audio') {
    store.toast('Drop sounds on an audio track.', 'warn')
    return
  }
  const bytes = await fetchCatalogSound(entry)
  const decoded = await decodeSoundBytes(bytes)
  const placed = placeSound({
    entry,
    channels: decoded.channels,
    fileRate: decoded.sampleRate,
    project: store.project,
    startSample: 0,
    bufferId: `lib_${entry.id}`,
  })
  if (!placed) {
    store.toast('That sound had no audio.', 'warn')
    return
  }
  placed.clip.slotOnly = true
  placed.clip.loop = entry.type === 'loop' || placed.clip.loop !== false
  if (!store.buffers.has(placed.asset.id)) store.addAsset(placed.asset)
  store.placeInSlot(trackId, scene, placed.clip)
}

/** Puts a browser device on the selected track, or on a track of the right kind. */
export function addBrowserDevice(store: ProjectStore, item: BrowserDevice) {
  if (store.remoteFollow) {
    store.toast('The host owns the arrangement.', 'warn')
    return
  }
  const parsed = parseDeviceDrag(deviceDrag(item))
  if (!parsed) return
  const selected = store.selectedTrackId ? store.track(store.selectedTrackId) : null
  if (parsed.kind === 'audio') {
    let trackId = selected?.id ?? store.project.tracks.find((track) => track.type === 'audio' || track.type === 'midi')?.id ?? null
    if (!trackId) {
      trackId = store.addTracks({ kind: 'audio', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })[0] ?? null
    }
    if (!trackId) {
      store.toast('Could not add a track for that effect.', 'warn')
      return
    }
    store.addPlugin(trackId, parsed.id)
    if (parsed.id === 'tune') {
      const plugin = store.track(trackId)?.plugins.at(-1)
      if (plugin?.pluginId === 'tune') store.updatePlugin(trackId, plugin.id, { params: { amount: Math.max(plugin.params.amount ?? 0, 0.85) } })
    }
    store.toast(`${item.name} is on the track.`, 'good')
    return
  }
  const midiId = selected?.type === 'midi' ? selected.id : null
  if (parsed.kind === 'midi') {
    let trackId = midiId ?? store.project.tracks.find((track) => track.type === 'midi')?.id ?? null
    if (!trackId) {
      trackId = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })[0] ?? null
    }
    const fx = midiKind(parsed.id)
    if (!trackId || !fx) {
      store.toast('That device goes on a MIDI track.', 'warn')
      return
    }
    store.addMidiFx(trackId, fx)
    store.toast(`${item.name} is on the track.`, 'good')
    return
  }
  if (parsed.id === 'steps' || parsed.id === 'scaler' || parsed.id === 'synth' || parsed.id === 'pads') {
    store.addPlugin(midiId ?? 'master', parsed.id)
    store.toast(`${item.name} is on the track.`, 'good')
    return
  }
  const instrument = instrumentFor(parsed.id)
  if (!instrument) {
    store.toast('Could not add that instrument.', 'warn')
    return
  }
  if (midiId) {
    store.setTrackInstrument(midiId, instrument)
    if (selected?.input === 'none') store.updateTrack(midiId, { input: 'midi' })
    store.toast(`${item.name} is on the track.`, 'good')
    return
  }
  const created = store.addTracks({ kind: 'midi', count: 1, instrument, input: 'mic', channels: 1, armed: false })
  if (!created[0]) {
    store.toast('Could not add a track for that instrument.', 'warn')
    return
  }
  store.toast(`${item.name} is on the track.`, 'good')
}

export function SessionBrowser({
  width,
  onResize,
  onClose,
  onPointerDrop,
  store,
  engine,
}: {
  width: number
  onResize: (width: number) => void
  onClose?: () => void
  onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void
  store?: ProjectStore
  engine?: PreviewEngine
}) {
  const [group, setGroup] = useState<BrowserGroup>('sounds')
  const [entries, setEntries] = useState<SoundEntry[]>([])
  const [phase, setPhase] = useState<'loading' | 'error' | 'ready'>('loading')
  const [query, setQuery] = useState('')
  const [bpm, setBpm] = useState<SoundQuery['bpm']>('any')
  const [kind, setKind] = useState<SoundFilter>('all')
  const [soundKey, setSoundKey] = useState('')
  const [collection, setCollection] = useState('')
  const [category, setCategory] = useState('')
  const [tag, setTag] = useState('')
  const [page, setPage] = useState(0)
  const [favoritesOnly, setFavoritesOnly] = useState(false)
  const [playing, setPlaying] = useState('')
  const [busy, setBusy] = useState('')
  const [loadRatio, setLoadRatio] = useState(0)
  useSyncExternalStore(
    (listener) => store ? store.subscribe(listener) : () => undefined,
    () => store?.version ?? 0,
    () => 0,
  )

  async function loadCatalog() {
    setPhase('loading')
    try {
      const result = await until(loadSoundCatalog(fetch, soundCache()), CATALOG_WAIT_MS)
      rememberSounds(result.entries)
      setEntries(result.entries)
      setPhase(result.entries.length || result.status === 'ok' ? 'ready' : 'error')
    } catch {
      setEntries([])
      setPhase('error')
    }
  }

  useEffect(() => {
    let alive = true
    setPhase('loading')
    void until(loadSoundCatalog(fetch, soundCache()), CATALOG_WAIT_MS).then((result) => {
      if (!alive) return
      rememberSounds(result.entries)
      setEntries(result.entries)
      setPhase(result.entries.length || result.status === 'ok' ? 'ready' : 'error')
    }).catch(() => {
      if (!alive) return
      setEntries([])
      setPhase('error')
    })
    return () => { alive = false }
  }, [])

  const needle = query.trim().toLowerCase()
  const favorites = store?.project.soundFavorites ?? []
  const filteredSounds = filterSounds(entries, {
    text: query,
    type: kind,
    bpm,
    key: soundKey,
    favoritesOnly,
    projectBpm: store?.project.tempo ?? 120,
    favorites,
    collection,
    category,
    tag,
  })
  const pageSize = 60
  const pageCount = Math.max(1, Math.ceil(filteredSounds.length / pageSize))
  const safePage = Math.min(page, pageCount - 1)
  const shownSounds = filteredSounds.slice(safePage * pageSize, safePage * pageSize + pageSize)
  const devices = browserGroup(group).filter((item) => !needle || `${item.name} ${item.hint}`.toLowerCase().includes(needle))
  const keys = soundKeys(entries)

  async function preview(entry: SoundEntry) {
    if (!engine || !store) return
    if (playing === entry.id) {
      engine.stopPreview()
      setPlaying('')
      return
    }
    setBusy(entry.id)
    try {
      engine.unlock()
      setLoadRatio(0)
      const bytes = await fetchCatalogSound(entry, { onProgress: setLoadRatio })
      const decoded = await decodeSoundBytes(bytes)
      const channels = previewChannelsFor(entry, decoded.channels, decoded.sampleRate, store.project, engine.currentTimelineSample())
      engine.previewPcm(channels, store.project.sampleRate)
      setPlaying(entry.id)
    } catch (error) {
      store.toast(error instanceof Error ? error.message : 'Could not play that sound.', 'warn')
    } finally {
      setBusy('')
    }
  }

  async function addSound(entry: SoundEntry) {
    if (!store) return
    const selected = store.selectedTrackId
    let trackId = audioTrackFor(store.project, selected, null)
    if (!trackId) {
      const ids = store.addTracks({ kind: 'audio', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })
      trackId = ids[0] ?? null
    }
    if (!trackId) {
      store.toast('Could not add a track for that sound.', 'warn')
      return
    }
    setBusy(entry.id)
    try {
      await dropLibrarySound(store, trackId, 0, entry.id)
    } finally {
      setBusy('')
    }
  }

  return (
    <aside className="sl-browser" data-session-browser="open" style={{ ['--browser' as string]: `${width}px` }}>
      <div
        className="sl-browser-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize browser. Drag to change its width."
        title="Drag to resize the browser."
        onPointerDown={(event) => {
          event.preventDefault()
          const start = event.clientX
          const initial = width
          const move = (ev: PointerEvent) => onResize(Math.min(420, Math.max(160, initial + ev.clientX - start)))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      />
      <div className="sl-search-row">
        <input className="sl-search" aria-label="Search browser" placeholder="Search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0) }} />
        {group === 'sounds' && (
          <SoundFilterButton
            bpm={bpm}
            soundKey={soundKey}
            favoritesOnly={favoritesOnly}
            keys={keys}
            showTempoKey
            onBpm={setBpm}
            onKey={setSoundKey}
            onFavorites={setFavoritesOnly}
            collections={soundCollections(entries)}
            categories={soundCategories(entries)}
            collection={collection}
            category={category}
            collectionLabels={PACK_LABEL}
            tags={soundTags(entries)}
            tag={tag}
            onTag={(value) => { setTag(value); setPage(0) }}
            onCollection={(value) => { setCollection(value); setPage(0) }}
            onCategory={(value) => { setCategory(value); setPage(0) }}
            showKind
            kind={kind}
            onKind={setKind}
          />
        )}
      </div>
      <div className="sl-groups">
        <div className="sl-chip-scroll" role="tablist" aria-label="Browser">
          {GROUPS.map((item) => (
            <button key={item.id} type="button" className={group === item.id ? 'on' : ''} title={item.hint} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {onClose && <button type="button" title="Hide the browser." onClick={onClose}>Close</button>}
      </div>
      <div className="sl-list" role="list">
        {group === 'sounds' && phase === 'loading' && <p className="sl-note" role="status">Loading</p>}
        {group === 'sounds' && phase === 'error' && (
          <p className="sl-note" role="status">
            The sound library is not online yet.
            <button type="button" onClick={() => void loadCatalog()}>Retry</button>
          </p>
        )}
        {group === 'sounds' && phase === 'ready' && !shownSounds.length && <p className="sl-note">Nothing matches.</p>}
        {group === 'sounds' && phase === 'ready' && shownSounds.map((entry) => (
          <div className={`sl-row${playing === entry.id ? ' is-playing' : ''}`} key={entry.id}>
            <button
              type="button"
              data-drag-item={entry.id}
              title={`${entry.name}. ${entry.type}. ${entry.category ?? ''} ${entry.tags.join(', ')}. Drag onto a slot.`}
              aria-pressed={playing === entry.id}
              disabled={busy === entry.id}
              onPointerDown={(event) => beginSessionDrag(event, { kind: 'sound', id: entry.id }, entry.name, (drag, point) => onPointerDrop?.(drag, point))}
              onClick={() => void preview(entry)}
            >
              {playing === entry.id && <i className="sound-live" aria-hidden="true" />}
              <strong>{entry.name}</strong>
              <small>{busy === entry.id ? `Loading ${Math.round(loadRatio * 100)}%` : playing === entry.id ? 'Playing' : [entry.type === 'one-shot' ? 'One-shot' : entry.type === 'loop' ? 'Loop' : 'Instrument', entry.pack ? packLabel(entry.pack) : '', entry.category].filter(Boolean).join(' · ')}</small>
            </button>
            <button type="button" className="sl-add" disabled={busy === entry.id || !store || store.remoteFollow} aria-label={`Add. ${entry.name}`} onClick={() => void addSound(entry)}>Add</button>
            <button
              type="button"
              className={`sl-save${favorites.includes(entry.id) ? ' on' : ''}`}
              aria-pressed={favorites.includes(entry.id)}
              disabled={!store || store.remoteFollow}
              aria-label={favorites.includes(entry.id) ? `Saved. ${entry.name} is in favorites.` : `Save. Keep ${entry.name} in favorites.`}
              title="Keep this sound in the project favorites."
              onClick={() => store?.toggleSoundFavorite(entry.id)}
            >
              {favorites.includes(entry.id) ? 'Saved' : 'Save'}
            </button>
          </div>
        ))}
        {group === 'sounds' && phase === 'ready' && pageCount > 1 && (
          <p className="sl-note">
            Page {safePage + 1} of {pageCount}. {filteredSounds.length} sounds.
            <button type="button" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>Previous</button>
            <button type="button" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</button>
          </p>
        )}
        {group !== 'sounds' && devices.map((item) => (
          <DeviceRow key={`${item.kind}:${item.id}`} item={item} store={store} onPointerDrop={onPointerDrop} />
        ))}
        {group !== 'sounds' && !devices.length && <p className="sl-note">Nothing matches.</p>}
      </div>
    </aside>
  )
}

function DeviceRow({ item, store, onPointerDrop }: { item: BrowserDevice; store?: ProjectStore; onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void }) {
  const drag = parseSessionDrag(deviceDrag(item))
  const where = item.kind === 'audio' ? 'Add it to the selected track.' : 'Add it to the selected MIDI track.'
  return (
    <div className="sl-row">
      <button
        type="button"
        data-drag-item={item.id}
        title={`${item.hint} Drag onto a track header.`}
        onPointerDown={(event) => {
          if (drag) beginSessionDrag(event, drag, item.name, (next, point) => onPointerDrop?.(next, point))
        }}
      >
        <strong>{item.name}</strong>
        <small>{item.kind}</small>
      </button>
      <button
        type="button"
        className="sl-add"
        disabled={!store || store.remoteFollow}
        aria-label={`Add. ${item.name}. ${where}`}
        title={`${where} ${item.hint}`}
        onClick={() => { if (store) addBrowserDevice(store, item) }}
      >
        Add
      </button>
    </div>
  )
}

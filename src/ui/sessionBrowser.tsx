import { useEffect, useState } from 'react'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { loadSoundCatalog } from '../sounds/catalog'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import type { ProjectStore } from '../state/store'
import {
  browserGroup,
  deviceDrag,
  type BrowserDevice,
  type BrowserGroup,
} from '../model/sessionBoard'
import { parseSessionDrag, type SessionDrag } from '../model/sessionInteract'
import { beginSessionDrag } from './sessionPointer'

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
  { id: 'plugins', label: 'Plugins', hint: 'Auto-Tune, Scaler, Synth, and Sampler.' },
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
  const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
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
  const [playing, setPlaying] = useState('')
  const [busy, setBusy] = useState('')

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
  const shownSounds = entries.filter((entry) => !needle || `${entry.name} ${entry.type} ${entry.tags.join(' ')}`.toLowerCase().includes(needle)).slice(0, 200)
  const devices = browserGroup(group).filter((item) => !needle || `${item.name} ${item.hint}`.toLowerCase().includes(needle))

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
      const bytes = await fetchSoundBytes(soundFileUrl(entry.path))
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
      <input className="sl-search" aria-label="Search browser" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
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
              title={`${entry.name}. Drag onto a slot.`}
              aria-pressed={playing === entry.id}
              disabled={busy === entry.id}
              onPointerDown={(event) => beginSessionDrag(event, { kind: 'sound', id: entry.id }, entry.name, (drag, point) => onPointerDrop?.(drag, point))}
              onClick={() => void preview(entry)}
            >
              {playing === entry.id && <i className="sound-live" aria-hidden="true" />}
              <strong>{entry.name}</strong>
              <small>{playing === entry.id ? 'Playing' : entry.type}</small>
            </button>
            <button type="button" className="sl-add" disabled={busy === entry.id || !store} aria-label={`Add. ${entry.name}`} onClick={() => void addSound(entry)}>Add</button>
          </div>
        ))}
        {group !== 'sounds' && devices.map((item) => (
          <DeviceRow key={`${item.kind}:${item.id}`} item={item} onPointerDrop={onPointerDrop} />
        ))}
        {group !== 'sounds' && !devices.length && <p className="sl-note">Nothing matches.</p>}
      </div>
    </aside>
  )
}

function DeviceRow({ item, onPointerDrop }: { item: BrowserDevice; onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void }) {
  const drag = parseSessionDrag(deviceDrag(item))
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
    </div>
  )
}

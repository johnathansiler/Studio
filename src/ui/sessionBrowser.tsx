import { useState, useSyncExternalStore } from 'react'
import { rememberCatalogSound } from '../library/recent'
import { fetchCatalogSound } from '../sounds/catalog'
import { decodeSoundBytes, placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
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

type PreviewEngine = {
  unlock: () => void
  stopPreview: () => void
  previewPcm: (channels: Float32Array[], sampleRate?: number) => void
  currentTimelineSample: () => number
}

const GROUPS: { id: BrowserGroup; label: string; hint: string }[] = [
  { id: 'instruments', label: 'Instruments', hint: 'Drag onto a MIDI track.' },
  { id: 'drums', label: 'Drums', hint: 'Drag a drum instrument onto a MIDI track.' },
  { id: 'audio', label: 'Audio effects', hint: 'Drag onto a track to insert it.' },
  { id: 'midi', label: 'MIDI effects', hint: 'Drag onto a MIDI track.' },
]

const sounds = new Map<string, SoundEntry>()

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
  try {
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
    rememberCatalogSound(entry)
  } catch (error) {
    store.toast(error instanceof Error ? error.message : 'That sound is not on this device. The rest of the project still plays.', 'warn')
  }
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
}: {
  width: number
  onResize: (width: number) => void
  onClose?: () => void
  onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void
  store?: ProjectStore
  engine?: PreviewEngine
}) {
  const [group, setGroup] = useState<BrowserGroup>('instruments')
  const [query, setQuery] = useState('')
  useSyncExternalStore(
    (listener) => store ? store.subscribe(listener) : () => undefined,
    () => store?.version ?? 0,
    () => 0,
  )
  const needle = query.trim().toLowerCase()
  const devices = browserGroup(group).filter((item) => !needle || `${item.name} ${item.hint}`.toLowerCase().includes(needle))

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
        <input className="sl-search" aria-label="Search browser" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} />
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
        {devices.map((item) => (
          <DeviceRow key={`${item.kind}:${item.id}`} item={item} store={store} onPointerDrop={onPointerDrop} />
        ))}
        {!devices.length && <p className="sl-note">Nothing matches.</p>}
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

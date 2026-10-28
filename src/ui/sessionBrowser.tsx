import { useEffect, useState } from 'react'
import { fetchSoundBytes, soundCache } from '../sounds/cache'
import { loadSoundCatalog } from '../sounds/catalog'
import { decodeSoundBytes } from '../sounds/place'
import { placeSound } from '../sounds/place'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import {
  browserGroup,
  deviceDrag,
  type BrowserDevice,
  type BrowserGroup,
} from '../model/sessionBoard'
import { parseSessionDrag, type SessionDrag } from '../model/sessionInteract'
import type { ProjectStore } from '../state/store'
import { beginSessionDrag } from './sessionPointer'

const GROUPS: { id: BrowserGroup; label: string; hint: string }[] = [
  { id: 'sounds', label: 'Sounds', hint: 'Loops and one-shots from the free library.' },
  { id: 'instruments', label: 'Instruments', hint: 'Drag onto a MIDI track.' },
  { id: 'drums', label: 'Drums', hint: 'Drag a drum instrument onto a MIDI track.' },
  { id: 'audio', label: 'Audio effects', hint: 'Drag onto a track to insert it.' },
  { id: 'midi', label: 'MIDI effects', hint: 'Drag onto a MIDI track.' },
  { id: 'plugins', label: 'Plugins', hint: 'Auto-Tune and Scaler.' },
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
}: {
  width: number
  onResize: (width: number) => void
  onClose?: () => void
  onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void
}) {
  const [group, setGroup] = useState<BrowserGroup>('sounds')
  const [entries, setEntries] = useState<SoundEntry[]>([])
  const [status, setStatus] = useState('Loading sounds…')

  useEffect(() => {
    let alive = true
    void loadSoundCatalog(fetch, soundCache()).then((result) => {
      if (!alive) return
      rememberSounds(result.entries)
      setEntries(result.entries.slice(0, 80))
      setStatus(result.entries.length ? '' : 'The sound library is not available right now.')
    }).catch(() => {
      if (alive) setStatus('The sound library is not available right now.')
    })
    return () => { alive = false }
  }, [])

  const devices = browserGroup(group)

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
      <div className="sl-groups" role="tablist" aria-label="Browser">
        {GROUPS.map((item) => (
          <button key={item.id} type="button" className={group === item.id ? 'on' : ''} title={item.hint} aria-pressed={group === item.id} onClick={() => setGroup(item.id)}>
            {item.label}
          </button>
        ))}
        {onClose && <button type="button" title="Hide the browser." onClick={onClose}>Hide</button>}
      </div>
      <div className="sl-list" role="list">
        {group === 'sounds' && status && <p className="sl-note">{status}</p>}
        {group === 'sounds' && entries.map((entry) => (
          <button
            key={entry.id}
            type="button"
            data-drag-item={entry.id}
            title={`${entry.name}. Drag onto a slot.`}
            onPointerDown={(event) => beginSessionDrag(event, { kind: 'sound', id: entry.id }, entry.name, (drag, point) => onPointerDrop?.(drag, point))}
          >
            {entry.name}
            <small>{entry.type}</small>
          </button>
        ))}
        {group !== 'sounds' && devices.map((item) => (
          <DeviceRow key={`${item.kind}:${item.id}`} item={item} onPointerDrop={onPointerDrop} />
        ))}
      </div>
    </aside>
  )
}

function DeviceRow({ item, onPointerDrop }: { item: BrowserDevice; onPointerDrop?: (drag: SessionDrag, point: { x: number; y: number }) => void }) {
  const drag = parseSessionDrag(deviceDrag(item))
  return (
    <button
      type="button"
      data-drag-item={item.id}
      title={`${item.hint} Drag onto a track header.`}
      onPointerDown={(event) => {
        if (drag) beginSessionDrag(event, drag, item.name, (next, point) => onPointerDrop?.(next, point))
      }}
    >
      {item.name}
      <small>{item.hint}</small>
    </button>
  )
}

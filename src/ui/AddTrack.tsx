import { useEffect, useRef, useState } from 'react'
import { clampCount, defaultAddSpec, type AddKind, type AddTrackSpec } from '../model/addTrack'
import type { TrackInstrument } from '../model/types'
import type { ProjectStore } from '../state/store'

const LAST_KEY = 'cueharbor-last-track'
const KINDS: { id: AddKind; label: string }[] = [
  { id: 'audio', label: 'Audio' },
  { id: 'midi', label: 'Inst' },
  { id: 'drum', label: 'Drum' },
  { id: 'bus', label: 'Bus' },
]
const INSTRUMENTS: { id: TrackInstrument; label: string }[] = [
  { id: 'synth', label: 'Synth' },
  { id: 'sampler', label: 'Sampler' },
  { id: '808', label: '808' },
  { id: 'drum-machine', label: 'Drum machine' },
  { id: 'none', label: 'None' },
]

function readLast(): AddTrackSpec | null {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AddTrackSpec
    if (!KINDS.some((kind) => kind.id === parsed.kind)) return null
    return { ...defaultAddSpec(), ...parsed, count: clampCount(parsed.count) }
  } catch {
    return null
  }
}

function writeLast(spec: AddTrackSpec) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(spec))
  } catch {
    /* the track is still created */
  }
}

function reveal(id: string) {
  requestAnimationFrame(() => {
    document.querySelector(`[data-track="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

export function AddTrackButton({ store }: { store: ProjectStore }) {
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState<AddTrackSpec>(defaultAddSpec)
  const hold = useRef(0)
  const held = useRef(false)
  const skipTap = useRef(false)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.add-sheet, .add-track-btn')) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [open])

  function commit(next: AddTrackSpec) {
    const saved = { ...next, count: clampCount(next.count) }
    const ids = store.addTracks(saved)
    writeLast(saved)
    if (ids[0]) reveal(ids[0])
    setSpec(saved)
    setOpen(false)
  }

  function repeat() {
    commit(readLast() ?? spec)
  }

  return (
    <div className="add-track-slot">
      <button
        type="button"
        className="add-track-btn"
        aria-label="Add track"
        onPointerDown={() => {
          held.current = false
          window.clearTimeout(hold.current)
          hold.current = window.setTimeout(() => {
            held.current = true
            repeat()
          }, 450)
        }}
        onPointerUp={() => {
          window.clearTimeout(hold.current)
          if (skipTap.current) {
            skipTap.current = false
            return
          }
          if (!held.current) setOpen(true)
          held.current = false
        }}
        onPointerLeave={() => window.clearTimeout(hold.current)}
        onContextMenu={(event) => {
          event.preventDefault()
          skipTap.current = true
          window.clearTimeout(hold.current)
          held.current = false
          setOpen(false)
          repeat()
        }}
      >
        +
      </button>
      {open && (
        <div className="add-sheet" role="dialog" aria-label="Add track">
          <div className="add-row">
            {KINDS.map((kind) => (
              <button key={kind.id} type="button" className={spec.kind === kind.id ? 'on' : ''} onClick={() => setSpec({ ...spec, kind: kind.id })}>
                {kind.label}
              </button>
            ))}
          </div>
          {spec.kind === 'midi' && (
            <div className="add-row">
              {INSTRUMENTS.map((item) => (
                <button key={item.id} type="button" className={spec.instrument === item.id ? 'on' : ''} onClick={() => setSpec({ ...spec, instrument: item.id })}>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {spec.kind === 'audio' && (
            <div className="add-row">
              <button type="button" className={spec.input === 'mic' ? 'on' : ''} onClick={() => setSpec({ ...spec, input: 'mic' })}>Mic</button>
              <button type="button" className={spec.input === 'line' ? 'on' : ''} onClick={() => setSpec({ ...spec, input: 'line' })}>Line</button>
              <button type="button" className={spec.channels === 1 ? 'on' : ''} onClick={() => setSpec({ ...spec, channels: 1 })}>Mono</button>
              <button type="button" className={spec.channels === 2 ? 'on' : ''} onClick={() => setSpec({ ...spec, channels: 2 })}>Stereo</button>
              <button type="button" className={spec.armed ? 'on' : ''} onClick={() => setSpec({ ...spec, armed: !spec.armed })}>Arm</button>
            </div>
          )}
          <div className="add-row">
            {Array.from({ length: 8 }, (_, index) => index + 1).map((count) => (
              <button key={count} type="button" className={spec.count === count ? 'on' : ''} aria-label={`${count}`} onClick={() => setSpec({ ...spec, count })}>
                {count}
              </button>
            ))}
          </div>
          <button type="button" className="add-go" onClick={() => commit(spec)}>Add</button>
        </div>
      )}
    </div>
  )
}

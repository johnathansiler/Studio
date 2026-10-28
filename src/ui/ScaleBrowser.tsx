import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProjectStore } from '../state/store'
import {
  FAMILY_LABEL,
  NOTE_NAMES,
  SCALE_FAMILIES,
  noteName,
  scaleTones,
  searchScales,
  type ChordSource,
  type ScaleId,
} from '../model/scale'
import { chordsInKey } from '../theory'

const SETS: { id: ChordSource; name: string }[] = [
  { id: 'triads', name: 'Triads' },
  { id: 'sevenths', name: '7ths' },
  { id: 'ninths', name: '9ths' },
  { id: 'sixths', name: '6ths' },
  { id: 'sus', name: 'Sus' },
  { id: 'add', name: 'Add' },
  { id: 'jins', name: 'Jins' },
  { id: 'borrowed', name: 'Borrowed' },
  { id: 'secondary', name: 'Secondary' },
  { id: 'pop', name: 'Pop' },
  { id: 'rnb', name: 'R&B' },
  { id: 'edm', name: 'EDM' },
  { id: 'cinematic', name: 'Film' },
  { id: 'rock', name: 'Rock' },
  { id: 'jazz', name: 'Jazz' },
  { id: 'gospel', name: 'Gospel' },
]

export interface ChordDrop {
  beat: number
  trackId: string
  clipId: string | null
}

export function ScaleSelect({
  value,
  onChange,
  label = 'Scale',
}: {
  value: string
  onChange: (id: ScaleId) => void
  label?: string
}) {
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value as ScaleId)}>
      {SCALE_FAMILIES.map((family) => (
        <optgroup key={family} label={FAMILY_LABEL[family]}>
          {searchScales('', family).map((scale) => (
            <option key={scale.id} value={scale.id}>{scale.name}</option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}

export function ScaleBrowser({
  store,
  onPlace,
  beatOnRoll,
  playhead,
}: {
  store: ProjectStore
  onPlace: (pitches: number[], drop?: ChordDrop) => void
  beatOnRoll: (x: number, y: number) => number | null
  playhead: () => number
}) {
  const scale = store.scaleState()
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<(typeof SCALE_FAMILIES)[number] | 'all'>('all')
  const [passing, setPassing] = useState(false)
  const [ghost, setGhost] = useState<{ x: number; y: number; label: string } | null>(null)
  const drag = useRef<{ x: number; y: number; pitches: number[]; label: string; moved: boolean } | null>(null)
  const found = searchScales(query, family)
  const pads = chordsInKey(scale.root, scale.scale, scale.source)
  const tones = [...scaleTones(scale.root, scale.scale, 4), ...scaleTones(scale.root, scale.scale, 5)]

  function finish(event: { clientX: number; clientY: number; currentTarget: EventTarget | null }) {
    const current = drag.current
    drag.current = null
    setGhost(null)
    setPassing(false)
    if (!current) return
    if (!current.moved) {
      onPlace(current.pitches)
      return
    }
    const sheet = (event.currentTarget as HTMLElement | null)?.closest('.chord-sheet') as HTMLElement | null
    if (sheet) sheet.style.pointerEvents = 'none'
    const rollBeat = beatOnRoll(event.clientX, event.clientY)
    const dropped = rollBeat == null ? trackAt(store, event.clientX, event.clientY, playhead()) : null
    if (sheet) sheet.style.pointerEvents = ''
    if (rollBeat != null) {
      onPlace(current.pitches, { beat: rollBeat, trackId: '', clipId: null })
      return
    }
    if (dropped) onPlace(current.pitches, dropped)
  }

  return (
    <div className={`scale-browser ${passing ? 'passing' : ''}`}>
      <div className="chip-scroll" aria-label="Key">
        {NOTE_NAMES.map((name, index) => (
          <button key={name} type="button" className={scale.root === index ? 'on' : ''} onClick={() => store.setScale({ root: index })}>{name}</button>
        ))}
      </div>
      <div className="browser-search">
        <input aria-label="Search scales" placeholder="Search scales" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <div className="chip-scroll" aria-label="Scale family">
        <button type="button" className={family === 'all' ? 'on' : ''} onClick={() => setFamily('all')}>All</button>
        {SCALE_FAMILIES.map((item) => (
          <button key={item} type="button" className={family === item ? 'on' : ''} onClick={() => setFamily(item)}>{FAMILY_LABEL[item]}</button>
        ))}
      </div>
      <div className="scale-list" role="listbox" aria-label="Scales">
        {found.map((item) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={scale.scale === item.id}
            className={scale.scale === item.id ? 'on' : ''}
            onClick={() => store.setScale({ scale: item.id })}
          >
            <span>{item.name}</span>
            {item.microtonal ? <small>quarter tones</small> : <small>{FAMILY_LABEL[item.family]}</small>}
          </button>
        ))}
      </div>
      <div className="chip-scroll" aria-label="Chord set">
        {SETS.map((item) => (
          <button key={item.id} type="button" className={scale.source === item.id ? 'on' : ''} onClick={() => store.setScale({ source: item.id })}>{item.name}</button>
        ))}
      </div>
      <p className="browser-hint">Tap a chord to audition it and drop it at the playhead. Drag it onto the roll or a MIDI track.</p>
      <div className="chord-pads">
        {pads.map((pad, index) => (
          <button
            key={`${pad.name}-${index}`}
            type="button"
            className="chord-pad"
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.preventDefault()
              drag.current = { x: event.clientX, y: event.clientY, pitches: pad.pitches, label: pad.name, moved: false }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const current = drag.current
              if (!current) return
              if (!current.moved && Math.hypot(event.clientX - current.x, event.clientY - current.y) < 8) return
              current.moved = true
              setPassing(true)
              setGhost({ x: event.clientX, y: event.clientY, label: current.label })
            }}
            onPointerUp={finish}
            onPointerCancel={() => {
              drag.current = null
              setGhost(null)
              setPassing(false)
            }}
          >
            {pad.name}
          </button>
        ))}
      </div>
      <div className="scale-keys" aria-label="Scale tones">
        {tones.map((pitch) => (
          <button key={pitch} type="button" data-pitch={pitch}>
            {noteName(pitch)}{Math.floor(pitch / 12) - 1}
          </button>
        ))}
      </div>
      <div className="chord-depth">
        <label>Inv
          <select aria-label="Inversion" value={scale.inversion} onChange={(event) => store.setScale({ inversion: Number(event.target.value) })}>
            {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <button type="button" className={scale.drop2 ? 'on' : ''} onClick={() => store.setScale({ drop2: !scale.drop2, drop3: false, shell: false })}>Drop 2</button>
        <button type="button" className={scale.drop3 ? 'on' : ''} onClick={() => store.setScale({ drop3: !scale.drop3, drop2: false, shell: false })}>Drop 3</button>
        <button type="button" className={scale.shell ? 'on' : ''} onClick={() => store.setScale({ shell: !scale.shell, drop2: false, drop3: false })}>Shell</button>
        <button type="button" className={scale.spread ? 'on' : ''} onClick={() => store.setScale({ spread: !scale.spread })}>Spread</button>
        <button type="button" className={scale.octave ? 'on' : ''} onClick={() => store.setScale({ octave: !scale.octave })}>Octave</button>
        <button type="button" className={scale.voiceLead ? 'on' : ''} onClick={() => store.setScale({ voiceLead: !scale.voiceLead })}>Lead</button>
      </div>
      {ghost && createPortal(
        <div className="drag-ghost" style={{ left: ghost.x + 12, top: ghost.y + 12 }}>{ghost.label}</div>,
        document.body,
      )}
    </div>
  )
}

function trackAt(store: ProjectStore, x: number, y: number, playhead: number): ChordDrop | null {
  const hit = document.elementFromPoint(x, y)
  const node = hit?.closest('[data-track]') as HTMLElement | null
  const trackId = node?.dataset.track
  if (!node || !trackId) return null
  if (node.closest('.piano')) return null
  const track = store.project.tracks.find((item) => item.id === trackId)
  if (!track || track.type !== 'midi') return null
  const lane = node.classList.contains('lane') ? node : node.closest('.lane') as HTMLElement | null
  if (!lane) return { beat: playhead, trackId, clipId: null }
  const host = lane.closest('[data-px]') as HTMLElement | null
  const px = Number(host?.dataset.px || 90)
  const bounds = lane.getBoundingClientRect()
  const beat = Math.max(0, ((x - bounds.left) / Math.max(1, px)) * (store.project.tempo / 60))
  const clip = track.midiClips.find((item) => item.scene == null && !item.slotOnly && beat >= item.startBeat && beat <= item.startBeat + item.durationBeats + 0.01)
  return { beat, trackId, clipId: clip?.id ?? null }
}

import { useEffect, useRef, useState } from 'react'
import { clampCount, defaultAddSpec, type AddKind, type AddTrackSpec } from '../model/addTrack'
import type { TrackInstrument } from '../model/types'
import type { ProjectStore } from '../state/store'
import { useFormFactor } from './form'
import './guideSheet.css'

const LAST_KEY = 'cueharbor-last-track'
const KINDS: { id: AddKind; label: string; hint: string }[] = [
  { id: 'audio', label: 'Audio', hint: 'Record a voice or an instrument.' },
  { id: 'midi', label: 'Instrument', hint: 'Play MIDI or the on-screen keys.' },
  { id: 'drum', label: 'Drums', hint: 'A beat machine for this song.' },
  { id: 'bus', label: 'Bus', hint: 'Group tracks, or return an effect.' },
]
const INSTRUMENTS: { id: TrackInstrument; label: string; hint: string }[] = [
  { id: 'synth', label: 'Keys', hint: 'Play from the on-screen keyboard or a MIDI keyboard.' },
  { id: 'scaler', label: 'Scaler', hint: 'Chord pads that follow the song key.' },
  { id: 'pads', label: 'Pads', hint: 'A grid of drum and sample pads.' },
  { id: 'sampler', label: 'Sampler', hint: 'Play a loaded sample across the keys.' },
  { id: 'library', label: 'Library', hint: 'A multi-sample instrument from the library.' },
  { id: '808', label: '808', hint: 'Bass and drum tones from an 808.' },
  { id: 'none', label: 'Empty', hint: 'A MIDI track with no instrument yet.' },
]
const KITS: { id: TrackInstrument; label: string; hint: string }[] = [
  { id: 'drum-machine', label: 'Kit', hint: 'Kick, snare, clap, hat, and perc.' },
  { id: '808', label: '808', hint: 'The 808 drum instrument.' },
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

export function AddTrackPanel({
  spec,
  place,
  onChange,
  onCancel,
  onCommit,
}: {
  spec: AddTrackSpec
  place: 'sheet' | 'pop'
  onChange: (next: AddTrackSpec) => void
  onCancel: () => void
  onCommit: () => void
}) {
  const kind = KINDS.find((item) => item.id === spec.kind) ?? KINDS[0]
  const inputNumber = spec.inputIndex ?? 1
  return (
    <div className={`guide-sheet add-sheet ${place}`} role="dialog" aria-label="Add track">
      {place === 'sheet' && <div className="guide-handle" aria-hidden="true" />}
      <header className="guide-head">
        <div>
          <h2>Add track</h2>
          <p>Pick a type, then add. The new track is selected and stays quiet until you arm it.</p>
        </div>
        <button type="button" className="guide-x" onClick={onCancel} aria-label="Cancel. Close add track.">Cancel</button>
      </header>
      <section className="guide-section">
        <h3>Track type</h3>
        <div className="guide-cards">
          {KINDS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`guide-card${spec.kind === item.id ? ' on' : ''}`}
              aria-pressed={spec.kind === item.id}
              onClick={() => onChange({ ...spec, kind: item.id })}
            >
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </button>
          ))}
        </div>
      </section>
      {spec.kind === 'audio' && (
        <>
          <section className="guide-section">
            <h3>Input</h3>
            <div className="guide-row">
              <button type="button" className={`guide-choice${spec.input === 'mic' ? ' on' : ''}`} aria-pressed={spec.input === 'mic'} onClick={() => onChange({ ...spec, input: 'mic' })}>
                <strong>Mic</strong>
                <small>The microphone.</small>
              </button>
              <button type="button" className={`guide-choice${spec.input === 'line' ? ' on' : ''}`} aria-pressed={spec.input === 'line'} onClick={() => onChange({ ...spec, input: 'line' })}>
                <strong>Line</strong>
                <small>A line input, such as a keyboard or interface.</small>
              </button>
            </div>
          </section>
          <section className="guide-section">
            <h3>Channels</h3>
            <div className="guide-row">
              <button type="button" className={`guide-choice${spec.channels === 1 ? ' on' : ''}`} aria-pressed={spec.channels === 1} onClick={() => onChange({ ...spec, channels: 1 })}>
                <strong>Mono</strong>
                <small>One channel.</small>
              </button>
              <button type="button" className={`guide-choice${spec.channels === 2 ? ' on' : ''}`} aria-pressed={spec.channels === 2} onClick={() => onChange({ ...spec, channels: 2 })}>
                <strong>Stereo</strong>
                <small>Left and right.</small>
              </button>
            </div>
          </section>
          <section className="guide-section">
            <h3>Input number</h3>
            <label className="guide-choice">
              <strong>Input {inputNumber}</strong>
              <small>Which numbered input this track records.</small>
              <select
                aria-label={`Input number. Input ${inputNumber}.`}
                value={inputNumber}
                onChange={(event) => onChange({ ...spec, inputIndex: Number(event.target.value) })}
              >
                {Array.from({ length: 8 }, (_, index) => index + 1).map((number) => (
                  <option key={number} value={number}>Input {number}</option>
                ))}
              </select>
            </label>
          </section>
          <section className="guide-section">
            <h3>Record</h3>
            <button
              type="button"
              className={`guide-choice${spec.armed ? ' on' : ''}`}
              aria-pressed={spec.armed}
              onClick={() => onChange({ ...spec, armed: !spec.armed })}
            >
              <strong>{spec.armed ? 'Arm after adding' : 'Leave disarmed'}</strong>
              <small>Only an armed track records when you press record. This starts off.</small>
            </button>
          </section>
        </>
      )}
      {spec.kind === 'midi' && (
        <section className="guide-section">
          <h3>Instrument</h3>
          <div className="guide-cards">
            {INSTRUMENTS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`guide-card${spec.instrument === item.id ? ' on' : ''}`}
                aria-pressed={spec.instrument === item.id}
                onClick={() => onChange({ ...spec, instrument: item.id })}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </section>
      )}
      {spec.kind === 'drum' && (
        <section className="guide-section">
          <h3>Kit</h3>
          <div className="guide-row">
            {KITS.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`guide-choice${(spec.instrument === '808' ? '808' : 'drum-machine') === item.id ? ' on' : ''}`}
                aria-pressed={(spec.instrument === '808' ? '808' : 'drum-machine') === item.id}
                onClick={() => onChange({ ...spec, instrument: item.id })}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </section>
      )}
      <div className="guide-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" onClick={onCommit}>Add {kind.label} track</button>
      </div>
    </div>
  )
}

export function AddTrackButton({ store }: { store: ProjectStore }) {
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState<AddTrackSpec>({ ...defaultAddSpec(), inputIndex: 1, instrument: 'synth', count: 1, armed: false })
  const place = useFormFactor() === 'desk' ? 'pop' : 'sheet'
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
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function commit(next: AddTrackSpec) {
    const saved = { ...next, count: clampCount(next.count || 1) }
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
        <>
          <button type="button" className="guide-scrim" aria-label="Close add track" onClick={() => setOpen(false)} />
          <AddTrackPanel spec={spec} place={place} onChange={setSpec} onCancel={() => setOpen(false)} onCommit={() => commit(spec)} />
        </>
      )}
    </div>
  )
}

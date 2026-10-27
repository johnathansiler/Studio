import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { samplesToBeats } from '../model/time'
import {
  NOTE_NAMES,
  SCALES,
  diatonicPads,
  detectKey,
  inScale,
  nameChord,
  noteName,
  scaleTones,
  snapPitch,
  voiceChord,
  type ArpDirection,
  type ChordSource,
  type RhythmPattern,
  type ScaleId,
} from '../model/scale'
import type { ProjectStore } from '../state/store'

const SOURCES: { id: ChordSource; name: string }[] = [
  { id: 'triads', name: 'Triads' },
  { id: 'sevenths', name: '7ths' },
  { id: 'ninths', name: '9ths' },
  { id: 'sus', name: 'Sus' },
  { id: 'add', name: 'Add' },
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

export function PianoRoll({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId)
  const [open, setOpen] = useState(false)
  const midiRef = useRef<MIDIAccess | null>(null)
  const playRef = useRef<(pitch: number, velocity: number) => void>(() => {})
  const scale = store.scaleState()

  playRef.current = (pitch, velocity) => {
    if (!track || !clip) return
    const current = store.scaleState()
    const next = current.snap ? snapPitch(pitch, current.root, current.scale) : pitch
    engine.unlock()
    engine.previewPitches([next])
    store.addNote(track.id, clip.id, { pitch: next, startBeat: clipBeat(store, engine, clip.startBeat), durationBeats: 1, velocity })
  }

  useEffect(() => {
    return () => {
      const access = midiRef.current
      if (!access) return
      access.onstatechange = null
      for (const input of access.inputs.values()) input.onmidimessage = null
    }
  }, [])

  if (!track || !clip) return null
  const low = 48
  const high = 84
  const pxBeat = 70
  const width = Math.max(clip.durationBeats, 8) * pxBeat
  const selected = clip.notes.filter((note) => store.selectedNoteIds.includes(note.id))
  const chord = selected.length ? nameChord(selected.map((note) => note.pitch)) : ''
  const pads = diatonicPads(scale.root, scale.scale, scale.source)
  const tones = [...scaleTones(scale.root, scale.scale, 4), ...scaleTones(scale.root, scale.scale, 5)]

  function playPad(pitches: number[]) {
    engine.unlock()
    const current = store.scaleState()
    const voiced = voiceChord(pitches, {
      inversion: current.inversion,
      spread: current.spread,
      drop2: current.drop2,
      octave: current.octave,
      voiceLead: current.voiceLead,
      previous: current.lastVoicing,
    })
    engine.previewPitches(voiced)
    store.insertPerformance(track!.id, clip!.id, timelineBeat(store, engine), pitches)
  }

  async function toggleChords() {
    const next = !open
    setOpen(next)
    if (!next || midiRef.current || !navigator.requestMIDIAccess) return
    try {
      const access = await navigator.requestMIDIAccess()
      midiRef.current = access
      const bind = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            const data = event.data
            if (!data || data.length < 3) return
            const status = data[0] & 0xf0
            if (status === 0x90 && data[2] > 0) playRef.current(data[1], data[2] / 127)
          }
        }
      }
      bind()
      access.onstatechange = bind
    } catch {
      /* MIDI permission denied or unavailable. */
    }
  }

  return (
    <div className="piano">
      <div className="scale-bar">
        <select aria-label="Key" value={scale.root} onChange={(event) => store.setScale({ root: Number(event.target.value) })}>
          {NOTE_NAMES.map((name, index) => (
            <option key={name} value={index}>{name}</option>
          ))}
        </select>
        <select aria-label="Scale" value={scale.scale} onChange={(event) => store.setScale({ scale: event.target.value as ScaleId })}>
          {SCALES.map((item) => (
            <option key={item.id} value={item.id}>{item.name}</option>
          ))}
        </select>
        <button type="button" className={scale.snap ? 'on' : ''} aria-pressed={scale.snap} onClick={() => store.setScale({ snap: !scale.snap })}>Snap</button>
        <button type="button" onClick={() => {
          const found = detectKey(clip.notes.map((note) => ({ pitch: note.pitch, weight: note.durationBeats })))
          store.setScale({ root: found.root, scale: found.scale })
        }}>Detect</button>
        <span className="chord-name">{chord}</span>
        <button type="button" className={open ? 'on' : ''} aria-expanded={open} onClick={() => void toggleChords()}>Chords</button>
      </div>
      <div className="piano-body">
        <div className="keys">
          {Array.from({ length: high - low + 1 }, (_, index) => {
            const pitch = high - index
            const black = [1, 3, 6, 8, 10].includes(pitch % 12)
            return (
              <div key={pitch} className={`key ${black ? 'black' : ''} ${inScale(pitch, scale.root, scale.scale) ? 'in' : ''}`}>
                {pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}
              </div>
            )
          })}
        </div>
        <div className="roll">
          <div
            style={{ width, height: (high - low + 1) * 16, position: 'relative' }}
            onClick={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect()
              const beat = Math.floor((event.clientX - bounds.left) / (pxBeat / 4)) / 4
              const pitch = high - Math.floor((event.clientY - bounds.top) / 16)
              store.addNote(track.id, clip.id, { pitch, startBeat: Math.max(0, beat), durationBeats: 1, velocity: 0.8 })
            }}
          >
            {clip.notes.map((note) => (
              <div
                key={note.id}
                className={`note ${store.selectedNoteIds.includes(note.id) ? 'selected' : ''} ${inScale(note.pitch, scale.root, scale.scale) ? '' : 'off'}`}
                style={{ left: note.startBeat * pxBeat, width: Math.max(8, note.durationBeats * pxBeat), top: (high - note.pitch) * 16 }}
                onClick={(event) => {
                  event.stopPropagation()
                  store.selectNote(note.id, event.shiftKey || event.metaKey)
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  const originX = event.clientX
                  const originY = event.clientY
                  const originBeat = note.startBeat
                  const originPitch = note.pitch
                  let next = originBeat
                  let nextPitch = originPitch
                  const move = (ev: PointerEvent) => {
                    next = Math.max(0, Math.round((originBeat + (ev.clientX - originX) / pxBeat) * 4) / 4)
                    nextPitch = Math.max(0, Math.min(127, originPitch + Math.round((originY - ev.clientY) / 16)))
                    const node = event.currentTarget as HTMLDivElement
                    node.style.left = `${next * pxBeat}px`
                    node.style.top = `${(high - nextPitch) * 16}px`
                  }
                  const up = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', up)
                    if (next !== originBeat || nextPitch !== originPitch) {
                      store.updateNote(track.id, clip.id, note.id, { startBeat: next, pitch: nextPitch })
                    }
                  }
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', up)
                }}
              />
            ))}
          </div>
        </div>
      </div>
      {open && (
        <div className="chord-sheet">
          <div className="chord-top">
            <select aria-label="Chord set" value={scale.source} onChange={(event) => store.setScale({ source: event.target.value as ChordSource })}>
              {SOURCES.map((item) => (
                <option key={item.id} value={item.id}>{item.name}</option>
              ))}
            </select>
          </div>
          <div className="chord-pads">
            {pads.map((pad, index) => (
              <button key={`${pad.label}-${index}`} type="button" onClick={() => playPad(pad.pitches)}>{pad.label}</button>
            ))}
          </div>
          <div className="scale-keys">
            {tones.map((pitch) => (
              <button key={pitch} type="button" onClick={() => playRef.current(pitch, 0.8)}>
                {noteName(pitch)}{Math.floor(pitch / 12) - 1}
              </button>
            ))}
          </div>
          <details className="chord-depth">
            <summary>More</summary>
            <label>Inv
              <select aria-label="Inversion" value={scale.inversion} onChange={(event) => store.setScale({ inversion: Number(event.target.value) })}>
                {[0, 1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <button type="button" className={scale.spread ? 'on' : ''} onClick={() => store.setScale({ spread: !scale.spread })}>Spread</button>
            <button type="button" className={scale.drop2 ? 'on' : ''} onClick={() => store.setScale({ drop2: !scale.drop2 })}>Drop2</button>
            <button type="button" className={scale.octave ? 'on' : ''} onClick={() => store.setScale({ octave: !scale.octave })}>Octave</button>
            <button type="button" className={scale.voiceLead ? 'on' : ''} onClick={() => store.setScale({ voiceLead: !scale.voiceLead })}>Lead</button>
            <select aria-label="Arp" value={scale.arp} onChange={(event) => store.setScale({ arp: event.target.value as ArpDirection })}>
              {(['off', 'up', 'down', 'upDown', 'random'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Rate" value={scale.rate} onChange={(event) => store.setScale({ rate: Number(event.target.value) })}>
              {[0.25, 0.5, 1, 2].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Gate" value={scale.gate} onChange={(event) => store.setScale({ gate: Number(event.target.value) })}>
              {[0.5, 0.8, 1].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Octaves" value={scale.octaves} onChange={(event) => store.setScale({ octaves: Number(event.target.value) })}>
              {[1, 2, 3].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <select aria-label="Rhythm" value={scale.rhythm} onChange={(event) => store.setScale({ rhythm: event.target.value as RhythmPattern })}>
              {(['block', 'quarter', 'eighth', 'sync', 'strum'] as const).map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <label>Time
              <input aria-label="Timing" type="range" min={0} max={0.2} step={0.01} value={scale.timing} onChange={(event) => store.setScale({ timing: Number(event.target.value) })} />
            </label>
            <label>Vel
              <input aria-label="Velocity" type="range" min={0} max={1} step={0.05} value={scale.velocity} onChange={(event) => store.setScale({ velocity: Number(event.target.value) })} />
            </label>
          </details>
        </div>
      )}
    </div>
  )
}

function timelineBeat(store: ProjectStore, engine: AudioEngine) {
  const project = store.project
  let beat = samplesToBeats(engine.currentTimelineSample(), project.sampleRate, project.tempo)
  if (project.snap) beat = Math.round(beat * 4) / 4
  return Math.max(0, beat)
}

function clipBeat(store: ProjectStore, engine: AudioEngine, clipStart: number) {
  return Math.max(0, timelineBeat(store, engine) - clipStart)
}

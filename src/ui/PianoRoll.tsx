import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { samplesToBeats } from '../model/time'
import {
  ROLL_TOOLS,
  arpeggiateSelection,
  eraseNotes,
  glueNotes,
  humanizeNotes,
  paintCc,
  paintChords,
  paintNotes,
  quantizeNotes,
  sliceNote,
  strumSelection,
  type RollTool,
} from '../model/paint'
import {
  NOTE_NAMES,
  SCALES,
  diatonicPads,
  detectKey,
  inScale,
  nameChord,
  noteName,
  scaleById,
  scaleTones,
  snapPitch,
  voiceChord,
  type ArpDirection,
  type ChordSource,
  type RhythmPattern,
  type ScaleId,
} from '../model/scale'
import { uid, type MidiNote } from '../model/types'
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

export function PianoRoll({ store, engine, onIdeas }: { store: ProjectStore; engine: AudioEngine; onIdeas?: () => void }) {
  const track = store.project.tracks.find((item) => item.midiClips.some((clip) => clip.id === store.selectedMidiClipId))
  const clip = track?.midiClips.find((item) => item.id === store.selectedMidiClipId)
  const [open, setOpen] = useState(false)
  const [row, setRow] = useState(16)
  const rowRef = useRef(row)
  rowRef.current = row
  const rollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rollRef.current
    if (!el) return
    let startDist = 0
    let startRow = rowRef.current
    const distance = (touches: TouchList) => Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
    const start = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        startDist = distance(event.touches)
        startRow = rowRef.current
      }
    }
    const move = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !startDist) return
      event.preventDefault()
      setRow(Math.min(44, Math.max(12, startRow * (distance(event.touches) / startDist))))
    }
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchmove', move, { passive: false })
    return () => {
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchmove', move)
    }
  }, [clip?.id])
  const midiRef = useRef<MIDIAccess | null>(null)
  const playRef = useRef<(pitch: number, velocity: number) => void>(() => {})
  const scale = store.scaleState()
  const roll = store.project.roll ?? { tool: 'pen' as RollTool, grid: 0.25, length: 0.25, velocity: 0.8 }
  const gesture = useRef<{ from: number; to: number; pitch: number; y: number } | null>(null)

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      const tools: Record<string, RollTool> = { '1': 'paint', '2': 'brush', '3': 'pen', '4': 'slice', '5': 'glue', '6': 'mute', '7': 'erase', '8': 'velocity', '9': 'cc' }
      if (tools[event.key]) store.setRollTool(tools[event.key])
      else if (event.key === 'q' && !event.metaKey && !event.ctrlKey) quantize()
      else if (event.key === 'a' && !event.metaKey && !event.ctrlKey) arpeggiate()
      else if (event.key === 'u' && !event.metaKey && !event.ctrlKey) strum()
      else if (event.key === 'h' && !event.metaKey && !event.ctrlKey) humanize()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!track || !clip) return null
  const low = 48
  const high = 84
  const pxBeat = 70
  const width = Math.max(clip.durationBeats, 8) * pxBeat
  const selected = clip.notes.filter((note) => store.selectedNoteIds.includes(note.id))
  const chord = selected.length ? nameChord(selected.map((note) => note.pitch)) : ''
  const pads = diatonicPads(scale.root, scale.scale, scale.source)
  const tones = [...scaleTones(scale.root, scale.scale, 4), ...scaleTones(scale.root, scale.scale, 5)]

  function withNotes(next: MidiNote[]) {
    store.replaceNotes(track!.id, clip!.id, next)
  }

  function quantize() {
    if (!clip) return
    const ids = store.selectedNoteIds.length ? store.selectedNoteIds : undefined
    withNotes(quantizeNotes(clip.notes, roll.grid, ids).map((note) => ({ ...note, id: note.id || uid('note') })))
  }

  function arpeggiate() {
    if (!clip) return
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    const played = arpeggiateSelection(chosen, { arp: scale.arp, rate: scale.rate, gate: scale.gate, octaves: scale.octaves, timing: scale.timing, velocity: scale.velocity })
    withNotes([...rest, ...played.map((note) => ({ ...note, id: uid('note') }))])
  }

  function strum() {
    if (!clip) return
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    withNotes([...rest, ...strumSelection(chosen).map((note) => ({ ...note, id: uid('note') }))])
  }

  function humanize() {
    if (!clip) return
    const chosen = clip.notes.filter((note) => !store.selectedNoteIds.length || store.selectedNoteIds.includes(note.id))
    const rest = store.selectedNoteIds.length ? clip.notes.filter((note) => !store.selectedNoteIds.includes(note.id)) : []
    withNotes([...rest, ...humanizeNotes(chosen, scale.timing || 0.02, scale.velocity || 0.3)])
  }

  function commitGesture(from: number, to: number, pitch: number, y: number) {
    if (!clip) return
    const length = roll.length || 0.25
    const velocity = roll.velocity || 0.8
    if (roll.tool === 'paint') {
      const notes = paintNotes({ fromBeat: from, toBeat: to, pitch, grid: roll.grid, length, velocity, scaleLock: scale.snap, root: scale.root, scale: scale.scale })
      withNotes([...clip.notes, ...notes.map((note) => ({ ...note, id: uid('note') }))])
    } else if (roll.tool === 'brush') {
      const intervals = scaleById(scale.scale).intervals
      const notes = paintChords({ fromBeat: from, toBeat: to, pitch, grid: roll.grid, length, velocity, root: scale.root, scale: scale.scale, intervals })
      withNotes([...clip.notes, ...notes.map((note) => ({ ...note, id: uid('note') }))])
    } else if (roll.tool === 'pen') {
      const beat = roll.grid > 0 ? Math.max(0, Math.round(from / roll.grid) * roll.grid) : Math.max(0, from)
      const nextPitch = scale.snap ? snapPitch(pitch, scale.root, scale.scale) : pitch
      withNotes([...clip.notes, { id: uid('note'), pitch: nextPitch, startBeat: beat, durationBeats: length, velocity }])
    } else if (roll.tool === 'erase') {
      withNotes(eraseNotes(clip.notes, from, Math.max(from + 0.05, to), null))
    } else if (roll.tool === 'velocity') {
      const value = Math.max(0.05, Math.min(1, 1 - y))
      const start = Math.min(from, to)
      const end = Math.max(from, to)
      withNotes(clip.notes.map((note) => (note.startBeat >= start && note.startBeat <= end ? { ...note, velocity: value } : note)))
    } else if (roll.tool === 'cc') {
      const lane = store.project.automation.find((item) => item.param === 'expression') ?? {
        id: uid('auto'),
        pluginId: 'midi',
        param: 'expression',
        points: [],
      }
      const points = paintCc(lane.points, from, to, Math.max(0, Math.min(1, 1 - y)), roll.grid)
      store.mutateAutomation(lane.id, lane.pluginId, points)
    } else if (roll.tool === 'glue') {
      withNotes(glueNotes(clip.notes).map((note) => ({ ...note, id: note.id || uid('note') })))
    }
  }

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
        <button type="button" className={`chords-btn ${open ? 'on' : ''}`} aria-expanded={open} onClick={() => void toggleChords()}>Chords</button>
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
        {onIdeas && <button type="button" onClick={onIdeas}>Ideas</button>}
        {store.selectedNoteId && (
          <button
            type="button"
            className={clip.notes.find((note) => note.id === store.selectedNoteId)?.slide ? 'on' : ''}
            onClick={() => {
              const note = clip.notes.find((item) => item.id === store.selectedNoteId)
              if (note) store.updateNote(track.id, clip.id, note.id, { slide: !note.slide })
            }}
          >
            {clip.notes.find((note) => note.id === store.selectedNoteId)?.slide ? 'Slide on' : 'Slide'}
          </button>
        )}
      </div>
      <div className="tool-row">
        {ROLL_TOOLS.map((tool) => (
          <button key={tool} type="button" className={roll.tool === tool ? 'on' : ''} onClick={() => store.setRollTool(tool)}>{tool}</button>
        ))}
        <select aria-label="Grid" value={String(roll.grid)} onChange={(event) => store.setRoll({ grid: Number(event.target.value) })}>
          <option value="0">Free</option>
          <option value="0.25">1/16</option>
          <option value="0.5">1/8</option>
          <option value="1">1/4</option>
        </select>
        <button type="button" onClick={quantize}>Quantize</button>
        <button type="button" onClick={arpeggiate}>Arp</button>
        <button type="button" onClick={strum}>Strum</button>
      </div>
      <div className="piano-body">
        <div className="keys">
          {Array.from({ length: high - low + 1 }, (_, index) => {
            const pitch = high - index
            const black = [1, 3, 6, 8, 10].includes(pitch % 12)
            return (
              <div key={pitch} className={`key ${black ? 'black' : ''} ${inScale(pitch, scale.root, scale.scale) ? 'in' : ''}`} style={{ height: row }}>
                {pitch % 12 === 0 ? `C${Math.floor(pitch / 12) - 1}` : ''}
              </div>
            )
          })}
        </div>
        <div className="roll" ref={rollRef}>
          <div
            style={{ width, height: (high - low + 1) * row, position: 'relative' }}
            onPointerDown={(event) => {
              if ((event.target as HTMLElement).closest('.note')) return
              const bounds = event.currentTarget.getBoundingClientRect()
              const beat = (event.clientX - bounds.left) / pxBeat
              const pitch = high - Math.floor((event.clientY - bounds.top) / row)
              gesture.current = { from: Math.max(0, beat), to: Math.max(0, beat), pitch, y: (event.clientY - bounds.top) / bounds.height }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              if (!gesture.current) return
              const bounds = event.currentTarget.getBoundingClientRect()
              gesture.current.to = Math.max(0, (event.clientX - bounds.left) / pxBeat)
              gesture.current.y = (event.clientY - bounds.top) / Math.max(1, bounds.height)
            }}
            onPointerUp={() => {
              const current = gesture.current
              gesture.current = null
              if (!current) return
              commitGesture(current.from, current.to, current.pitch, current.y)
            }}
          >
            {clip.notes.map((note) => (
              <div
                key={note.id}
                className={`note ${store.selectedNoteIds.includes(note.id) ? 'selected' : ''} ${inScale(note.pitch, scale.root, scale.scale) ? '' : 'off'} ${note.slide ? 'slide' : ''}`}
                style={{ left: note.startBeat * pxBeat, width: Math.max(8, note.durationBeats * pxBeat), top: (high - note.pitch) * row, height: Math.max(12, row - 2) }}
                onClick={(event) => {
                  event.stopPropagation()
                  store.selectNote(note.id, event.shiftKey || event.metaKey)
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  if (roll.tool === 'slice') {
                    const bounds = (event.currentTarget.parentElement as HTMLElement).getBoundingClientRect()
                    const at = (event.clientX - bounds.left) / pxBeat
                    const parts = sliceNote(note, at)
                    if (parts) withNotes(clip.notes.flatMap((item) => (item.id === note.id ? [{ ...parts[0] }, { ...parts[1], id: uid('note') }] : [item])))
                    return
                  }
                  if (roll.tool === 'mute') {
                    withNotes(clip.notes.map((item) => (item.id === note.id ? { ...item, muted: !item.muted } : item)))
                    return
                  }
                  if (roll.tool === 'erase') {
                    withNotes(clip.notes.filter((item) => item.id !== note.id))
                    return
                  }
                  if (roll.tool === 'glue') {
                    withNotes(glueNotes(clip.notes))
                    return
                  }
                  const originX = event.clientX
                  const originY = event.clientY
                  const originBeat = note.startBeat
                  const originPitch = note.pitch
                  let next = originBeat
                  let nextPitch = originPitch
                  const move = (ev: PointerEvent) => {
                    next = Math.max(0, Math.round((originBeat + (ev.clientX - originX) / pxBeat) * 4) / 4)
                    nextPitch = Math.max(0, Math.min(127, originPitch + Math.round((originY - ev.clientY) / row)))
                    const node = event.currentTarget as HTMLDivElement
                    node.style.left = `${next * pxBeat}px`
                    node.style.top = `${(high - nextPitch) * row}px`
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

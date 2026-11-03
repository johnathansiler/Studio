import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AudioEngine } from '../audio/engine'
import { performanceOwnsMidi, stepOwnsMidi } from '../midi/remember'
import { heardBeat } from '../model/midiClock'
import { INSTRUMENT_HINT, noteTarget } from '../model/noteTarget'
import {
  claimComputerKey,
  keyboardDestination,
  keyboardHome,
  keyboardPitch,
  keyboardStart,
  rollOwnsKeys,
} from '../model/keyboardPlay'
import { armSounded, releaseGesture, releaseKey, takeGroups, type ArmedKey, type RecordedKey } from '../model/keyboardRecord'
import { samplesToBeats } from '../model/time'
import { playScalerLive } from '../instruments/scaler/live'
import { typingTarget } from '../state/history'
import type { ProjectStore } from '../state/store'
import { octaveName } from './kit/controls'
import { notifyKeyboard } from './keyboardStage'
import { miniPads, padGridColumn, padLabel } from './miniKeys'

/** Play one note, or a Scaler chord when keys lock says so. Returns the pitches that sounded. */
export function playKeyboardNote(store: ProjectStore, engine: AudioEngine, pitch: number, velocity = 0.85): number[] {
  const target = noteTarget(store.project.tracks, store.selectedTrackId)
  const level = Math.max(0.05, Math.min(1, velocity))
  if (target.kind === 'silent') return []
  if (target.kind === 'tune') {
    store.updatePlugin(target.trackId, target.pluginId, { params: { holdMidi: Math.max(0, Math.min(127, Math.round(pitch))) } })
    return [pitch]
  }
  const live = playScalerLive(store.project, engine, target.trackId, pitch, level)
  if (live !== null) return live.map((note) => note.midi)
  engine.playThrough(target.trackId, pitch, level)
  return [pitch]
}

export function releaseKeyboardNote(store: ProjectStore, engine: AudioEngine, pitch: number) {
  const target = noteTarget(store.project.tracks, store.selectedTrackId)
  if (target.kind === 'tune') {
    store.updatePlugin(target.trackId, target.pluginId, { params: { holdMidi: -1 } })
    return
  }
  if (target.kind === 'instrument') engine.releaseThrough(target.trackId, pitch)
}

export function holdTune(store: ProjectStore, midi: number | null) {
  const target = noteTarget(store.project.tracks, store.selectedTrackId)
  if (target.kind !== 'tune') return
  store.updatePlugin(target.trackId, target.pluginId, { params: { holdMidi: midi == null ? -1 : midi } })
}

/** Open-clip notes join that clip. Other notes become one MIDI take per track. */
export function commitKeyboardNotes(store: ProjectStore, notes: RecordedKey[]) {
  for (const note of notes) {
    if (!note.clipId) continue
    store.addNote(note.trackId, note.clipId, {
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
    })
  }
  for (const group of takeGroups(notes)) {
    if (!group.notes.length) continue
    store.placeMidiTake(group.trackId, group.startBeat, group.notes, 'Keyboard')
  }
}

function beatAt(store: ProjectStore, engine: AudioEngine, eventMs: number) {
  if (typeof engine.playOrigin === 'function' && typeof engine.outputStamp === 'function' && typeof engine.clockCompensation === 'function') {
    const origin = engine.playOrigin()
    const clock = engine.clockCompensation()
    return Math.max(0, heardBeat({
      eventMs,
      stamp: engine.outputStamp(),
      originContext: origin.context,
      originBeat: origin.beat,
      tempo: store.project.tempo,
      outputLatency: clock.outputLatency,
      baseLatency: clock.baseLatency,
      calibrationSec: clock.calibrationSec,
      quantizeBeats: store.project.quantizeBeats || 0,
    }))
  }
  return Math.max(0, samplesToBeats(engine.positionSamples || 0, store.project.sampleRate, store.project.tempo))
}

export function KeyboardToggle({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  return (
    <button
      type="button"
      className={`keyboard-toggle${store.keyboardMidi ? ' on' : ''}`}
      aria-pressed={store.keyboardMidi}
      aria-label="Keyboard. Show the on-screen piano."
      title="Show the on-screen piano."
      onClick={() => {
        engine.unlock()
        const next = !store.keyboardMidi
        store.setKeyboardMidi(next)
        notifyKeyboard(next)
      }}
    >
      <KeyboardIcon />
      <span>Keyboard</span>
    </button>
  )
}

/** Close and Keyboard stay outside the scrolling tool row. */
export function EditorPinned({
  store,
  engine,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  onClose?: () => void
}) {
  return (
    <div className="roll-pinned">
      {onClose && (
        <button type="button" className="roll-close" onClick={onClose}>
          Close
        </button>
      )}
      <KeyboardToggle store={store} engine={engine} />
    </div>
  )
}

export function KeyboardDock({ store, engine, onEditNotes }: { store: ProjectStore; engine: AudioEngine; onEditNotes?: () => void }) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  const route = noteTarget(store.project.tracks, store.selectedTrackId)
  const editor = store.midiEditor()
  const octave = editor.octave
  const [lit, setLit] = useState<number[]>([])
  const held = useRef(new Map<string, number[]>())
  const armed = useRef<ArmedKey[]>([])
  const pending = useRef<RecordedKey[]>([])
  const recording = useRef(engine.status === 'recording')
  const shiftRef = useRef<(delta: -1 | 1) => void>(() => undefined)
  const octaveRef = useRef(octave)
  const pressRef = useRef<(token: string, pitch: number, velocity: number, eventMs: number) => void>(() => undefined)
  const releaseRef = useRef<(token: string, eventMs: number) => void>(() => undefined)
  octaveRef.current = octave

  function shift(delta: -1 | 1) {
    store.setMidiEditor({ octave: octave + delta })
  }
  shiftRef.current = shift

  function paint() {
    setLit([...new Set([...held.current.values()].flat())])
  }

  function flush(nowMs: number) {
    const end = beatAt(store, engine, nowMs)
    const finished: RecordedKey[] = []
    for (const key of armed.current) {
      const released = releaseKey([key], key.token, end)
      if (released.note) finished.push(released.note)
    }
    armed.current = []
    finished.push(...pending.current)
    pending.current = []
    if (finished.length) commitKeyboardNotes(store, finished)
  }

  function press(token: string, pitch: number, velocity = 0.85, eventMs = performance.now()) {
    if (held.current.has(token)) return
    const target = noteTarget(store.project.tracks, store.selectedTrackId)
    if (target.kind === 'silent') return
    const level = Math.max(0.05, Math.min(1, velocity))
    const sounded = playKeyboardNote(store, engine, pitch, level)
    if (!sounded.length) return
    held.current.set(token, sounded)
    recording.current = engine.status === 'recording'
    if (recording.current && target.kind === 'instrument' && target.armed) {
      const dest = keyboardDestination(store.project.tracks, store.selectedTrackId, store.selectedMidiClipId)
      if (dest && dest.trackId === target.trackId) {
        armed.current = armSounded(armed.current, token, sounded, {
          trackId: dest.trackId,
          clipId: dest.clipId,
          clipStart: dest.clipStart,
          velocity: level,
          startBeat: beatAt(store, engine, eventMs),
        })
      }
    }
    paint()
  }
  pressRef.current = press

  function release(token: string, eventMs = performance.now()) {
    const pitches = held.current.get(token)
    if (!pitches) return
    held.current.delete(token)
    const target = noteTarget(store.project.tracks, store.selectedTrackId)
    if (target.kind === 'tune') {
      const rest = [...held.current.values()].flat()
      holdTune(store, rest.length ? rest[rest.length - 1] : null)
      paint()
      return
    }
    const others = new Set([...held.current.values()].flat())
    for (const pitch of pitches) if (!others.has(pitch)) releaseKeyboardNote(store, engine, pitch)
    const released = releaseGesture(armed.current, token, beatAt(store, engine, eventMs))
    armed.current = released.keys
    if (released.notes.length && recording.current) {
      const intoClip = released.notes.filter((note) => note.clipId)
      const loose = released.notes.filter((note) => !note.clipId)
      if (intoClip.length) commitKeyboardNotes(store, intoClip)
      pending.current.push(...loose)
    }
    paint()
  }
  releaseRef.current = release

  useEffect(() => {
    recording.current = engine.status === 'recording'
    return engine.subscribe(() => {
      const next = engine.status === 'recording'
      if (recording.current && !next) flush(performance.now())
      recording.current = next
    })
  }, [store, engine])

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      const claim = claimComputerKey({
        enabled: store.keyboardMidi,
        typing: typingTarget(event.target as HTMLElement | null),
        meta: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        repeat: event.repeat,
        held: held.current.has(event.code || event.key),
        code: event.code,
        key: event.key,
      })
      if (!claim) return
      if (claim === 'octave-down' || claim === 'octave-up') {
        if (stepOwnsMidi()) return
        event.preventDefault()
        shiftRef.current(claim === 'octave-down' ? -1 : 1)
        return
      }
      if (rollOwnsKeys() || stepOwnsMidi() || performanceOwnsMidi()) return
      event.preventDefault()
      if (claim === 'note') {
        const home = keyboardHome(event.code, event.key)
        if (home == null) return
        pressRef.current(event.code || event.key, keyboardPitch(home, octaveRef.current), 0.85, event.timeStamp)
      }
    }
    const onUp = (event: KeyboardEvent) => {
      if (!store.keyboardMidi) return
      releaseRef.current(event.code || event.key, event.timeStamp)
    }
    const blur = () => {
      for (const token of [...held.current.keys()]) releaseRef.current(token, performance.now())
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', blur)
    return () => {
      blur()
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', blur)
    }
  }, [store, engine, store.keyboardMidi])

  if (!store.keyboardMidi) return null
  const pads = miniPads(octave)
  const name = octaveName(keyboardStart(octave))
  const atBottom = octave <= -4
  const atTop = octave >= 5
  return (
    <div className="keyboard-dock" data-keyboard-dock="open" data-keyboard="pads">
      <div className="keyboard-face">
      <div className="keyboard-octave" role="group" aria-label="Octave">
        <button type="button" disabled={atBottom} onClick={() => shift(-1)}>Octave Down</button>
        <span aria-live="polite">{name}</span>
        <button type="button" disabled={atTop} onClick={() => shift(1)}>Octave Up</button>
        <button type="button" className="keyboard-edit" onClick={() => onEditNotes?.()}>Edit Notes</button>
        <button type="button" className="keyboard-close" onClick={() => { store.setKeyboardMidi(false); notifyKeyboard(false) }}>Close</button>
      </div>
      {route.kind === 'silent' && <p className="keyboard-hint" role="status">{INSTRUMENT_HINT}</p>}
      <div className="mini-board" role="group" aria-label="Piano keyboard">
        {pads.sharps.map((pad) => (
          <button
            key={pad.pitch}
            type="button"
            className={`mini-pad sharp${lit.includes(pad.pitch) ? ' lit' : ''}`}
            data-pitch={pad.pitch}
            data-key={pad.kind}
            aria-label={padLabel(pad, name)}
            style={{ gridColumn: padGridColumn(pad) }}
            onPointerDown={(event) => {
              event.preventDefault()
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already released */ }
              press(`ptr:${event.pointerId}`, pad.pitch, event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.85, event.timeStamp)
            }}
            onPointerUp={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
            onPointerCancel={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
            onLostPointerCapture={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
          >
            {pad.name}
          </button>
        ))}
        {pads.naturals.map((pad) => (
          <button
            key={pad.pitch}
            type="button"
            className={`mini-pad natural${lit.includes(pad.pitch) ? ' lit' : ''}`}
            data-pitch={pad.pitch}
            data-key={pad.kind}
            aria-label={padLabel(pad, name)}
            style={{ gridColumn: padGridColumn(pad) }}
            onPointerDown={(event) => {
              event.preventDefault()
              try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already released */ }
              press(`ptr:${event.pointerId}`, pad.pitch, event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.85, event.timeStamp)
            }}
            onPointerUp={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
            onPointerCancel={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
            onLostPointerCapture={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
          >
            {pad.name}
          </button>
        ))}
      </div>
      </div>
    </div>
  )
}

function KeyboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="6.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="11.5" y="6" width="3" height="8" rx="0.6" fill="currentColor" />
      <rect x="4.2" y="2" width="2.4" height="6" rx="0.5" fill="currentColor" />
      <rect x="9.4" y="2" width="2.4" height="6" rx="0.5" fill="currentColor" />
    </svg>
  )
}

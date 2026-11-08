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
import { beatHitForTrack, beatKeyAt, beatOctaveHasPads, beatPageLabel, isBeatMachineInstrument, type BeatHit } from '../model/beatKeys'
import { typingTarget } from '../state/history'
import type { ProjectStore } from '../state/store'
import { octaveName } from './kit/controls'
import { hidePianoRoll, notifyKeyboard } from './keyboardStage'
import { useScreenOverlay } from './screenOverlay'
import { miniPads, padGridColumn, padLabel } from './miniKeys'
import { PluginTransport } from './pluginTransport'

/**
 * How hard a dock key was struck.
 * A mouse always reports pressure 0.5, which is not a soft hit. Pens and fingers keep their pressure.
 */
export function dockStrike(pointerType: string, pressure: number, fallback = 0.85): number {
  if (pointerType === 'mouse') return fallback
  if (pressure > 0 && pressure < 1) return pressure
  return fallback
}

/** What a dock key should play. A beat-machine key becomes that pad's note. */
export function keyboardHit(store: ProjectStore, pitch: number, velocity = 0.85): BeatHit | null {
  const target = noteTarget(store.project.tracks, store.selectedTrackId)
  if (target.kind !== 'instrument') return null
  const track = store.track(target.trackId)
  return beatHitForTrack(track, pitch, velocity)
}

/** Play one note, a Beat Machine pad, or a Scaler chord when keys lock says so. Returns the pitches that sounded. */
export function playKeyboardNote(store: ProjectStore, engine: AudioEngine, pitch: number, velocity = 0.85): number[] {
  const target = noteTarget(store.project.tracks, store.selectedTrackId)
  const level = Math.max(0.05, Math.min(1, velocity))
  if (target.kind === 'silent') return []
  if (target.kind === 'tune') {
    store.updatePlugin(target.trackId, target.pluginId, { params: { holdMidi: Math.max(0, Math.min(127, Math.round(pitch))) } })
    return [pitch]
  }
  const beat = keyboardHit(store, pitch, level)
  if (beat) {
    if (beat.pitch < 0) return []
    const trigger = (engine as AudioEngine & { triggerPad?: (trackId: string, note: number, level: number) => void }).triggerPad
    if (trigger) trigger.call(engine, beat.trackId, beat.pitch, beat.velocity)
    else engine.playThrough(beat.trackId, beat.pitch, beat.velocity)
    return [beat.pitch]
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

/** Beat-machine keys land in the clip the same way a pad hit does. Other notes stay keyboard takes. */
export function commitDockNotes(store: ProjectStore, notes: RecordedKey[]) {
  const pads = notes.filter((note) => isBeatMachineInstrument(store.track(note.trackId)?.instrument))
  const rest = notes.filter((note) => !isBeatMachineInstrument(store.track(note.trackId)?.instrument))
  const byTrack = new Map<string, RecordedKey[]>()
  for (const note of pads) {
    const list = byTrack.get(note.trackId) ?? []
    list.push(note)
    byTrack.set(note.trackId, list)
  }
  for (const [trackId, list] of byTrack) {
    store.commitPadHits(trackId, list.map((note) => ({
      pitch: note.pitch,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      velocity: note.velocity,
    })))
  }
  if (rest.length) commitKeyboardNotes(store, rest)
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

export function KeyboardToggle({
  store,
  engine,
  word = 'Keyboard',
  hint = 'Show the on-screen piano.',
}: {
  store: ProjectStore
  engine: AudioEngine
  /** Visible name. The track header and the note editor use a full phrase. */
  word?: string
  hint?: string
}) {
  return (
    <button
      type="button"
      className={`keyboard-toggle onscreen-piano${store.keyboardMidi ? ' on' : ''}`}
      aria-pressed={store.keyboardMidi}
      aria-label={`${word}. ${hint}`}
      title={hint}
      onClick={() => {
        engine.unlock()
        const next = !store.keyboardMidi
        if (next) {
          store.clearKeyboardReturn()
          hidePianoRoll()
        }
        store.setKeyboardMidi(next)
        notifyKeyboard(next)
      }}
    >
      <KeyboardIcon />
      <span>{word}</span>
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
      <KeyboardToggle
        store={store}
        engine={engine}
        word="On-screen Piano"
        hint="Show the on-screen piano for this track. Edit Notes brings the note editor back."
      />
    </div>
  )
}

export function KeyboardDock({ store, engine, onEditNotes }: { store: ProjectStore; engine: AudioEngine; onEditNotes?: () => void }) {
  useSyncExternalStore(store.subscribe, () => store.version, () => store.version)
  useScreenOverlay(() => { store.setKeyboardMidi(false); notifyKeyboard(false) }, store.keyboardMidi)
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
    if (finished.length) commitDockNotes(store, finished)
  }

  function press(token: string, pitch: number, velocity = 0.85, eventMs = performance.now()) {
    if (held.current.has(token)) return
    const target = noteTarget(store.project.tracks, store.selectedTrackId)
    if (target.kind === 'silent') return
    const level = Math.max(0.05, Math.min(1, velocity))
    const beat = keyboardHit(store, pitch, level)
    const sounded = playKeyboardNote(store, engine, pitch, level)
    if (!sounded.length) return
    held.current.set(token, sounded)
    recording.current = engine.status === 'recording' || engine.status === 'counting-in' || store.padRecord?.trackId === target.trackId
    if (recording.current && target.kind === 'instrument' && (target.armed || store.padRecord?.trackId === target.trackId)) {
      const dest = keyboardDestination(store.project.tracks, store.selectedTrackId, store.selectedMidiClipId)
      if (dest && dest.trackId === target.trackId) {
        const pads = Boolean(beat && beat.pitch >= 0)
        armed.current = armSounded(armed.current, token, sounded, {
          trackId: dest.trackId,
          clipId: pads ? null : dest.clipId,
          clipStart: pads ? 0 : dest.clipStart,
          velocity: beat && beat.pitch >= 0 ? beat.velocity : level,
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
      if (intoClip.length) commitDockNotes(store, intoClip)
      const beatNotes = loose.filter((note) => isBeatMachineInstrument(store.track(note.trackId)?.instrument))
      const keyboardNotes = loose.filter((note) => !isBeatMachineInstrument(store.track(note.trackId)?.instrument))
      if (beatNotes.length) commitDockNotes(store, beatNotes)
      pending.current.push(...keyboardNotes)
    }
    paint()
  }
  releaseRef.current = release

  useEffect(() => {
    recording.current = engine.status === 'recording' || engine.status === 'counting-in'
    return engine.subscribe(() => {
      const next = engine.status === 'recording' || engine.status === 'counting-in'
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
  const beatTrack = route.kind === 'instrument' ? store.track(route.trackId) : null
  const beatKit = beatTrack && isBeatMachineInstrument(beatTrack.instrument) ? beatTrack.padKit : null
  const pads = miniPads(octave)
  const name = beatKit ? beatPageLabel(beatKit, octave) : octaveName(keyboardStart(octave))
  const atBottom = beatKit ? !beatOctaveHasPads(beatKit, octave - 1) : octave <= -4
  const atTop = beatKit ? !beatOctaveHasPads(beatKit, octave + 1) : octave >= 5
  const caption = (step: number, fallback: string) => {
    if (!beatKit) return fallback
    return beatKeyAt(beatKit, octave, step)?.name ?? ''
  }
  return (
    <div className="keyboard-dock" data-keyboard-dock="open" data-keyboard="pads">
      <div className="keyboard-face">
      <div className="keyboard-octave" role="group" aria-label="Octave">
        <button type="button" disabled={atBottom} onClick={() => shift(-1)}>Octave Down</button>
        <span aria-live="polite">{name}</span>
        <button type="button" disabled={atTop} onClick={() => shift(1)}>Octave Up</button>
        <button type="button" className="keyboard-edit" onClick={() => onEditNotes?.()}>Edit Notes</button>
        <button type="button" className="keyboard-close overlay-close" onClick={() => { store.setKeyboardMidi(false); notifyKeyboard(false) }}>Close</button>
      </div>
      {route.kind === 'silent' && <p className="keyboard-hint" role="status">{INSTRUMENT_HINT}</p>}
      <div className="mini-board" role="group" aria-label={beatKit ? 'Beat machine pads' : 'Piano keyboard'}>
        {[...pads.sharps, ...pads.naturals].map((pad) => {
          const label = caption(pad.step, pad.name)
          const heard = beatKit ? beatKeyAt(beatKit, octave, pad.step) : null
          const litPad = lit.includes(pad.pitch) || (heard != null && lit.includes(heard.pitch))
          return (
            <button
              key={`${pad.kind}-${pad.pitch}`}
              type="button"
              className={`mini-pad ${pad.kind}${litPad ? ' lit' : ''}${beatKit ? ' beat' : ''}`}
              data-pitch={heard?.pitch ?? pad.pitch}
              data-key={pad.kind}
              aria-label={heard ? heard.name : padLabel(pad, name)}
              style={{ gridColumn: padGridColumn(pad) }}
              disabled={Boolean(beatKit && !heard)}
              onPointerDown={(event) => {
                if (beatKit && !heard) return
                event.preventDefault()
                try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already released */ }
                press(`ptr:${event.pointerId}`, pad.pitch, dockStrike(event.pointerType, event.pressure), event.timeStamp)
              }}
              onPointerUp={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
              onPointerCancel={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
              onLostPointerCapture={(event) => release(`ptr:${event.pointerId}`, event.timeStamp)}
            >
              {label}
            </button>
          )
        })}
      </div>
      <PluginTransport engine={engine} />
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

import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { performanceOwnsMidi, stepOwnsMidi } from '../midi/remember'
import {
  claimComputerKey,
  keyboardHome,
  keyboardPitch,
  keyboardTarget,
  rollOwnsKeys,
} from '../model/keyboardPlay'
import { typingTarget } from '../state/history'
import type { ProjectStore } from '../state/store'
import { blackAfter, keyboardNotes, octaveName } from './kit/controls'

/** Play one note on the same immediate path as a MIDI or on-screen key. */
export function playKeyboardNote(store: ProjectStore, engine: AudioEngine, pitch: number, velocity = 0.85) {
  const trackId = keyboardTarget(store.project.tracks, store.selectedTrackId)
  const level = Math.max(0.05, Math.min(1, velocity))
  if (trackId) engine.playThrough(trackId, pitch, level)
  else {
    engine.unlock()
    engine.liveNoteOn(pitch, level)
  }
}

export function releaseKeyboardNote(store: ProjectStore, engine: AudioEngine, pitch: number) {
  const trackId = keyboardTarget(store.project.tracks, store.selectedTrackId)
  if (trackId) engine.releaseThrough(trackId, pitch)
  else engine.liveNoteOff(pitch)
}

export function KeyboardDock({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const editor = store.midiEditor()
  const octave = editor.octave
  const [lit, setLit] = useState<number[]>([])
  const held = useRef(new Map<string, number>())
  const root = useRef<HTMLDivElement>(null)
  const shiftRef = useRef<(delta: -1 | 1) => void>(() => undefined)
  const octaveRef = useRef(octave)
  octaveRef.current = octave

  function shift(delta: -1 | 1) {
    store.setMidiEditor({ octave: octave + delta })
  }
  shiftRef.current = shift

  function down(token: string, pitch: number, velocity = 0.85) {
    if (held.current.has(token)) return
    held.current.set(token, pitch)
    playKeyboardNote(store, engine, pitch, velocity)
    setLit([...new Set(held.current.values())])
  }

  function up(token: string) {
    const pitch = held.current.get(token)
    if (pitch == null) return
    held.current.delete(token)
    releaseKeyboardNote(store, engine, pitch)
    setLit([...new Set(held.current.values())])
  }

  useEffect(() => {
    const keys = held.current
    const onDown = (event: KeyboardEvent) => {
      const claim = claimComputerKey({
        enabled: store.keyboardMidi,
        typing: typingTarget(event.target as HTMLElement | null),
        meta: event.metaKey || event.ctrlKey,
        alt: event.altKey,
        repeat: event.repeat,
        held: keys.has(event.code || event.key),
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
        down(event.code || event.key, keyboardPitch(home, octaveRef.current))
      }
    }
    const onUp = (event: KeyboardEvent) => {
      if (!store.keyboardMidi) return
      up(event.code || event.key)
    }
    const blur = () => {
      for (const token of [...keys.keys()]) up(token)
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
  const start = 48 + octave * 12
  const whites = keyboardNotes(2, Math.max(0, Math.min(96, start)))
  const top = whites[whites.length - 1]
  const name = octaveName(60 + octave * 12)
  return (
    <div className="keyboard-dock" data-keyboard-dock="open" ref={root}>
      <div className="keyboard-octave" role="group" aria-label="Octave">
        <button type="button" aria-label="Octave down" title="Z lowers the keyboard by one octave." onClick={() => shift(-1)}>Z</button>
        <span aria-live="polite">{name}</span>
        <button type="button" aria-label="Octave up" title="X raises the keyboard by one octave." onClick={() => shift(1)}>X</button>
      </div>
      <div className="keyboard-keys" role="group" aria-label="Piano keyboard">
        {whites.map((note) => {
          const black = blackAfter(note)
          const showBlack = black != null && black < top
          return (
            <div className="slot" key={note}>
              <button
                type="button"
                className={`white${lit.includes(note) ? ' lit' : ''}`}
                data-pitch={note}
                aria-label={((note % 12) + 12) % 12 === 0 ? octaveName(note) : `Note ${note}`}
                onPointerDown={(event) => {
                  event.preventDefault()
                  try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already released */ }
                  down(`ptr:${event.pointerId}`, note, event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.85)
                }}
                onPointerUp={(event) => up(`ptr:${event.pointerId}`)}
                onPointerCancel={(event) => up(`ptr:${event.pointerId}`)}
              />
              {showBlack && (
                <button
                  type="button"
                  className={`black${lit.includes(black) ? ' lit' : ''}`}
                  data-pitch={black}
                  aria-label={`Note ${black}`}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* already released */ }
                    down(`ptr:${event.pointerId}`, black, event.pressure > 0 && event.pressure < 1 ? event.pressure : 0.85)
                  }}
                  onPointerUp={(event) => up(`ptr:${event.pointerId}`)}
                  onPointerCancel={(event) => up(`ptr:${event.pointerId}`)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

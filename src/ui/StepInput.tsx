import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { hardwareMidiAllowed } from '../model/beatRepeat'
import { STEP_LENGTHS, stepPlace, type StepTone } from '../model/stepEntry'
import { selectMidiEditor } from '../state/select'
import type { ProjectStore } from '../state/store'
import { TipButton } from './Hint'

const WHITE = [0, 2, 4, 5, 7, 9, 11]
const CODES: Record<string, number> = {
  KeyA: 60, KeyW: 61, KeyS: 62, KeyE: 63, KeyD: 64, KeyF: 65,
  KeyT: 66, KeyG: 67, KeyY: 68, KeyH: 69, KeyU: 70, KeyJ: 71,
}
const LETTERS: Record<string, number> = { a: 60, w: 61, s: 62, e: 63, d: 64, f: 65, t: 66, g: 67, y: 68, h: 69, u: 70, j: 71 }

export function StepInput({ store, engine }: { store: ProjectStore; engine: AudioEngine }) {
  const view = selectMidiEditor(store)
  const { track, clip, editor, project } = view
  const [lit, setLit] = useState<number[]>([])
  const held = useRef(new Map<string, number>())
  const chord = useRef<StepTone[]>([])
  const octave = useRef(editor.octave)
  const velocity = useRef(editor.velocity)
  octave.current = editor.octave
  velocity.current = editor.velocity
  const commit = useRef<(tones: StepTone[]) => void>(() => {})
  commit.current = (tones) => {
    if (!track || !clip || !tones.length) return
    store.enterSteps(track.id, clip.id, tones)
  }

  function press(token: string, pitch: number, level = velocity.current) {
    if (held.current.has(token)) return
    held.current.set(token, pitch)
    chord.current.push({ pitch, velocity: level })
    engine.unlock()
    void engine.resume()
    engine.liveNoteOn(pitch, level)
    setLit([...new Set(held.current.values())])
  }

  function release(token: string) {
    const pitch = held.current.get(token)
    if (pitch == null) return
    held.current.delete(token)
    engine.liveNoteOff(pitch)
    setLit([...new Set(held.current.values())])
    if (held.current.size > 0) return
    const tones = chord.current.splice(0)
    commit.current(tones)
  }

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        event.stopPropagation()
        if (track && clip) store.restStep(track.id, clip.id)
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        event.stopPropagation()
        store.stepBack()
        return
      }
      if (event.key === 'z' && !event.repeat) {
        event.preventDefault()
        store.setMidiEditor({ octave: octave.current - 1 })
        return
      }
      if (event.key === 'x' && !event.repeat) {
        event.preventDefault()
        store.setMidiEditor({ octave: octave.current + 1 })
        return
      }
      const home = CODES[event.code] ?? LETTERS[event.key.toLowerCase()]
      if (home == null || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      press(event.code || event.key, home + octave.current * 12)
    }
    const up = (event: KeyboardEvent) => {
      const home = CODES[event.code] ?? LETTERS[event.key.toLowerCase()]
      if (home == null) return
      release(event.code || event.key)
    }
    const blur = () => {
      for (const token of [...held.current.keys()]) release(token)
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    window.addEventListener('blur', blur)
    return () => {
      blur()
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
      window.removeEventListener('blur', blur)
    }
  }, [track?.id, clip?.id])

  useEffect(() => {
    if (!hardwareMidiAllowed(navigator.userAgent) || !navigator.requestMIDIAccess) return
    let dead = false
    const midiHeld = new Map<number, string>()
    void navigator.requestMIDIAccess().then((access) => {
      if (dead) return
      const bind = () => {
        for (const input of access.inputs.values()) {
          input.onmidimessage = (event) => {
            const data = event.data
            if (!data || data.length < 3) return
            const status = data[0] & 0xf0
            const pitch = data[1]
            const velocity = data[2] / 127
            const on = status === 0x90 && data[2] > 0
            const off = status === 0x80 || (status === 0x90 && data[2] === 0)
            const token = `midi:${pitch}`
            if (on) {
              if (midiHeld.has(pitch)) return
              midiHeld.set(pitch, token)
              press(token, pitch, Math.max(0.05, velocity))
            } else if (off && midiHeld.has(pitch)) {
              midiHeld.delete(pitch)
              release(token)
            }
          }
        }
      }
      bind()
      access.onstatechange = bind
    }).catch(() => undefined)
    return () => {
      dead = true
      for (const token of midiHeld.values()) release(token)
      midiHeld.clear()
    }
  }, [track?.id, clip?.id])

  if (!track || !clip) return <p className="me-empty">Open a MIDI clip to enter steps.</p>
  const base = 48 + editor.octave * 12
  const whites: number[] = []
  for (let octave = 0; octave < 2; octave++) for (const step of WHITE) whites.push(base + octave * 12 + step)
  whites.push(base + 24)
  const blacks = whites.slice(0, -1).flatMap((pitch, index) => {
    const pc = ((pitch % 12) + 12) % 12
    if (pc === 4 || pc === 11) return []
    return [{ pitch: pitch + 1, index }]
  })
  const length = STEP_LENGTHS.find((item) => Math.abs(item.beats - editor.step) < 1e-6) ?? STEP_LENGTHS[1]
  return (
    <div className="me-step">
      <div className="me-bar">
        <select
          aria-label="Step length. How long the next note is, and how far the cursor moves."
          title="How long the next note is, and how far the cursor moves."
          value={String(length.beats)}
          onChange={(event) => store.setMidiEditor({ step: Number(event.target.value) })}
        >
          {STEP_LENGTHS.map((item) => (
            <option key={item.id} value={item.beats}>{item.label}</option>
          ))}
        </select>
        <TipButton label="Rest" hint="Move ahead one step without adding a note." onClick={() => store.restStep(track.id, clip.id)} />
        <TipButton label="Tie" hint="Lengthen the notes that end here. If none do, the next notes you play will tie." pressed={editor.tie} onClick={() => store.tieStep(track.id, clip.id)} />
        <TipButton label="Back" hint="Move the insert point one step earlier." onClick={() => store.stepBack()} />
        <TipButton label="Clear" hint="Remove notes that start on this step." onClick={() => store.clearCursor(track.id, clip.id)} />
        <label className="me-vel">
          Vel
          <input
            aria-label="Step velocity. How hard the next note is played."
            title="How hard the next note is played."
            type="range"
            min={0.05}
            max={1}
            step={0.01}
            value={editor.velocity}
            onChange={(event) => store.setMidiEditor({ velocity: Number(event.target.value) }, true)}
            onPointerUp={() => store.endDraft()}
            onPointerCancel={() => store.endDraft()}
          />
        </label>
        <span className="me-place" aria-live="polite">At {stepPlace(editor.cursor, project.timeSignature)}</span>
        <TipButton label="−" hint="Shift the keyboard down one octave." onClick={() => store.setMidiEditor({ octave: editor.octave - 1 })} />
        <TipButton label="+" hint="Shift the keyboard up one octave." onClick={() => store.setMidiEditor({ octave: editor.octave + 1 })} />
      </div>
      <div className="step-piano" aria-label="On-screen piano. Tap a key to enter that note and advance one step.">
        {whites.map((pitch) => (
          <button
            key={pitch}
            type="button"
            data-pitch={pitch}
            className={`white ${lit.includes(pitch) ? 'lit' : ''}`}
            aria-label={`${keyName(pitch)}. Enter this note.`}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              press(`ptr:${event.pointerId}`, pitch)
            }}
            onPointerUp={(event) => release(`ptr:${event.pointerId}`)}
            onPointerCancel={(event) => release(`ptr:${event.pointerId}`)}
          />
        ))}
        {blacks.map((key) => (
          <button
            key={key.pitch}
            type="button"
            data-pitch={key.pitch}
            className={`black ${lit.includes(key.pitch) ? 'lit' : ''}`}
            style={{ left: `calc(${((key.index + 1) * 100) / whites.length}% - 11px)` }}
            aria-label={`${keyName(key.pitch)}. Enter this note.`}
            onPointerDown={(event) => {
              event.preventDefault()
              event.currentTarget.setPointerCapture(event.pointerId)
              press(`ptr:${event.pointerId}`, key.pitch)
            }}
            onPointerUp={(event) => release(`ptr:${event.pointerId}`)}
            onPointerCancel={(event) => release(`ptr:${event.pointerId}`)}
          />
        ))}
      </div>
    </div>
  )
}

function keyName(pitch: number) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  return `${names[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

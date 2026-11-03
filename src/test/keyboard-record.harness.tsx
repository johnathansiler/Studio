import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { KeyboardDock } from '../ui/KeyboardDock'
import '../styles.css'

const store = new ProjectStore(createEmptyProject())
const midi = store.project.tracks.find((track) => track.type === 'midi')!
store.selectTrack(midi.id)
store.updateTrack(midi.id, { armed: true })
store.setTrackInstrument(midi.id, 'scaler')
store.setScaler(midi.id, { keysLock: 'chord', output: 'audio' })
store.setKeyboardMidi(true)

const listeners = new Set<() => void>()
const engine = {
  status: 'stopped',
  positionSamples: 0,
  sampleRate: 48000,
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  unlock() {},
  playThrough() {},
  releaseThrough() {},
  liveNoteOn() {},
  liveNoteOff() {},
  setStatus(next: string) {
    this.status = next
    listeners.forEach((fn) => fn())
  },
}

function Bar() {
  const [, bump] = useState(0)
  useEffect(() => store.subscribe(() => bump((value) => value + 1)), [])
  const notes = store.track(midi.id)!.midiClips.flatMap((clip) => clip.notes)
  return (
    <>
      <button id="record" type="button" onClick={() => engine.setStatus('recording')}>Record</button>
      <button id="stop" type="button" onClick={() => engine.setStatus('stopped')}>Stop</button>
      <p id="notes" data-count={notes.length}>{notes.map((note) => note.pitch).join(',')}</p>
      <KeyboardDock store={store} engine={engine as unknown as AudioEngine} />
    </>
  )
}

createRoot(document.getElementById('root')!).render(<Bar />)

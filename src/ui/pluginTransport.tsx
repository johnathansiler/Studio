import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { ButtonTray } from './ButtonTray'
import type { AudioEngine } from '../audio/engine'

export interface TransportActions {
  record: () => void
  stop: () => void
  play: () => void
}

/** Record, Stop, and Play for any plugin that covers the arrange transport. */
export const TransportActionContext = createContext<TransportActions | null>(null)

/**
 * Recording controls that stay in the plugin. Record lights while a take is
 * running. Stop ends the take. Play starts from the playhead.
 */
export function PluginTransport({ engine, extra }: { engine: AudioEngine; extra?: ReactNode }) {
  const actions = useContext(TransportActionContext)
  const [status, setStatus] = useState(engine.status)
  useEffect(() => engine.subscribe(() => setStatus(engine.status)), [engine])
  const recording = status === 'recording' || status === 'counting-in'
  const running = recording || status === 'playing'
  const go = (fn?: () => void) => {
    engine.unlock()
    fn?.()
  }
  return (
    <ButtonTray className="plugin-transport" data-plugin-transport="open" role="group" aria-label="Transport">
      <button type="button" className={recording ? 'on' : ''} aria-pressed={recording} aria-label="Record" title="Record onto this track." onClick={() => go(actions?.record)}>Record</button>
      <button type="button" aria-label="Stop" title="Stop playback and recording. The playhead stays where it is." onClick={() => go(actions?.stop)}>Stop</button>
      <button type="button" className={running && !recording ? 'on' : ''} aria-pressed={running && !recording} aria-label="Play" title="Play from the playhead." onClick={() => go(running && !recording ? actions?.stop : actions?.play)}>Play</button>
      {extra}
    </ButtonTray>
  )
}

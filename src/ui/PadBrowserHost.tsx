import { useEffect, useState, type ComponentType } from 'react'
import type { AudioEngine } from '../audio/engine'
import type { ProjectStore } from '../state/store'

/** Loads the library browser when the pad Browser opens, so the pad face stays small. */
export function PadBrowserHost({
  store,
  engine,
  pad,
  onClose,
}: {
  store: ProjectStore
  engine: AudioEngine
  pad: { trackId: string; bank: number; index: number }
  onClose: () => void
}) {
  const [View, setView] = useState<ComponentType<{
    store: ProjectStore
    engine: AudioEngine
    variant: 'pads'
    pad: { trackId: string; bank: number; index: number }
  }> | null>(null)
  useEffect(() => {
    let alive = true
    void import('./MyLibrary').then((mod) => {
      if (alive) setView(() => mod.MyLibrary as unknown as NonNullable<typeof View>)
    })
    return () => { alive = false }
  }, [])
  return (
    <div className="pad-sample-browser" data-pad-browser="open" role="dialog" aria-label="Browser">
      <div className="pad-browser-bar">
        <strong>Browser</strong>
        <button type="button" onClick={onClose}>Close</button>
      </div>
      {View ? <View store={store} engine={engine} variant="pads" pad={pad} /> : <p className="sound-status">Loading the library…</p>}
    </div>
  )
}

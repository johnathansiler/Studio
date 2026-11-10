import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ProjectStore } from '../state/store'
import { TransportBar } from '../ui/TransportBar'
import '../styles.css'
import '../ui/remoteFixes.css'
import '../ui/premium.css'
import '../ui/buttonTiers.css'
import '../ui/buttonTray.css'

const store = new ProjectStore()
store.project.metronomeEnabled = true
store.project.countIn = true
store.project.countInBars = 1

const engine = {
  positionSamples: 12000,
  status: 'playing' as const,
  subscribe: () => () => undefined,
  currentTimelineSample: () => 12000,
  unlock() {},
}

function Bar() {
  const [, bump] = useState(0)
  const [resets, setResets] = useState(0)
  useEffect(() => store.subscribe(() => bump((value) => value + 1)), [])
  return (
    <div className="shell phone" data-form="phone">
      <p id="metro" data-on={store.project.metronomeEnabled ? '1' : '0'} />
      <p id="count" data-on={store.project.countIn ? '1' : '0'} data-bars={String(store.project.countInBars)} />
      <p id="resets" data-n={String(resets)} />
      <TransportBar
        store={store}
        engine={engine as never}
        simple
        onPlay={() => undefined}
        onStop={() => undefined}
        onRecord={() => undefined}
        onSeek={() => undefined}
        onReset={() => setResets((value) => value + 1)}
      />
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Bar />)

import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PadScreen } from '../ui/PadScreen'
import '../ui/pads.css'

const samples = new Float32Array(4800)
for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 18) * (i % 400 < 200 ? 0.8 : -0.35)

function App() {
  const [start, setStart] = useState(0.12)
  const [end, setEnd] = useState(0.84)
  return (
    <div style={{ width: 390 }}>
      <PadScreen
        name="Kick"
        samples={samples}
        sampleRate={48000}
        start={start}
        end={end}
        reverse={false}
        tune={0}
        tuneCents={0}
        pitchMode="vinyl"
        filter={1}
        highpass={0}
        vintage={0}
        level={1}
        gate="shot"
        swing={50}
        tempo={120}
        hitToken={0}
        snap
        onTrim={(from, to) => {
          setStart(from)
          setEnd(to)
          ;(window as unknown as { __trim?: number[] }).__trim = [from, to]
        }}
        onTrimEnd={() => {}}
      />
    </div>
  )
}

try { localStorage.setItem('cueharbor-pad-zoom-hint', '1') } catch { /* private */ }
createRoot(document.getElementById('root')!).render(<App />)

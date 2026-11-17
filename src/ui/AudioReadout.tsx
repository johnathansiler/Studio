import { useEffect, useState } from 'react'

/** Menu and Setup. The lines stay even when a value has not been measured yet. */
export function AudioReadout({ report }: { report: () => string }) {
  const [text, setText] = useState(() => report())
  useEffect(() => {
    const tick = () => setText(report())
    tick()
    const timer = window.setInterval(tick, 500)
    return () => window.clearInterval(timer)
  }, [report])
  return (
    <div className="audio-readout" data-audio-diagnostics="">
      {text.split('\n').map((line, index) => <p key={index}>{line}</p>)}
    </div>
  )
}

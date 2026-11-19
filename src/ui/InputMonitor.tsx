import { useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/engine'
import { clampInputDb, INPUT_GAIN_MAX, INPUT_GAIN_MIN } from '../audio/recordTake'
import type { ProjectStore } from '../state/store'

function dbText(db: number) {
  const shown = clampInputDb(db)
  if (shown > 0) return `+${shown.toFixed(1)} dB`
  return `${shown.toFixed(1)} dB`
}

/** Peak and RMS of the armed mic, plus the input trim. Sits on the lane so the header stays a square. */
export function InputMonitor({
  store,
  engine,
  trackId,
  gainDb,
}: {
  store: ProjectStore
  engine: AudioEngine
  trackId: string
  gainDb: number
}) {
  const [level, setLevel] = useState({ peak: 0, rms: 0, clip: false })
  const clipUntil = useRef(0)
  useEffect(() => {
    clipUntil.current = 0
  }, [gainDb, trackId])
  useEffect(() => {
    let frame = 0
    const tick = () => {
      const dry = engine.readInputMeter()
      const gain = 10 ** (clampInputDb(gainDb) / 20)
      const peak = Math.min(1.5, (dry?.peak ?? 0) * gain)
      const rms = Math.min(1.5, (dry?.rms ?? 0) * gain)
      if (peak >= 0.98) clipUntil.current = performance.now() + 1400
      const clip = peak >= 0.98 || performance.now() < clipUntil.current
      setLevel((prev) => (Math.abs(prev.peak - peak) < 0.01 && Math.abs(prev.rms - rms) < 0.01 && prev.clip === clip ? prev : { peak, rms, clip }))
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [engine, gainDb])

  return (
    <div className={`input-monitor${level.clip ? ' is-clipping' : ''}`} data-input-monitor={trackId} onPointerDown={(event) => event.stopPropagation()}>
      <div className="input-meters" aria-hidden="true">
        <i className="input-rms" style={{ width: `${Math.min(100, level.rms * 100)}%` }} />
        <i className="input-peak" style={{ width: `${Math.min(100, level.peak * 100)}%` }} />
      </div>
      <span className="input-clip" role="status">{level.clip ? 'Clip' : 'In'}</span>
      <label className="input-gain">
        <span>Input {dbText(gainDb)}</span>
        <input
          type="range"
          min={INPUT_GAIN_MIN}
          max={INPUT_GAIN_MAX}
          step={0.5}
          value={clampInputDb(gainDb)}
          aria-label={`Input gain ${dbText(gainDb)}. ${level.clip ? 'The input is clipping. Turn it down.' : 'How loud this track records.'}`}
          title={level.clip ? 'The input is clipping. Turn it down.' : 'Input gain. 0 dB records at the mic level.'}
          onChange={(event) => {
            const db = clampInputDb(Number(event.target.value))
            store.updateTrack(trackId, { inputGainDb: db })
            engine.setRecordTrim(trackId, db)
          }}
        />
      </label>
    </div>
  )
}

/** Live take, drawn from the armed track's playhead while record is running. */
export function RecordWave({
  engine,
  trackId,
  px,
  sampleRate,
  color,
}: {
  engine: AudioEngine
  trackId: string
  px: number
  sampleRate: number
  color: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [, setTick] = useState(0)
  useEffect(() => engine.subscribeInput(() => setTick((value) => value + 1)), [engine])
  const wave = engine.recordWave(trackId)
  useEffect(() => {
    const node = canvas.current
    if (!node || !wave) return
    const width = Math.max(2, node.clientWidth)
    const height = Math.max(2, node.clientHeight)
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    if (node.width !== Math.round(width * dpr) || node.height !== Math.round(height * dpr)) {
      node.width = Math.round(width * dpr)
      node.height = Math.round(height * dpr)
    }
    const ctx = node.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = color
    const mid = height / 2
    const count = wave.min.length
    const bucket = 256
    const samplesWide = Math.max(1, (width / Math.max(1, px)) * sampleRate)
    const visible = Math.max(1, Math.round(samplesWide / bucket))
    const start = Math.max(0, count - visible)
    const span = Math.max(1, count - start)
    for (let i = start; i < count; i++) {
      const x = ((i - start) / span) * width
      const min = wave.min[i] ?? 0
      const max = wave.max[i] ?? 0
      const y0 = mid - max * mid
      const y1 = mid - min * mid
      ctx.fillRect(x, Math.min(y0, y1), Math.max(1, width / span), Math.max(1, Math.abs(y1 - y0)))
    }
  })
  if (!wave) return null
  const left = (wave.startSample / sampleRate) * px
  const width = Math.max(8, (wave.min.length * 256 / sampleRate) * px)
  return <canvas ref={canvas} className="record-wave" data-record-wave={trackId} style={{ left, width }} aria-hidden="true" />
}

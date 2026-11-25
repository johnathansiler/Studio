import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clampKeyStart, noteName, readKeyStart, stepKeyStart, swipeSemitones, writeKeyStart } from '../model/keyShift'

/** Lowest note for one instrument. The value is remembered on this device. */
export function useKeyStart(instrument: string, home: number, span: number) {
  const [start, setStart] = useState(() => readKeyStart(instrument, home, span))
  const ref = useRef(start)
  ref.current = start
  useEffect(() => {
    setStart(readKeyStart(instrument, home, span))
  }, [instrument, home, span])
  function move(delta: number) {
    const next = stepKeyStart(ref.current, delta, span)
    if (next === ref.current) return next
    setStart(next)
    writeKeyStart(instrument, next, span)
    return next
  }
  return { start, move }
}

/** Slide the keys when the window moves. The transform resets after the motion so layout stays put. */
export function useKeySlide(start: number, keyWidth = 28) {
  const prev = useRef(start)
  const [px, setPx] = useState(0)
  const [animate, setAnimate] = useState(false)
  useLayoutEffect(() => {
    const delta = start - prev.current
    prev.current = start
    if (!delta) return
    const width = Math.max(16, keyWidth)
    setAnimate(false)
    setPx(delta * width)
    const frame = requestAnimationFrame(() => {
      setAnimate(true)
      setPx(0)
    })
    return () => cancelAnimationFrame(frame)
  }, [start, keyWidth])
  return {
    transform: `translate3d(${px}px,0,0)`,
    transition: animate ? 'transform 150ms ease' : 'none',
  }
}

export function KeyNudge({
  low,
  span,
  onStep,
  octaveLabels = false,
}: {
  low: number
  span: number
  onStep: (delta: number) => void
  /** The dock already prints Octave Down / Octave Up. Plugin strips use short marks. */
  octaveLabels?: boolean
}) {
  const floor = clampKeyStart(0, span)
  const ceil = clampKeyStart(127, span)
  return (
    <div className="key-nudge" role="group" aria-label="Key shift">
      <button type="button" aria-label="Octave down" title="Lower the keyboard by one octave." disabled={low <= floor} onClick={() => onStep(-12)}>{octaveLabels ? '−' : 'Octave Down'}</button>
      <button type="button" className="key-step" aria-label="Semitone down" title="Lower the keyboard by one key." disabled={low <= floor} onClick={() => onStep(-1)}>&lt;</button>
      <span aria-live="polite">{noteName(low)}</span>
      <button type="button" className="key-step" aria-label="Semitone up" title="Raise the keyboard by one key." disabled={low >= ceil} onClick={() => onStep(1)}>&gt;</button>
      <button type="button" aria-label="Octave up" title="Raise the keyboard by one octave." disabled={low >= ceil} onClick={() => onStep(12)}>{octaveLabels ? '+' : 'Octave Up'}</button>
    </div>
  )
}

export function rememberSwipe(dx: number, dy: number, keyWidth: number) {
  if (Math.abs(dx) < 28 || Math.abs(dx) < Math.abs(dy) * 1.25) return 0
  return swipeSemitones(dx, keyWidth)
}

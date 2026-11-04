import { useEffect, useRef, useState } from 'react'

/** off, the first frame before the slide, the resting open state, or the slide closed. */
export type PushPhase = 'off' | 'in' | 'on' | 'out'

/**
 * Drive a transform slide. The first paint of an already-open dock stays put,
 * so a computer that starts with the drawer open does not animate on load.
 */
export function usePushPhase(open: boolean): PushPhase {
  const [phase, setPhase] = useState<PushPhase>(open ? 'on' : 'off')
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  useEffect(() => {
    if (open) {
      if (phaseRef.current === 'on') return
      setPhase('in')
      const frame = requestAnimationFrame(() => setPhase('on'))
      return () => cancelAnimationFrame(frame)
    }
    if (phaseRef.current === 'off') return
    setPhase('out')
    const timer = window.setTimeout(() => setPhase('off'), 220)
    return () => window.clearTimeout(timer)
  }, [open])
  return phase
}

export function browserWidthFor(width: number, height: number) {
  if (width <= 520 && height >= width) return Math.round(width * 0.66)
  return Math.min(360, Math.max(240, Math.round(width * 0.28)))
}

export function clampBrowserWidth(value: number, viewport: number, portraitPhone: boolean) {
  if (portraitPhone) {
    const min = Math.round(viewport * 0.6)
    const max = Math.round(viewport * 0.7)
    return Math.min(max, Math.max(min, Math.round(value)))
  }
  const max = Math.min(520, Math.max(280, viewport - 280))
  return Math.min(max, Math.max(220, Math.round(value)))
}

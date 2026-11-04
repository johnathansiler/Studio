import { useEffect, useRef } from 'react'
import { registerOverlay } from './overlayHost'

/** Keep a closer on the shared list while the overlay is open. */
export function useScreenOverlay(close: () => void, active = true) {
  const closeRef = useRef(close)
  closeRef.current = close
  useEffect(() => {
    if (!active) return
    return registerOverlay(() => closeRef.current())
  }, [active])
}

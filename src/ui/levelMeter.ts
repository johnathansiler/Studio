import type { AudioEngine } from '../audio/engine'
import { subscribeFrame, wakeTicker } from '../audio/ticker'
import { transportMoving } from '../model/transportSync'
import { holdMeter, type MeterHold } from './levels'

/**
 * Paint one meter from the shared frame loop.
 * The listener goes idle once the transport has stopped and the hold has fallen to silence,
 * which lets the shared loop stop.
 */
export function watchLevel(
  engine: Pick<AudioEngine, 'status' | 'subscribe'>,
  read: () => number,
  paint: (shown: number) => void,
) {
  const hold: MeterHold = { value: 0, at: 0 }
  let painted = -1
  const unsub = subscribeFrame((now) => {
    const shown = holdMeter(hold, read(), now)
    if (Math.abs(painted - shown) >= 0.015 || (shown <= 0 && painted > 0)) {
      painted = shown
      paint(shown)
    }
    return transportMoving(engine.status) || shown > 0.001
  })
  const off = engine.subscribe(() => wakeTicker())
  return () => {
    unsub()
    off()
  }
}

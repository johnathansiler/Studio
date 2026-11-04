import { edgeDelays, type RoutePoint } from '../routing'

/** Sum of reported plugin latencies, ignoring bypassed slots. */
export function sumLatency(samples: readonly number[]) {
  let total = 0
  for (let i = 0; i < samples.length; i++) {
    const n = samples[i]
    if (n > 0) total += n
  }
  return total
}

/**
 * Sample delays that line up track, send, and master branches.
 * This is the compensation pass the live graph and the offline renderer already run.
 */
export function compensateGraph(nodes: RoutePoint[]) {
  return edgeDelays(nodes)
}

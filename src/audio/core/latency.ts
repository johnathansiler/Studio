import { latencyOf } from '../plugins/catalog'
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
 * Latency the mixer should align to.
 * The processor's own report wins when it is larger than the catalog formula,
 * which is what a worklet posts after it has rendered.
 */
export function reportedLatency(
  pluginId: string,
  params: Record<string, number>,
  sampleRate: number,
  enabled: boolean,
  processorSamples = 0,
  live = true,
) {
  if (!enabled) return 0
  const declared = latencyOf(pluginId, params, sampleRate, true, live)
  return Math.max(0, declared, processorSamples)
}

/**
 * Sample delays that line up track, send, and master branches.
 * This is the compensation pass the live graph and the offline renderer already run.
 */
export function compensateGraph(nodes: RoutePoint[]) {
  return edgeDelays(nodes)
}

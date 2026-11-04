/** Bus, group, and send routing. Cycles are rejected. Compensation is in samples. */

import { feedbackPath, walkLatency, type RouteInput } from './core/graph'

export const MASTER = 'master'
export const REMOTE = 'remote'

export interface RoutePoint {
  id: string
  dest: string | null
  sends: string[]
  latency: number
}

export function findCycle(points: readonly RouteInput[]): string[] | null {
  return feedbackPath(points)
}

/** Extra delay on the edge from `from` into `to` so every input of `to` arrives together. */
export function edgeDelays(points: readonly RouteInput[]): Map<string, number> {
  return walkLatency(points).delays
}

export function edgeKey(from: string, to: string) {
  return `${from}>${to}`
}

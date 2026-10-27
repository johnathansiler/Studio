/** Bus, group, and send routing. Cycles are rejected. Compensation is in samples. */

export const MASTER = 'master'
export const REMOTE = 'remote'

export interface RoutePoint {
  id: string
  dest: string | null
  sends: string[]
  latency: number
}

export function findCycle(points: RoutePoint[]): string[] | null {
  for (const point of points) {
    if (point.dest === point.id || point.sends.includes(point.id)) return [point.id]
  }
  const edges = new Map<string, string[]>()
  for (const point of points) {
    const next: string[] = []
    if (point.dest && point.dest !== point.id) next.push(point.dest)
    for (const send of point.sends) {
      if (send && send !== point.id) next.push(send)
    }
    edges.set(point.id, next)
  }
  const color = new Map<string, number>()
  const stack: string[] = []
  const visit = (id: string): string[] | null => {
    const mark = color.get(id) ?? 0
    if (mark === 1) return stack.slice(stack.indexOf(id))
    if (mark === 2) return null
    color.set(id, 1)
    stack.push(id)
    for (const next of edges.get(id) ?? []) {
      const found = visit(next)
      if (found) return found
    }
    stack.pop()
    color.set(id, 2)
    return null
  }
  for (const point of points) {
    const found = visit(point.id)
    if (found) return found
  }
  return null
}

/** Extra delay on the edge from `from` into `to` so every input of `to` arrives together. */
export function edgeDelays(points: RoutePoint[]): Map<string, number> {
  const byId = new Map(points.map((point) => [point.id, point]))
  const incoming = new Map<string, string[]>()
  const addIn = (to: string, from: string) => {
    const list = incoming.get(to) ?? []
    list.push(from)
    incoming.set(to, list)
  }
  for (const point of points) {
    if (point.dest) addIn(point.dest, point.id)
    for (const send of point.sends) addIn(send, point.id)
  }
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const outputLatency = (id: string): number => {
    const cached = memo.get(id)
    if (cached != null) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const own = byId.get(id)?.latency ?? 0
    const sources = incoming.get(id) ?? []
    const arrived = sources.length ? Math.max(...sources.map(outputLatency)) : 0
    visiting.delete(id)
    const total = arrived + Math.max(0, own)
    memo.set(id, total)
    return total
  }
  for (const point of points) outputLatency(point.id)
  const delays = new Map<string, number>()
  const stamp = (from: string, to: string) => {
    const sources = incoming.get(to) ?? []
    const slowest = sources.length ? Math.max(...sources.map(outputLatency)) : 0
    delays.set(`${from}>${to}`, Math.max(0, Math.round(slowest - outputLatency(from))))
  }
  for (const point of points) {
    if (point.dest) stamp(point.id, point.dest)
    for (const send of point.sends) stamp(point.id, send)
  }
  return delays
}

export function edgeKey(from: string, to: string) {
  return `${from}>${to}`
}

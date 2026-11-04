/**
 * Mix graph as a DAG. No DOM and no Web Audio types.
 *
 * A later native host (CoreAudio / Oboe, or a VST3 / AU / AAX callback)
 * can run `createScheduler` on a worker pool: `take` hands out a track
 * whose inputs are finished, and `complete` wakes the next node. A bus
 * stays pending until the tracks that feed it finish. The worker that
 * finished does not block on that bus; it takes whatever else is ready.
 *
 * The web build cannot do that on the live audio thread. See
 * docs/ARCHITECTURE.md, section 2.2. Offline bounce uses the same
 * scheduler from `src/audio/parallelRender.ts`.
 */

export interface RouteInput {
  id: string
  dest: string | null
  sends: readonly string[]
  latency: number
  kind?: MixNodeKind
}

export type MixNodeKind = 'track' | 'bus' | 'group' | 'master' | 'remote'

export interface MixNode {
  id: string
  kind: MixNodeKind
  /** Plugin-chain latency in samples, added after the slowest input arrives. */
  latency: number
}

export interface MixEdge {
  from: string
  to: string
  kind: 'output' | 'send'
}

export interface MixGraph {
  nodes: MixNode[]
  edges: MixEdge[]
}

export interface FeedbackRoute {
  /** Loop ids, without the repeated start. Same array `findCycle` returns. */
  path: string[]
  message: string
}

export interface MixSchedule {
  graph: MixGraph
  /** Sources first. Empty when the route is a feedback loop. */
  order: string[]
  /** Independent sets. A node shares a wave only with nodes it does not feed. */
  waves: string[][]
  /** Sample delay on `from>to` so every input of a node arrives together. */
  delays: Map<string, number>
  /** Samples from the graph inputs to this node's output. */
  outputLatency: Map<string, number>
  feedback: FeedbackRoute | null
}

export interface PullScheduler {
  /** Next node whose inputs are done, or null when nothing is ready. */
  take(): string | null
  /** Mark `id` finished and release nodes that were only waiting on it. */
  complete(id: string): void
  done(): boolean
  remaining(): number
}

export function feedbackMessage(path: readonly string[]) {
  const names = path.length ? path : ['route']
  const loop = [...names, names[0]]
  return `Feedback route refused: ${loop.join(' → ')}. A bus waits for the tracks that feed it, so a loop has no start.`
}

export function mixNodeKind(id: string, hint?: string): MixNodeKind {
  if (id === 'master') return 'master'
  if (id === 'remote') return 'remote'
  if (hint === 'bus' || hint === 'group' || hint === 'master' || hint === 'remote' || hint === 'track') return hint
  return 'track'
}

/** Tracks, sends, buses, and the master. Self-loops and unknown targets stay out of the schedulable edges. */
export function mixGraphFromRoutes(points: readonly RouteInput[]): MixGraph {
  const nodes: MixNode[] = points.map((point) => ({
    id: point.id,
    kind: point.kind ?? mixNodeKind(point.id),
    latency: Math.max(0, point.latency || 0),
  }))
  const known = new Set(nodes.map((node) => node.id))
  const edges: MixEdge[] = []
  for (const point of points) {
    if (point.dest && point.dest !== point.id && known.has(point.dest)) {
      edges.push({ from: point.id, to: point.dest, kind: 'output' })
    }
    for (const send of point.sends) {
      if (!send || send === point.id || !known.has(send)) continue
      edges.push({ from: point.id, to: send, kind: 'send' })
    }
  }
  return { nodes, edges }
}

/**
 * Order, waves, PDC delays, and the feedback refusal.
 * Delays are computed even when the route is refused, so a caller that
 * flattens the loop can still read the same compensation numbers.
 */
export function scheduleRoutes(points: readonly RouteInput[]): MixSchedule {
  const graph = mixGraphFromRoutes(points)
  const walked = walkLatency(points)
  const cycle = feedbackPath(points)
  if (cycle) {
    return {
      graph,
      order: [],
      waves: [],
      delays: walked.delays,
      outputLatency: walked.outputLatency,
      feedback: { path: cycle, message: feedbackMessage(cycle) },
    }
  }
  return {
    graph,
    order: routeOrder(graph.nodes.map((node) => node.id), incomingFrom(graph.edges, new Set(graph.nodes.map((node) => node.id)))),
    waves: routeWaves(graph),
    delays: walked.delays,
    outputLatency: walked.outputLatency,
    feedback: null,
  }
}

/** Kahn order. Sources first. A leftover from a missed cycle is appended, matching the offline renderer. */
export function routeOrder(ids: readonly string[], incoming: ReadonlyMap<string, readonly { from: string }[]>) {
  const idList = [...ids]
  const known = new Set(idList)
  const pending = new Map(idList.map((id) => [id, (incoming.get(id) ?? []).filter((edge) => known.has(edge.from)).length]))
  const ready = idList.filter((id) => (pending.get(id) ?? 0) === 0)
  const ordered: string[] = []
  const downstream = downstreamOf(incoming)
  while (ready.length) {
    const id = ready.shift()!
    ordered.push(id)
    for (const next of downstream.get(id) ?? []) {
      pending.set(next, (pending.get(next) ?? 1) - 1)
      if ((pending.get(next) ?? 0) === 0) ready.push(next)
    }
  }
  for (const id of idList) if (!ordered.includes(id)) ordered.push(id)
  return ordered
}

/**
 * Pull scheduler for the same edges as `routeOrder`.
 * `take` never waits. A bus is simply absent from the ready queue until
 * `complete` has run for every track that feeds it.
 */
export function createScheduler(points: readonly RouteInput[]): PullScheduler {
  const graph = mixGraphFromRoutes(points)
  const ids = graph.nodes.map((node) => node.id)
  const incoming = incomingFrom(graph.edges, new Set(ids))
  const pending = new Map(ids.map((id) => [id, (incoming.get(id) ?? []).filter((edge) => ids.includes(edge.from)).length]))
  const ready = ids.filter((id) => (pending.get(id) ?? 0) === 0)
  const downstream = downstreamOf(incoming)
  let finished = 0
  return {
    take() {
      return ready.shift() ?? null
    },
    complete(id: string) {
      finished += 1
      for (const next of downstream.get(id) ?? []) {
        const left = (pending.get(next) ?? 1) - 1
        pending.set(next, left)
        if (left === 0) ready.push(next)
      }
    },
    done() {
      return finished >= ids.length
    },
    remaining() {
      return Math.max(0, ids.length - finished)
    },
  }
}

export function routeWaves(graph: MixGraph) {
  const incoming = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = incoming.get(edge.to) ?? []
    list.push(edge.from)
    incoming.set(edge.to, list)
  }
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const cached = depth.get(id)
    if (cached != null) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const sources = incoming.get(id) ?? []
    const next = sources.length ? 1 + Math.max(...sources.map(depthOf)) : 0
    visiting.delete(id)
    depth.set(id, next)
    return next
  }
  for (const node of graph.nodes) depthOf(node.id)
  const waves: string[][] = []
  for (const node of graph.nodes) {
    const at = depth.get(node.id) ?? 0
    while (waves.length <= at) waves.push([])
    waves[at].push(node.id)
  }
  return waves
}

/** Same path shape the mixer has always returned. `['a', 'b']` means a → b → a. */
export function feedbackPath(points: readonly RouteInput[]): string[] | null {
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

/**
 * Dependency-aware latency for the PDC pass.
 * Each node's output time is its own latency plus the slowest input.
 * An edge is delayed so it lands on that slowest input.
 */
export function walkLatency(points: readonly RouteInput[]) {
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
  const outputLatency = new Map<string, number>()
  const visiting = new Set<string>()
  const arrive = (id: string): number => {
    const cached = outputLatency.get(id)
    if (cached != null) return cached
    if (visiting.has(id)) return 0
    visiting.add(id)
    const own = byId.get(id)?.latency ?? 0
    const sources = incoming.get(id) ?? []
    const slowest = sources.length ? Math.max(...sources.map(arrive)) : 0
    visiting.delete(id)
    const total = slowest + Math.max(0, own)
    outputLatency.set(id, total)
    return total
  }
  for (const point of points) arrive(point.id)
  const delays = new Map<string, number>()
  const stamp = (from: string, to: string) => {
    const sources = incoming.get(to) ?? []
    const slowest = sources.length ? Math.max(...sources.map(arrive)) : 0
    delays.set(`${from}>${to}`, Math.max(0, Math.round(slowest - arrive(from))))
  }
  for (const point of points) {
    if (point.dest) stamp(point.id, point.dest)
    for (const send of point.sends) stamp(point.id, send)
  }
  return { delays, outputLatency }
}

/** A quantum overran when rendering it took longer than the device buffer. */
export function countOverruns(timesMs: readonly number[], quantum: number, sampleRate: number) {
  const budgetMs = sampleRate > 0 ? (quantum / sampleRate) * 1000 : 0
  let dropouts = 0
  let sum = 0
  let worst = 0
  for (const time of timesMs) {
    sum += time
    if (time > worst) worst = time
    if (time > budgetMs) dropouts += 1
  }
  const blocks = timesMs.length
  return {
    budgetMs,
    blocks,
    dropouts,
    meanMs: blocks ? sum / blocks : 0,
    worstMs: worst,
  }
}

function incomingFrom(edges: readonly MixEdge[], known: Set<string>) {
  const incoming = new Map<string, { from: string }[]>()
  for (const edge of edges) {
    if (!known.has(edge.to) || !known.has(edge.from)) continue
    const list = incoming.get(edge.to) ?? []
    list.push({ from: edge.from })
    incoming.set(edge.to, list)
  }
  return incoming
}

function downstreamOf(incoming: ReadonlyMap<string, readonly { from: string }[]>) {
  const downstream = new Map<string, string[]>()
  for (const [to, edges] of incoming) {
    for (const edge of edges) {
      const list = downstream.get(edge.from) ?? []
      list.push(to)
      downstream.set(edge.from, list)
    }
  }
  return downstream
}

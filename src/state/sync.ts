import type { Project } from '../model/types'
import {
  containsAudio,
  digestProject,
  diffProject,
  musicalClone,
  packStamps,
  setPath,
  unpackStamps,
  validOp,
  type ProjectOp,
  type Stamp,
  type StampWire,
  type SyncHello,
} from './ops'

const MAX_LOG = 180

interface SavedSync {
  projectId: string
  actor: string
  seq: number
  lamport: number
  log: ProjectOp[]
  stamps: StampWire[]
  seen: [string, number][]
  trimmed: [string, number][]
}

interface MemoryStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const memory = new Map<string, string>()

function storage(): MemoryStorage {
  const local = (globalThis as { localStorage?: MemoryStorage }).localStorage
  if (local) return local
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => {
      memory.set(key, value)
    },
  }
}

function storageKey(projectId: string) {
  return `cueharbor-sync:${projectId}`
}

export interface SyncReply {
  kind: 'none' | 'ops' | 'checkpoint'
  ops: ProjectOp[]
  project?: Project
  stamps?: StampWire[]
  lamport?: number
  digest?: string
}

/**
 * Compact project journal.
 * Live edits become field ops. A peer that cannot be reached by those ops
 * gets one musical checkpoint (no audio) and merges it by stamp.
 */
export class ProjectSync {
  actor: string
  seq = 0
  lamport = 0
  silence = false
  private projectId = ''
  private baselineJson = ''
  private baseline: Project | null = null
  private log: ProjectOp[] = []
  private pending: ProjectOp[] = []
  private stamps = new Map<string, Stamp>()
  private seen = new Map<string, number>()
  /** Highest sequence removed from the log for each actor. */
  private trimmed = new Map<string, number>()
  private buffered = new Map<string, ProjectOp[]>()

  constructor(actor?: string) {
    this.actor = actor || `sync_${Math.random().toString(36).slice(2, 10)}`
  }

  hello(project: Project): SyncHello {
    const seen: Record<string, number> = {}
    for (const [actor, seq] of this.seen) seen[actor] = seq
    seen[this.actor] = this.seq
    return { actor: this.actor, seq: this.seq, lamport: this.lamport, digest: digestProject(project), seen }
  }

  observe(project: Project): ProjectOp[] {
    if (this.silence) return []
    const current = musicalClone(project)
    const next = digestProject(project)
    if (next === this.baselineJson) return []
    const raw = diffProject(this.baseline, current)
    this.baseline = current
    this.baselineJson = next
    if (!raw.length) return []
    const ops = raw.map((change) => this.stamp(change.p, change.v))
    this.pending.push(...ops)
    this.persist()
    return ops
  }

  peek() {
    return this.pending.slice()
  }

  drain() {
    const ops = this.pending
    this.pending = []
    return ops
  }

  /**
   * Apply remote ops in per-actor order.
   * Returns whether a sequence gap is still buffered.
   */
  ingest(project: Project, incoming: ProjectOp[]): { applied: ProjectOp[]; gap: boolean } {
    for (const op of incoming) {
      if (!validOp(op) || containsAudio(op.v)) continue
      const queue = this.buffered.get(op.a) ?? []
      queue.push(op)
      this.buffered.set(op.a, queue)
    }
    const applied: ProjectOp[] = []
    let gap = false
    for (const [actor, queued] of this.buffered) {
      queued.sort((left, right) => left.s - right.s)
      const rest: ProjectOp[] = []
      let have = this.seen.get(actor) ?? 0
      let blocked = false
      for (const op of queued) {
        if (op.s <= have) continue
        if (blocked || op.s > have + 1) {
          blocked = true
          rest.push(op)
          continue
        }
        if (this.applyOne(project, op)) applied.push(op)
        have = op.s
        this.seen.set(actor, have)
        this.lamport = Math.max(this.lamport, op.l)
      }
      if (rest.length) {
        this.buffered.set(actor, rest)
        gap = true
      } else this.buffered.delete(actor)
    }
    if (applied.length) {
      this.baseline = musicalClone(project)
      this.baselineJson = digestProject(project)
      this.persist()
    }
    return { applied, gap }
  }

  replyTo(hello: SyncHello, project: Project): SyncReply {
    this.lamport = Math.max(this.lamport, Number(hello.lamport) || 0)
    const digest = digestProject(project)
    const seen = hello.seen || {}
    if (digest === hello.digest) return { kind: 'none', ops: [] }
    const known = (seen[this.actor] ?? 0) > 0
    const ops = known && this.canPatch(seen) ? this.opsSince(seen) : []
    if (ops.length) return { kind: 'ops', ops }
    return {
      kind: 'checkpoint',
      ops: [],
      project: musicalClone(project),
      stamps: packStamps(this.stamps),
      lamport: this.lamport,
      digest,
    }
  }

  /**
   * Fold a checkpoint into the local project.
   * The caller normalizes and installs the returned project.
   * Reply ops are the local stamps that still win.
   */
  merge(local: Project, remote: Project, remoteWire: StampWire[] | undefined, prefer: 'local' | 'remote', remoteLamport = 0, remoteActor = '', remoteSeq = 0): { project: Project; reply: ProjectOp[] } {
    const remoteStamps = unpackStamps(remoteWire)
    const changes = diffProject(musicalClone(remote), musicalClone(local))
    const next = musicalClone(remote)
    const reply: ProjectOp[] = []
    for (const change of changes) {
      const winner = pick(this.stamps.get(change.p), remoteStamps.get(change.p), prefer)
      if (winner !== 'local') continue
      setPath(next, change.p, change.v)
      reply.push(this.opFor(change.p, change.v))
    }
    for (const [path, stamp] of remoteStamps) {
      const mine = this.stamps.get(path)
      if (!mine || stampBeats(stamp, mine)) this.stamps.set(path, stamp)
    }
    this.lamport = Math.max(this.lamport, remoteLamport)
    if (remoteActor && remoteSeq > 0) this.seen.set(remoteActor, Math.max(this.seen.get(remoteActor) ?? 0, remoteSeq))
    this.persist()
    return { project: next, reply }
  }

  /** The installed project is the baseline, so normalize does not echo as edits. */
  adopt(project: Project) {
    this.projectId = project.id || this.projectId
    this.baseline = musicalClone(project)
    this.baselineJson = digestProject(project)
    this.persist()
  }

  rebase(project: Project) {
    this.projectId = project.id
    const saved = this.read(project.id)
    this.baseline = musicalClone(project)
    this.baselineJson = digestProject(project)
    this.pending = []
    this.buffered.clear()
    if (!saved) {
      this.log = []
      this.stamps.clear()
      this.seen.clear()
      this.trimmed.clear()
      this.seq = 0
      this.seen.set(this.actor, 0)
      return
    }
    this.actor = saved.actor || this.actor
    this.seq = saved.seq || 0
    this.lamport = saved.lamport || 0
    this.log = Array.isArray(saved.log) ? saved.log : []
    this.stamps = unpackStamps(saved.stamps)
    this.seen = new Map(saved.seen || [])
    this.trimmed = new Map(saved.trimmed || [])
    this.seen.set(this.actor, this.seq)
  }

  private stamp(path: string, value: unknown): ProjectOp {
    this.lamport += 1
    this.seq += 1
    const op: ProjectOp = { a: this.actor, s: this.seq, l: this.lamport, p: path, v: value }
    this.log.push(op)
    this.stamps.set(path, { l: op.l, a: op.a })
    this.seen.set(this.actor, this.seq)
    this.trim()
    return op
  }

  private opFor(path: string, value: unknown): ProjectOp {
    for (let index = this.log.length - 1; index >= 0; index--) {
      const op = this.log[index]
      if (op.a === this.actor && op.p === path) return op
    }
    return this.stamp(path, value)
  }

  private applyOne(project: Project, op: ProjectOp) {
    const stamp = this.stamps.get(op.p)
    if (!opWins(op, stamp)) return false
    if (op.v == null && blockedByDescendant(this.stamps, op)) return false
    const saved: [string, unknown][] = []
    if (op.v != null) {
      for (const [path, existing] of this.stamps) {
        if (!path.startsWith(`${op.p}/`) || !stampBeats(existing, { l: op.l, a: op.a })) continue
        const value = readPath(project, path)
        if (value !== undefined) saved.push([path, value])
      }
    }
    setPath(project, op.p, op.v)
    for (const [path, value] of saved) setPath(project, path, value)
    this.stamps.set(op.p, { l: op.l, a: op.a })
    if (op.v == null) {
      for (const path of [...this.stamps.keys()]) {
        if (path.startsWith(`${op.p}/`)) this.stamps.delete(path)
      }
    }
    return true
  }

  private opsSince(seen: Record<string, number>) {
    return this.log.filter((op) => op.s > (seen[op.a] ?? 0))
  }

  private canPatch(seen: Record<string, number>) {
    for (const [actor, seq] of this.trimmed) {
      if ((seen[actor] ?? 0) < seq) return false
    }
    return true
  }

  private trim() {
    if (this.log.length <= MAX_LOG) return
    const removed = this.log.splice(0, this.log.length - MAX_LOG)
    for (const op of removed) {
      this.trimmed.set(op.a, Math.max(this.trimmed.get(op.a) ?? 0, op.s))
    }
  }

  private persist() {
    if (!this.projectId) return
    const saved: SavedSync = {
      projectId: this.projectId,
      actor: this.actor,
      seq: this.seq,
      lamport: this.lamport,
      log: this.log,
      stamps: packStamps(this.stamps),
      seen: [...this.seen],
      trimmed: [...this.trimmed],
    }
    try {
      storage().setItem(storageKey(this.projectId), JSON.stringify(saved))
    } catch {
      /* a full disk keeps the open project in memory */
    }
  }

  private read(projectId: string): SavedSync | null {
    try {
      const raw = storage().getItem(storageKey(projectId))
      if (!raw) return null
      const parsed = JSON.parse(raw) as SavedSync
      if (!parsed || parsed.projectId !== projectId) return null
      return parsed
    } catch {
      return null
    }
  }
}

function opWins(op: ProjectOp, stamp?: Stamp) {
  if (!stamp) return true
  if (op.l !== stamp.l) return op.l > stamp.l
  if (op.a !== stamp.a) return op.a > stamp.a
  return false
}

function stampBeats(stamp: Stamp, other: Stamp) {
  if (stamp.l !== other.l) return stamp.l > other.l
  return stamp.a > other.a
}

function pick(local: Stamp | undefined, remote: Stamp | undefined, prefer: 'local' | 'remote'): 'local' | 'remote' {
  if (!local && !remote) return prefer
  if (!local) return 'remote'
  if (!remote) return 'local'
  if (local.l !== remote.l) return local.l > remote.l ? 'local' : 'remote'
  if (local.a !== remote.a) return local.a > remote.a ? 'local' : 'remote'
  return prefer
}

function blockedByDescendant(stamps: Map<string, Stamp>, op: ProjectOp) {
  for (const [path, stamp] of stamps) {
    if (path.startsWith(`${op.p}/`) && stampBeats(stamp, { l: op.l, a: op.a })) return true
  }
  return false
}

function readPath(root: object, path: string): unknown {
  const parts = path.split('/')
  let node: any = root
  for (const key of parts) {
    if (node == null) return undefined
    node = Array.isArray(node) ? node.find((item) => item?.id === key) : node[key]
  }
  return node
}

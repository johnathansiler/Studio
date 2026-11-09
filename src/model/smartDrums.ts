import type { BeatPattern, StepCell } from './steps'
import { emptyCell } from './steps'

export type DrumRole = 'kick' | 'snare' | 'clap' | 'rim' | 'hat' | 'openhat' | 'perc' | 'cymbal' | 'other'

/** A pitched row. Drums stay on `DrumRole`. An unrecognized sound stays `other`. */
export type SoundRole = DrumRole | 'melodic'

/** Mulberry32. The same seed always rebuilds the same beat. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The name of the loaded sound, when it names a drum. Row position is not a role. */
function roleFromName(name: string): DrumRole | null {
  const text = name.toLowerCase()
  if (/rim|sidestick|cross.?stick|edge stick/.test(text)) return 'rim'
  if (/crash|ride|cymbal|china|splash/.test(text)) return 'cymbal'
  if (/open/.test(text) && /hat|hh|hi-?hat/.test(text)) return 'openhat'
  if (/hat|hh|hi-?hat/.test(text)) return 'hat'
  if (/clap|hand/.test(text)) return 'clap'
  if (/snare|\bsd\b/.test(text)) return 'snare'
  if (/kick|bass.?drum|\bbd\b/.test(text)) return 'kick'
  if (/tom/.test(text)) return 'perc'
  if (/perc|shaker|conga|bongo|cowbell|tamb/.test(text)) return 'perc'
  return null
}

function roleFromKind(kind: string): DrumRole | null {
  if (kind === 'openhat') return 'openhat'
  if (kind === 'hat') return 'hat'
  if (kind === 'clap') return 'clap'
  if (kind === 'snare') return 'snare'
  if (kind === 'kick') return 'kick'
  if (kind === 'cymbal') return 'cymbal'
  if (kind === 'tom' || kind === 'perc') return 'perc'
  return null
}

/** Pitched instruments the step grid can play by changing `cell.pitch`. */
function melodicName(name: string): boolean {
  return /piano|keys|keyboard|rhodes|organ|\bbass\b|lead|pluck|pad|synth|string|guitar|melody|chord|arp|brass|flute|bell|marimba|vibes|choir/.test(name.toLowerCase())
}

/**
 * Role of the loaded sound. A name that says kick, snare, hat, and so on wins,
 * then the channel kind. Neither one is the row index. A pitched name on a
 * channel that is not already a drum is melodic. Anything else is an honest
 * unknown (`other`): a plain downbeat, not a copied drum groove.
 */
export function drumRole(channel: { name: string; kind: string }): SoundRole {
  const named = roleFromName(channel.name)
  if (named) return named
  const kind = roleFromKind(channel.kind)
  if (kind) return kind
  if (melodicName(channel.name)) return 'melodic'
  return 'other'
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = items.slice()
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1))
    const held = copy[index]
    copy[index] = copy[swap]
    copy[swap] = held
  }
  return copy
}

function writeHits(cells: StepCell[], count: number, hits: Map<number, number>): StepCell[] {
  const next = cells.map((cell) => ({ ...cell }))
  while (next.length < count) next.push(emptyCell())
  for (let index = 0; index < count; index += 1) {
    const velocity = hits.get(index)
    const prev = next[index] ?? emptyCell()
    next[index] = velocity == null ? { ...prev, on: false } : { ...prev, on: true, velocity }
  }
  return next
}

function inBar(count: number, visit: (base: number, room: number) => void) {
  for (let base = 0; base < count; base += 16) visit(base, Math.min(16, count - base))
}

function kickHits(count: number, rng: () => number): Map<number, number> {
  const hits = new Map<number, number>()
  inBar(count, (base, room) => {
    if (room <= 0) return
    hits.set(base, 0.9 + rng() * 0.1)
    const avoid = new Set([4, 12])
    const prefer = [3, 6, 7, 8, 10, 11, 14, 15].filter((step) => step < room && !avoid.has(step))
    const rest: number[] = []
    for (let step = 1; step < room; step += 1) if (!avoid.has(step) && !prefer.includes(step)) rest.push(step)
    const target = Math.min(5, 3 + Math.floor(rng() * 3), 1 + prefer.length + rest.length)
    const ordered = [...shuffle(prefer, rng), ...shuffle(rest, rng)]
    for (const step of ordered) {
      const placed = [...hits.keys()].filter((index) => index >= base && index < base + 16).length
      if (placed >= target) break
      hits.set(base + step, 0.55 + rng() * 0.3)
    }
  })
  return hits
}

function backbeatHits(count: number, rng: () => number, ghosts: number): Map<number, number> {
  const hits = new Map<number, number>()
  inBar(count, (base, room) => {
    for (const step of [4, 12]) {
      if (step < room) hits.set(base + step, 0.82 + rng() * 0.18)
    }
    if (ghosts <= 0) return
    const pool: number[] = []
    for (let step = 0; step < room; step += 1) if (step !== 4 && step !== 12) pool.push(base + step)
    const extra = Math.floor(rng() * (ghosts + 1))
    for (const step of shuffle(pool, rng).slice(0, extra)) hits.set(step, 0.12 + rng() * 0.2)
  })
  return hits
}

function hatHits(count: number, rng: () => number): Map<number, number> {
  const hits = new Map<number, number>()
  for (let step = 0; step < count; step += 2) {
    const accent = step % 4 === 0
    if (accent || rng() < 0.7) hits.set(step, accent ? 0.72 + rng() * 0.22 : 0.38 + rng() * 0.22)
  }
  const offs: number[] = []
  for (let step = 1; step < count; step += 2) offs.push(step)
  for (const step of shuffle(offs, rng).slice(0, Math.floor(rng() * 3))) hits.set(step, 0.26 + rng() * 0.16)
  inBar(count, (base) => {
    const inside = [...hits.keys()].filter((index) => index >= base && index < base + 16).sort((a, b) => a - b)
    while (inside.length > 12) {
      const drop = inside.find((index) => index % 4 !== 0) ?? inside[inside.length - 1]
      hits.delete(drop)
      inside.splice(inside.indexOf(drop), 1)
    }
  })
  return hits
}

function openHatHits(count: number, rng: () => number): Map<number, number> {
  const hits = new Map<number, number>()
  inBar(count, (base, room) => {
    const pool = [2, 6, 10, 14].filter((step) => step < room).map((step) => base + step)
    const want = Math.min(pool.length, 1 + Math.floor(rng() * 3))
    for (const step of shuffle(pool, rng).slice(0, want)) hits.set(step, 0.62 + rng() * 0.28)
  })
  return hits
}

function percHits(count: number, rng: () => number): Map<number, number> {
  const weighted: number[] = []
  for (let step = 0; step < count; step += 1) {
    const rel = step % 16
    let copies = rel >= 12 ? 5 : rel >= 8 ? 2 : 1
    if (step >= count - 4) copies += 4
    for (let copy = 0; copy < copies; copy += 1) weighted.push(step)
  }
  const hits = new Map<number, number>()
  const want = Math.min(4, Math.max(1, 1 + Math.floor(rng() * 4)))
  for (const step of shuffle(weighted, rng)) {
    if (hits.size >= want) break
    hits.set(step, 0.4 + rng() * 0.4)
  }
  return hits
}

function cymbalHits(count: number, rng: () => number): Map<number, number> {
  const hits = new Map<number, number>()
  if (count <= 0) return hits
  hits.set(0, 0.8 + rng() * 0.15)
  if (count > 8 && rng() < 0.55) hits.set(8, 0.5 + rng() * 0.25)
  if (count > 12 && rng() < 0.35) hits.set(12, 0.4 + rng() * 0.2)
  return hits
}

const MELODY = [0, 3, 5, 7, 10, 12, 7, 5, 3, 0, 5, 10]

/**
 * A short phrase on the grid. Strong beats stay. Offbeats come and go so a new
 * press is a new rhythm, not a coin flip on every step. Pitch is a semitone
 * offset from the channel note. Swing is left to playback.
 */
function melodicHits(count: number, rng: () => number): Map<number, { velocity: number; pitch: number }> {
  const hits = new Map<number, { velocity: number; pitch: number }>()
  const shift = Math.floor(rng() * MELODY.length)
  inBar(count, (base, room) => {
    const motif = [0, 3, 6, 8, 10, 12, 14]
    for (const step of motif) {
      if (step >= room) continue
      const strong = step % 4 === 0
      if (!strong && rng() < 0.4) continue
      if (strong && step !== 0 && rng() < 0.25) continue
      const pitch = MELODY[(step + shift) % MELODY.length]
      hits.set(base + step, {
        velocity: strong ? 0.78 + rng() * 0.18 : 0.4 + rng() * 0.22,
        pitch,
      })
    }
  })
  if (!hits.size && count > 0) hits.set(0, { velocity: 0.72, pitch: 0 })
  inBar(count, (base, room) => {
    if (room <= 1) return
    const at = Math.min(3, room - 1)
    const down = hits.get(base)
    const next = hits.get(base + at)
    if (down && next && next.pitch !== down.pitch) return
    hits.set(base + at, { velocity: 0.52, pitch: (down?.pitch ?? 0) + 7 })
  })
  return hits
}

/**
 * Unknown role. One downbeat per bar, and sometimes the middle of the bar.
 * That is a plain pulse, not a kick, snare, or hat pattern and not a random fill.
 */
function otherHits(count: number, rng: () => number): Map<number, number> {
  const hits = new Map<number, number>()
  inBar(count, (base, room) => {
    if (room <= 0) return
    hits.set(base, 0.62 + rng() * 0.12)
    if (room > 8 && rng() < 0.45) hits.set(base + 8, 0.38 + rng() * 0.16)
  })
  return hits
}

export function hitsForRole(role: DrumRole, count: number, rng: () => number): Map<number, number> {
  if (role === 'kick') return kickHits(count, rng)
  if (role === 'snare') return backbeatHits(count, rng, 3)
  if (role === 'clap') return backbeatHits(count, rng, 2)
  if (role === 'rim') return backbeatHits(count, rng, 1)
  if (role === 'hat') return hatHits(count, rng)
  if (role === 'openhat') return openHatHits(count, rng)
  if (role === 'perc') return percHits(count, rng)
  if (role === 'cymbal') return cymbalHits(count, rng)
  return otherHits(count, rng)
}

function writeMelodic(cells: StepCell[], count: number, hits: Map<number, { velocity: number; pitch: number }>): StepCell[] {
  const next = cells.map((cell) => ({ ...cell }))
  while (next.length < count) next.push(emptyCell())
  for (let index = 0; index < count; index += 1) {
    const hit = hits.get(index)
    const prev = next[index] ?? emptyCell()
    next[index] = hit ? { ...prev, on: true, velocity: hit.velocity, pitch: hit.pitch } : { ...prev, on: false }
  }
  return next
}

function chokeHats(pattern: BeatPattern, openSteps: Set<number>, chosen: Set<string>) {
  for (const channel of pattern.channels) {
    if (!chosen.has(channel.id) || drumRole(channel) !== 'hat') continue
    const count = channel.steps || pattern.steps
    channel.cells = channel.cells.map((cell, index) => (index < count && openSteps.has(index) ? { ...cell, on: false } : cell))
  }
}

/**
 * Role-aware pattern. `only` limits the rows that are rewritten.
 * Open hats choke closed hats on the steps they occupy.
 * Swing on the pattern is left as it is; playback delays the off-steps.
 */
export function applySmartDrums(pattern: BeatPattern, only: string[] | null, rng: () => number) {
  const chosen = new Set(only ?? pattern.channels.map((channel) => channel.id))
  const openSteps = new Set<number>()
  for (const channel of pattern.channels) {
    if (!chosen.has(channel.id)) continue
    const count = channel.steps || pattern.steps
    const role = drumRole(channel)
    if (role === 'melodic') {
      channel.cells = writeMelodic(channel.cells, count, melodicHits(count, rng))
      continue
    }
    const hits = hitsForRole(role, count, rng)
    channel.cells = writeHits(channel.cells, count, hits)
    if (role === 'openhat') for (const step of hits.keys()) openSteps.add(step)
  }
  if (openSteps.size) chokeHats(pattern, openSteps, chosen)
}

/** Which steps are lit. Velocity-only changes do not count as a new variation. */
export function patternOnMask(pattern: BeatPattern, only?: string[] | null): string {
  const chosen = new Set(only ?? pattern.channels.map((channel) => channel.id))
  return pattern.channels
    .filter((channel) => chosen.has(channel.id))
    .map((channel) => {
      const count = channel.steps || pattern.steps
      return `${channel.id}:${channel.cells.slice(0, count).map((cell) => (cell.on ? '1' : '0')).join('')}`
    })
    .join('|')
}

export function clonePatternCells(pattern: BeatPattern): StepCell[][] {
  return pattern.channels.map((channel) => channel.cells.map((cell) => ({ ...cell })))
}

export function restorePatternCells(pattern: BeatPattern, cells: StepCell[][]) {
  pattern.channels.forEach((channel, index) => {
    const saved = cells[index]
    if (saved) channel.cells = saved.map((cell) => ({ ...cell }))
  })
}

/**
 * Apply a new seed until the lit steps differ from the pattern as it is now.
 * Returns the seed that landed. A fixed seed belongs to `applySmartDrums` instead.
 */
export function applyFreshDrums(pattern: BeatPattern, only: string[] | null, nextSeed: () => number, limit = 24): number {
  const beforeCells = clonePatternCells(pattern)
  const before = patternOnMask(pattern, only)
  let used = 0
  for (let attempt = 0; attempt < limit; attempt += 1) {
    if (attempt > 0) restorePatternCells(pattern, beforeCells)
    used = nextSeed() >>> 0
    applySmartDrums(pattern, only, mulberry32(used))
    if (patternOnMask(pattern, only) !== before) return used
  }
  return used
}

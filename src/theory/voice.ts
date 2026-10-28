import { absoluteCents, toneFromCents } from './pitch'
import type { Tone, VoicingId, VoicingSpec } from './types'

export const VOICINGS: VoicingSpec[] = [
  { id: 'close', name: 'Close', description: 'Notes packed inside one octave.' },
  { id: 'drop2', name: 'Drop 2', description: 'The second note from the top drops an octave.' },
  { id: 'drop3', name: 'Drop 3', description: 'The third note from the top drops an octave.' },
  { id: 'drop24', name: 'Drop 2+4', description: 'The second and fourth notes from the top drop an octave.' },
  { id: 'spread', name: 'Spread', description: 'The second note jumps up an octave.' },
  { id: 'shell', name: 'Shell', description: 'Root, third, and seventh. The color tones stay, the fifth goes.' },
  { id: 'rootless', name: 'Rootless', description: 'Drops the lowest note so the guide tones lead.' },
  { id: 'quartal', name: 'Quartal', description: 'Spaces the chord tones about a fourth apart.' },
  { id: 'cluster', name: 'Cluster', description: 'Pulls every note into a tight band.' },
]

export interface VoiceOptions {
  inversion?: number
  voicing?: VoicingId
  octave?: boolean
  voiceLead?: boolean
  previous?: Tone[]
}

export function voiceTones(tones: Tone[], options: VoiceOptions = {}): Tone[] {
  let abs = unique(tones.map(absoluteCents).sort((a, b) => a - b))
  if (!abs.length) return []
  const inversion = Math.max(0, Math.round(options.inversion ?? 0)) % abs.length
  abs = invert(abs, inversion)
  abs = recipe(abs, options.voicing ?? 'close')
  if (options.octave) abs = unique([...abs, Math.min(...abs) + 1200]).sort((a, b) => a - b)
  let voiced = abs.map(toneFromCents).filter((tone) => tone.midi >= 0 && tone.midi <= 127)
  if (options.voiceLead && options.previous?.length) voiced = nearestRegister(voiced, options.previous)
  return voiced
}

/** Move a finished voicing by octaves. The bass and the spacing stay put. */
function nearestRegister(target: Tone[], previous: Tone[]): Tone[] {
  const prev = previous.map(absoluteCents)
  const base = unique(target.map(absoluteCents).sort((a, b) => a - b))
  let best = base
  let bestCost = movementCents(base, prev)
  for (const shift of [-2400, -1200, 1200, 2400]) {
    const candidate = base.map((cents) => cents + shift)
    if (candidate.some((cents) => cents < 0 || cents > 12700)) continue
    const cost = movementCents(candidate, prev)
    if (cost < bestCost) {
      bestCost = cost
      best = candidate
    }
  }
  return best.map(toneFromCents)
}

/** Minimal motion from the previous chord. Common tones stay put. */
export function voiceLead(target: Tone[], previous: Tone[]): Tone[] {
  if (!previous.length || !target.length) return target
  const prev = previous.map(absoluteCents)
  const base = unique(target.map(absoluteCents).sort((a, b) => a - b))
  let best = base
  let bestCost = Infinity
  for (let inv = 0; inv < base.length; inv++) {
    const inverted = invert(base, inv)
    for (const shift of [-1200, 0, 1200]) {
      const candidate = inverted.map((cents) => cents + shift).sort((a, b) => a - b)
      const cost = movementCents(candidate, prev)
      if (cost < bestCost) {
        bestCost = cost
        best = candidate
      }
    }
  }
  return best.map(toneFromCents)
}

export function movementCents(candidate: number[], previous: number[]) {
  const used = new Set<number>()
  let cost = 0
  for (const pitch of candidate) {
    let best = Infinity
    let index = -1
    previous.forEach((other, i) => {
      if (used.has(i)) return
      const dist = Math.abs(other - pitch)
      if (dist < best) {
        best = dist
        index = i
      }
    })
    if (index >= 0) used.add(index)
    cost += Number.isFinite(best) ? best : 1200
  }
  return cost
}

function recipe(notes: number[], voicing: VoicingId) {
  const sorted = [...notes].sort((a, b) => a - b)
  if (sorted.length < 2) return sorted
  if (voicing === 'drop2' && sorted.length > 2) return dropFromTop(sorted, [1])
  if (voicing === 'drop3' && sorted.length > 3) return dropFromTop(sorted, [2])
  if (voicing === 'drop24' && sorted.length > 3) return dropFromTop(sorted, [1, 3])
  if (voicing === 'spread' && sorted.length > 2) {
    const next = sorted.slice()
    next[1] += 1200
    return next.sort((a, b) => a - b)
  }
  if (voicing === 'shell') return shell(sorted)
  if (voicing === 'rootless' && sorted.length > 3) return sorted.slice(1)
  if (voicing === 'quartal') return spaceBy(sorted, 500)
  if (voicing === 'cluster') return cluster(sorted)
  return sorted
}

function dropFromTop(sorted: number[], fromTop: number[]) {
  const next = sorted.slice()
  for (const index of fromTop) {
    const at = next.length - 1 - index
    if (at >= 0) next[at] -= 1200
  }
  return next.sort((a, b) => a - b)
}

function shell(sorted: number[]) {
  const root = sorted[0]
  const rel = sorted.map((cents) => cents - root)
  const keep = new Set<number>([sorted[0]])
  const third = sorted.find((_, index) => rel[index] >= 250 && rel[index] <= 500)
  const seventh = sorted.find((_, index) => rel[index] >= 900 && rel[index] <= 1200)
  const fifth = sorted.find((_, index) => rel[index] >= 600 && rel[index] <= 850)
  if (third != null) keep.add(third)
  if (seventh != null) keep.add(seventh)
  else if (fifth != null) keep.add(fifth)
  const extra = sorted.filter((cents) => cents - root > 1200)
  for (const cents of extra) keep.add(cents)
  const picked = [...keep].sort((a, b) => a - b)
  return picked.length >= 2 ? picked : sorted
}

function spaceBy(sorted: number[], gap: number) {
  const next = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    let cents = sorted[i]
    while (cents - next[i - 1] < gap - 80) cents += 1200
    while (cents - next[i - 1] > gap + 250 && cents - 1200 > next[i - 1] + 150) cents -= 1200
    next.push(cents)
  }
  return next.sort((a, b) => a - b)
}

function cluster(sorted: number[]) {
  const anchor = sorted[0]
  return sorted.map((cents) => {
    let next = cents
    while (next - anchor > 400) next -= 1200
    while (next < anchor) next += 1200
    return next
  }).sort((a, b) => a - b)
}

function invert(notes: number[], times: number) {
  let next = [...notes].sort((a, b) => a - b)
  for (let i = 0; i < times; i++) {
    const bass = next[0]
    next = [...next.slice(1), bass + 1200]
  }
  return next
}

function unique(notes: number[]) {
  const out: number[] = []
  for (const note of notes) {
    if (!out.some((other) => Math.abs(other - note) < 2)) out.push(note)
  }
  return out
}

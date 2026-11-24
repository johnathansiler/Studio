/**
 * Score key guesses with the MIREX 2017 weights:
 * exact 1, same-mode fifth 0.5, relative 0.3, parallel 0.2, anything else 0.
 */

export type Mode = 'major' | 'minor'
export type Relation = 'exact' | 'fifth' | 'relative' | 'parallel' | 'other' | 'unsure'

export interface Truth {
  root: number
  mode: Mode
}

export interface Guess {
  root: number
  mode: Mode
  corr: number
  runner: number
  confidence: number
}

export interface Tally {
  n: number
  exact: number
  fifth: number
  relative: number
  parallel: number
  other: number
  unsure: number
  exactRate: number
  relativeRate: number
  mirex: number
  /** Exact rate among guesses that were not "unsure". */
  precision: number
  coverage: number
}

const EDMA_ESSENTIA = {
  major: [1, 0.29, 0.5, 0.4, 0.6, 0.56, 0.32, 0.8, 0.31, 0.45, 0.42, 0.39],
  minor: [1, 0.31, 0.44, 0.58, 0.33, 0.49, 0.29, 0.78, 0.43, 0.29, 0.53, 0.32],
}
const FARALDO = {
  major: [1, 0.157808021, 0.366133251, 0.127058867, 0.588516922, 0.332227667, 0.107226417, 0.710546603, 0.15476814, 0.373265925, 0.097658604, 0.443561062],
  minor: [1, 0.150171156, 0.378050852, 0.45244178, 0.139651959, 0.385338478, 0.122140361, 0.696360448, 0.394150762, 0.188959016, 0.200616277, 0.346860558],
}
const TEMPERLEY = {
  major: [5, 2, 3.5, 2, 4.5, 4, 2, 4.5, 2, 3.5, 1.5, 4],
  minor: [5, 2, 3.5, 4.5, 2, 4, 2, 4.5, 3.5, 2, 1.5, 4],
}
const KRUMHANSL = {
  major: [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
  minor: [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
}
const SHAATH = {
  major: [6.6, 2, 3.5, 2.3, 4.6, 4, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
  minor: [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4, 2.7, 4.3, 3.2],
}

export type ProfileId = 'edma-essentia' | 'faraldo' | 'temperley' | 'krumhansl' | 'shaath' | 'blend' | 'learned'

const PUBLISHED: Record<Exclude<ProfileId, 'blend' | 'learned'>, { major: number[]; minor: number[] }> = {
  'edma-essentia': EDMA_ESSENTIA,
  faraldo: FARALDO,
  temperley: TEMPERLEY,
  krumhansl: KRUMHANSL,
  shaath: SHAATH,
}

export function verdict(truth: Truth | null, heard: Truth | null): { relation: Relation; mirex: number } {
  if (!truth) return { relation: 'other', mirex: 0 }
  if (!heard) return { relation: 'unsure', mirex: 0 }
  const up = (heard.root - truth.root + 12) % 12
  if (up === 0 && heard.mode === truth.mode) return { relation: 'exact', mirex: 1 }
  if (up === 0 && heard.mode !== truth.mode) return { relation: 'parallel', mirex: 0.2 }
  if (heard.mode !== truth.mode && truth.mode === 'major' && up === 9) return { relation: 'relative', mirex: 0.3 }
  if (heard.mode !== truth.mode && truth.mode === 'minor' && up === 3) return { relation: 'relative', mirex: 0.3 }
  if (heard.mode === truth.mode && (up === 7 || up === 5)) return { relation: 'fifth', mirex: 0.5 }
  return { relation: 'other', mirex: 0 }
}

export function tally(rows: { relation: Relation; mirex: number }[]): Tally {
  const counts: Record<string, number> = {}
  let mirex = 0
  for (const row of rows) {
    counts[row.relation] = (counts[row.relation] ?? 0) + 1
    mirex += row.mirex
  }
  const n = rows.length
  const exact = counts.exact ?? 0
  const guessed = n - (counts.unsure ?? 0)
  const round = (value: number) => Math.round(value * 1000) / 1000
  return {
    n,
    exact,
    fifth: counts.fifth ?? 0,
    relative: counts.relative ?? 0,
    parallel: counts.parallel ?? 0,
    other: counts.other ?? 0,
    unsure: counts.unsure ?? 0,
    exactRate: n ? round(exact / n) : 0,
    relativeRate: n ? round((counts.relative ?? 0) / n) : 0,
    mirex: n ? round(mirex / n) : 0,
    precision: guessed ? round(exact / guessed) : 0,
    coverage: n ? round(guessed / n) : 0,
  }
}

export function gatePcp(pcp: number[]) {
  let max = 0
  for (const value of pcp) if (value > max) max = value
  if (max <= 1e-12) return pcp.map(() => 0)
  return pcp.map((value) => {
    const scaled = value / max
    return scaled < 0.2 ? 0 : scaled
  })
}

function pearsonShift(pcp: number[], profile: number[], shift: number) {
  const n = 12
  let mean1 = 0
  let mean2 = 0
  for (let i = 0; i < n; i++) {
    mean1 += pcp[i]
    mean2 += profile[i]
  }
  mean1 /= n
  mean2 /= n
  let std1 = 0
  let std2 = 0
  let dot = 0
  for (let i = 0; i < n; i++) {
    const index = (i - shift + n) % n
    const a = pcp[i] - mean1
    const b = profile[index] - mean2
    dot += a * b
    std1 += a * a
    std2 += b * b
  }
  std1 = Math.sqrt(std1)
  std2 = Math.sqrt(std2)
  if (std1 < 1e-8 || std2 < 1e-8) return 0
  return dot / (std1 * std2)
}

export interface Ranked {
  root: number
  mode: Mode
  corr: number
}

export function rankProfile(pcp: number[], major: number[], minor: number[], useGate = true): Ranked[] {
  const chroma = useGate ? gatePcp(pcp) : pcp
  const rows: Ranked[] = []
  for (let shift = 0; shift < 12; shift++) {
    const root = (9 + shift) % 12
    rows.push({ root, mode: 'major', corr: pearsonShift(chroma, major, shift) })
    rows.push({ root, mode: 'minor', corr: pearsonShift(chroma, minor, shift) })
  }
  rows.sort((a, b) => b.corr - a.corr)
  return rows
}

export function profilesOf(id: ProfileId, learned?: { major: number[]; minor: number[] }) {
  if (id === 'learned') {
    if (!learned) throw new Error('learned profile missing')
    return learned
  }
  if (id === 'blend') return null
  return PUBLISHED[id]
}

export function rankNamed(pcp: number[], id: ProfileId, learned?: { major: number[]; minor: number[] }) {
  if (id === 'blend') {
    const parts: Ranked[][] = ['faraldo', 'temperley', 'krumhansl'].map((name) => rankProfile(pcp, PUBLISHED[name as 'faraldo'].major, PUBLISHED[name as 'faraldo'].minor))
    const keys: Ranked[] = []
    for (let root = 0; root < 12; root++) {
      for (const mode of ['major', 'minor'] as const) {
        let corr = 0
        for (const part of parts) {
          const found = part.find((row) => row.root === root && row.mode === mode)
          corr += found?.corr ?? 0
        }
        keys.push({ root, mode, corr: corr / parts.length })
      }
    }
    keys.sort((a, b) => b.corr - a.corr)
    return keys
  }
  const profile = profilesOf(id, learned)
  if (!profile) return []
  return rankProfile(pcp, profile.major, profile.minor)
}

export function relativeOf(root: number, mode: Mode): Truth {
  if (mode === 'major') return { root: (root + 9) % 12, mode: 'minor' }
  return { root: (root + 3) % 12, mode: 'major' }
}

export function sameKey(a: Truth, b: Truth) {
  return a.root === b.root && a.mode === b.mode
}

function argmaxBin(chroma: number[]) {
  let best = 0
  let peak = -Infinity
  for (let i = 0; i < chroma.length; i++) {
    if (chroma[i] > peak) {
      peak = chroma[i]
      best = i
    }
  }
  return (9 + best) % 12
}

function corrOf(ranked: Ranked[], key: Truth) {
  return ranked.find((row) => row.root === key.root && row.mode === key.mode)?.corr ?? -1
}

export function guessFromRank(ranked: Ranked[], entropy: number, segmentAgree = 1): Guess {
  const best = ranked[0]
  const runner = ranked[1]
  const margin = (best?.corr ?? 0) - (runner?.corr ?? 0)
  let confidence = Math.max(0, Math.min(1, 0.5 * Math.max(0, Math.min(1, ((best?.corr ?? 0) - 0.15) / 0.55)) + 0.3 * Math.max(0, Math.min(1, margin / 0.12)) + 0.2 * segmentAgree))
  if (entropy > 0.995) confidence *= 0.45
  if (margin < 0.04) confidence *= 0.75
  return {
    root: best?.root ?? 0,
    mode: best?.mode ?? 'major',
    corr: best?.corr ?? 0,
    runner: runner?.corr ?? 0,
    confidence,
  }
}

/** Flip major/relative-minor only when the profile margin is small and the bass tonic disagrees. */
export function applyBass(ranked: Ranked[], bass: number[], segments: number[][], entropy: number): Guess {
  const best = ranked[0]
  if (!best) return guessFromRank(ranked, entropy)
  const relative = relativeOf(best.root, best.mode)
  const margin = best.corr - corrOf(ranked, relative)
  const bassRoot = argmaxBin(bass)
  const bassAt = (root: number) => {
    const bin = (root - 9 + 12) % 12
    return bass[bin] || 0
  }
  let chosen = best
  const bassPrefersRelative = bassAt(relative.root) > bassAt(best.root) * 1.4 && bassAt(relative.root) > 0
  const start = rankProfile(segments[0] ?? [], EDMA_ESSENTIA.major, EDMA_ESSENTIA.minor)[0]
  const end = rankProfile(segments[3] ?? segments[segments.length - 1] ?? [], EDMA_ESSENTIA.major, EDMA_ESSENTIA.minor)[0]
  const cadenceAgrees = Boolean(start && end && sameKey(start, relative) && sameKey(end, relative))
  if ((margin < 0.05 && bassPrefersRelative) || (margin < 0.08 && bassPrefersRelative && cadenceAgrees) || (margin < 0.04 && cadenceAgrees && bassRoot === relative.root)) {
    chosen = ranked.find((row) => sameKey(row, relative)) ?? { ...relative, corr: corrOf(ranked, relative) }
  }
  const rest = ranked.filter((row) => !sameKey(row, chosen))
  const segmentAgree = [start, end].filter((row) => row && sameKey(row, chosen)).length / 2
  return guessFromRank([chosen, rest[0] ?? chosen], entropy, segmentAgree)
}

export function applyVote(pcp: number[], segments: number[][], entropy: number, id: ProfileId = 'edma-essentia', learned?: { major: number[]; minor: number[] }): Guess {
  const global = rankNamed(pcp, id, learned)
  const weights = new Map<string, number>()
  const add = (row: Ranked | undefined, weight: number) => {
    if (!row || row.corr < 0.2 || weight <= 0) return
    const key = `${row.root}:${row.mode}`
    weights.set(key, (weights.get(key) ?? 0) + weight)
  }
  add(global[0], 1.4 * Math.max(0, global[0]?.corr ?? 0))
  for (const segment of segments) add(rankNamed(segment, id, learned)[0], 1)
  let winner = global[0]
  let best = -1
  for (const [key, weight] of weights) {
    if (weight > best) {
      best = weight
      const [root, mode] = key.split(':')
      const found = global.find((row) => row.root === Number(root) && row.mode === mode)
      winner = found ?? { root: Number(root), mode: mode as Mode, corr: global[0]?.corr ?? 0 }
    }
  }
  const rest = global.filter((row) => !winner || row.root !== winner.root || row.mode !== winner.mode)
  return guessFromRank([winner ?? global[0], rest[0] ?? global[0]], entropy, 1)
}

export function learnProfile(rows: { pcp: number[]; truth: Truth }[]) {
  const major = new Array<number>(12).fill(0)
  const minor = new Array<number>(12).fill(0)
  let majorN = 0
  let minorN = 0
  for (const row of rows) {
    const shift = (row.truth.root - 9 + 12) % 12
    const dest = row.truth.mode === 'major' ? major : minor
    for (let i = 0; i < 12; i++) dest[i] += row.pcp[(i + shift) % 12]
    if (row.truth.mode === 'major') majorN++
    else minorN++
  }
  const norm = (values: number[], n: number) => {
    const mean = values.map((value) => (n ? value / n : 0))
    const max = Math.max(...mean, 1e-8)
    return mean.map((value) => value / max)
  }
  return { major: norm(major, majorN), minor: norm(minor, minorN), majorN, minorN }
}

export function rotateChroma(pcp: number[], semitones: number) {
  const out = new Array<number>(12)
  for (let i = 0; i < 12; i++) out[i] = pcp[(i - semitones + 120) % 12]
  return out
}

export function selfCheckScores() {
  const c = { root: 0, mode: 'major' as const }
  const checks: [string, number][] = [
    ['exact', verdict(c, c).mirex],
    ['relative', verdict(c, { root: 9, mode: 'minor' }).mirex],
    ['parallel', verdict(c, { root: 0, mode: 'minor' }).mirex],
    ['fifth', verdict(c, { root: 7, mode: 'major' }).mirex],
    ['other', verdict(c, { root: 1, mode: 'major' }).mirex],
    ['unsure', verdict(c, null).mirex],
  ]
  for (const [name, score] of checks) {
    const want = name === 'exact' ? 1 : name === 'relative' ? 0.3 : name === 'parallel' ? 0.2 : name === 'fifth' ? 0.5 : 0
    if (Math.abs(score - want) > 1e-9) throw new Error(`score ${name} ${score}`)
  }
}

export const PROFILE_IDS: ProfileId[] = ['edma-essentia', 'faraldo', 'temperley', 'krumhansl', 'shaath', 'blend']

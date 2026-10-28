import type { AnalysisSection, SectionKind } from './types'

export interface BarActivity {
  /** L2-friendly texture: chroma (12) plus energy, density, and how many tracks play. */
  chroma: Float32Array
  energy: number
  density: number
  active: number
  /** Signature of which tracks sound in this bar. */
  mask: string
}

function cosine(a: Float32Array, b: Float32Array) {
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += a[i] * b[i]
    da += a[i] * a[i]
    db += b[i] * b[i]
  }
  if (da === 0 || db === 0) return 0
  return num / Math.sqrt(da * db)
}

function vector(bar: BarActivity, maxEnergy: number, maxDensity: number, maxActive: number) {
  const v = new Float32Array(15)
  let sum = 0
  for (let i = 0; i < 12; i++) sum += bar.chroma[i]
  for (let i = 0; i < 12; i++) v[i] = sum > 0 ? bar.chroma[i] / sum : 0
  v[12] = maxEnergy > 0 ? (bar.energy / maxEnergy) * 1.6 : 0
  v[13] = maxDensity > 0 ? (bar.density / maxDensity) * 1.4 : 0
  v[14] = maxActive > 0 ? (bar.active / maxActive) * 1.8 : 0
  return v
}

function meanVector(bars: Float32Array[], start: number, end: number) {
  const out = new Float32Array(bars[0]?.length ?? 15)
  const count = Math.max(1, end - start)
  for (let i = start; i < end; i++) {
    const row = bars[i]
    if (!row) continue
    for (let k = 0; k < out.length; k++) out[k] += row[k]
  }
  for (let k = 0; k < out.length; k++) out[k] /= count
  return out
}

function noveltyCuts(rows: Float32Array[], minGap: number, thresholdScale: number) {
  const n = rows.length
  const cuts: number[] = []
  if (n < 4) return cuts
  const width = Math.min(4, Math.max(1, Math.floor(n / 6)))
  const novelty = new Array<number>(n).fill(0)
  for (let i = 1; i < n; i++) {
    const left = meanVector(rows, Math.max(0, i - width), i)
    const right = meanVector(rows, i, Math.min(n, i + width))
    novelty[i] = 1 - cosine(left, right)
  }
  let mean = 0
  for (const value of novelty) mean += value
  mean /= n
  let variance = 0
  for (const value of novelty) variance += (value - mean) ** 2
  const std = Math.sqrt(variance / n)
  const threshold = Math.max(0.18, mean + thresholdScale * std)
  let last = 0
  for (let i = minGap; i < n - 1; i++) {
    if (i - last < minGap) continue
    if (novelty[i] >= threshold && novelty[i] >= novelty[i - 1] && novelty[i] >= (novelty[i + 1] ?? 0)) {
      cuts.push(i)
      last = i
    }
  }
  return cuts
}

/** Cuts where the set of sounding tracks changes and stays changed. */
export function arrangementCuts(masks: string[], minGap = 2) {
  const cuts: number[] = []
  let last = 0
  let current = masks[0] ?? ''
  for (let i = 1; i < masks.length; i++) {
    if (masks[i] === current) continue
    if (i - last >= minGap) {
      cuts.push(i)
      last = i
    }
    current = masks[i]
  }
  return cuts
}

interface Span {
  start: number
  end: number
  feature: Float32Array
  energy: number
  mask: string
}

function labelSpans(spans: Span[]): { kind: SectionKind; label: string }[] {
  if (!spans.length) return []
  if (spans.length === 1) return [{ kind: 'section', label: 'Section' }]
  const features = spans.map((span) => span.feature)
  const cluster = spans.map(() => -1)
  let next = 0
  for (let i = 0; i < spans.length; i++) {
    if (cluster[i] >= 0) continue
    cluster[i] = next
    for (let j = i + 1; j < spans.length; j++) {
      const sameBand = spans[i].mask === spans[j].mask
      if (sameBand && cosine(features[i], features[j]) >= 0.84) cluster[j] = next
    }
    next++
  }
  const groups = new Map<number, { energy: number; count: number }>()
  cluster.forEach((id, index) => {
    const group = groups.get(id) ?? { energy: 0, count: 0 }
    group.energy += spans[index].energy
    group.count += 1
    groups.set(id, group)
  })
  let chorus = -1
  let chorusEnergy = -1
  for (const [id, group] of groups) {
    if (group.count < 2) continue
    const avg = group.energy / group.count
    if (avg > chorusEnergy) {
      chorusEnergy = avg
      chorus = id
    }
  }
  let maxEnergy = 0
  let maxIndex = 0
  spans.forEach((span, index) => {
    if (span.energy > maxEnergy) {
      maxEnergy = span.energy
      maxIndex = index
    }
  })
  if (chorus >= 0 && chorusEnergy < maxEnergy * 0.72) chorus = -1
  if (chorus < 0 && maxEnergy > 0) {
    const quieter = spans.reduce((sum, span) => sum + span.energy, 0) / spans.length
    if (spans[maxIndex].energy >= quieter * 1.18) chorus = cluster[maxIndex]
  }
  if (chorus >= 0) chorusEnergy = spans.filter((_, index) => cluster[index] === chorus).reduce((sum, span) => sum + span.energy, 0) / Math.max(1, cluster.filter((id) => id === chorus).length)

  const kinds: SectionKind[] = spans.map((span, index) => {
    if (chorus >= 0 && cluster[index] === chorus) return 'chorus'
    if (index === 0 && span.energy <= maxEnergy * 0.92) return 'intro'
    if (index === spans.length - 1 && span.energy <= Math.max(chorusEnergy, maxEnergy) * 0.9) return 'outro'
    return 'verse'
  })
  for (let i = 1; i < kinds.length - 1; i++) {
    if (kinds[i] !== 'verse') continue
    const between = kinds[i - 1] === 'chorus' && kinds[i + 1] === 'chorus'
    const unique = cluster.filter((id) => id === cluster[i]).length === 1
    if (between && unique) kinds[i] = 'bridge'
    else if (unique && spans[i].energy < maxEnergy * 0.55 && kinds[i - 1] === 'chorus') kinds[i] = 'breakdown'
  }
  const counts: Record<string, number> = {}
  return kinds.map((kind) => {
    counts[kind] = (counts[kind] ?? 0) + 1
    const title = kind.charAt(0).toUpperCase() + kind.slice(1)
    const label = kind === 'intro' || kind === 'outro' || kind === 'bridge' || kind === 'breakdown' || counts[kind] === 1 ? title : `${title} ${counts[kind]}`
    if ((kind === 'verse' || kind === 'chorus') && counts[kind] === 1) return { kind, label: title }
    return { kind, label }
  })
}

function majorityMask(bars: BarActivity[], start: number, end: number) {
  const counts = new Map<string, number>()
  for (let i = start; i < end; i++) {
    const mask = bars[i]?.mask ?? ''
    counts.set(mask, (counts.get(mask) ?? 0) + 1)
  }
  let best = bars[start]?.mask ?? ''
  let count = 0
  for (const [mask, hits] of counts) {
    if (hits > count) {
      count = hits
      best = mask
    }
  }
  return best
}

/** Group bars into intro, verse, chorus, bridge, and outro. */
export function sectionsFromBars(bars: BarActivity[], beatsPerBar: number): AnalysisSection[] {
  if (!bars.length) return []
  let maxEnergy = 0
  let maxDensity = 0
  let maxActive = 0
  for (const bar of bars) {
    maxEnergy = Math.max(maxEnergy, bar.energy)
    maxDensity = Math.max(maxDensity, bar.density)
    maxActive = Math.max(maxActive, bar.active)
  }
  const rows = bars.map((bar) => vector(bar, maxEnergy, maxDensity, maxActive))
  const cuts = new Set<number>([0])
  for (const cut of arrangementCuts(bars.map((bar) => bar.mask))) cuts.add(cut)
  for (const cut of noveltyCuts(rows, 4, 0.45)) cuts.add(cut)
  const ordered = [...cuts].filter((cut) => cut >= 0 && cut < bars.length).sort((a, b) => a - b)
  const bounds = [...ordered, bars.length]
  const spans: Span[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]
    const end = bounds[i + 1]
    if (end <= start) continue
    let energy = 0
    for (let bar = start; bar < end; bar++) energy += bars[bar].energy
    spans.push({ start, end, feature: meanVector(rows, start, end), energy: energy / (end - start), mask: majorityMask(bars, start, end) })
  }
  const labels = labelSpans(spans)
  return spans.map((span, index) => ({
    kind: labels[index].kind,
    label: labels[index].label,
    startBar: span.start,
    endBar: span.end,
    startBeat: span.start * beatsPerBar,
    endBeat: span.end * beatsPerBar,
  }))
}

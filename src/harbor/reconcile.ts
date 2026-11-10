import { libraryFileUrl } from '../audio/multisample/source'
import type { SamplerProgram } from '../audio/multisample/types'
import { clampMidi } from '../audio/multisample/types'
import { instrumentLibraryBase } from './contract'
import { parseSamplePath } from './names'

const AUDIO = /\.(wav|flac|aif|aiff)$/i

interface SampleLoc {
  path: string
  dir: string
  base: string
  root: number | null
  layer: number | null
  release: boolean
}

/** Dataset path after `/resolve/<revision>/`, with each segment decoded once. */
export function datasetFilePath(url: string) {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return ''
  }
  const parts = parsed.pathname.split('/').filter(Boolean).map(decodeSegment)
  const resolveAt = parts.indexOf('resolve')
  if (resolveAt < 0 || parts.length <= resolveAt + 2) return ''
  return parts.slice(resolveAt + 2).join('/')
}

/**
 * Point every zone at a file the dataset listing actually contains.
 * A missing velocity uses the other layer of the same note. A missing note uses the
 * nearest listed sample, preferring the same pitch so the key center stays in tune.
 * Zones with no listed sample at all are dropped. Callers still spread the survivors
 * across the keyboard.
 */
export function reconcileProgram(program: SamplerProgram, existing: Iterable<string>, base = instrumentLibraryBase()): SamplerProgram {
  const audio = [...existing].filter((path) => AUDIO.test(path))
  if (!audio.length) return program
  const have = new Set(audio)
  const located = audio.map(locate)
  const replacement = new Map<string, string>()
  const samples = program.samples.map((sample) => {
    if (!sample.url) return sample
    const path = datasetFilePath(sample.url)
    if (!path || have.has(path)) return sample
    let next = replacement.get(path)
    if (next === undefined) {
      next = nearestSample(locate(path), located)?.path ?? ''
      replacement.set(path, next)
    }
    if (!next) return { ...sample, url: '' }
    return { ...sample, url: libraryFileUrl(base, next) }
  })
  const previous = new Map(program.samples.map((sample) => [sample.id, sample]))
  const byId = new Map(samples.map((sample) => [sample.id, sample]))
  const tuned = program.zones.flatMap((zone) => {
    const sample = byId.get(zone.sampleId)
    if (!sample?.url) return []
    const before = previous.get(zone.sampleId)
    const from = before?.url ? locate(datasetFilePath(before.url)) : null
    const to = locate(datasetFilePath(sample.url))
    if (from?.root == null || to.root == null || from.root === to.root) return [zone]
    return [{ ...zone, root: clampMidi(zone.root + (to.root - from.root)) }]
  })
  const byUrl = new Map<string, string>()
  for (const sample of samples) {
    if (!sample.url || byUrl.has(sample.url)) continue
    byUrl.set(sample.url, sample.id)
  }
  const zones = tuned.map((zone) => {
    const sample = byId.get(zone.sampleId)
    const id = sample?.url ? byUrl.get(sample.url) : undefined
    return id && id !== zone.sampleId ? { ...zone, sampleId: id } : zone
  })
  const used = new Set(zones.map((zone) => zone.sampleId))
  return {
    ...program,
    zones,
    samples: samples.filter((sample) => sample.url && used.has(sample.id)),
  }
}

function nearestSample(want: SampleLoc, available: SampleLoc[]) {
  let best: SampleLoc | null = null
  let bestScore: number[] | null = null
  for (const have of available) {
    const score = [
      want.release === have.release ? 0 : 1,
      pitchDistance(want.root, have.root),
      want.dir === have.dir ? 0 : 1,
      layerDistance(want.layer, have.layer),
      want.base.toLowerCase() === have.base.toLowerCase() ? 0 : 1,
      dirDistance(want.dir, have.dir),
    ]
    if (!best || !bestScore || lower(score, have.path, bestScore, best.path)) {
      best = have
      bestScore = score
    }
  }
  return best
}

function locate(path: string): SampleLoc {
  const parsed = parseSamplePath(path)
  const parts = path.split('/')
  return {
    path,
    dir: parts.slice(0, -1).join('/'),
    base: parts[parts.length - 1] ?? path,
    root: parsed.root ?? null,
    layer: parsed.layer ?? null,
    release: parsed.release,
  }
}

function pitchDistance(want: number | null, have: number | null) {
  if (want == null || have == null) return 64
  return Math.abs(want - have)
}

function layerDistance(want: number | null, have: number | null) {
  if (want == null || have == null) return want === have ? 0 : 1
  return Math.abs(want - have)
}

function dirDistance(want: string, have: string) {
  if (want === have) return 0
  const left = want.split('/')
  const right = have.split('/')
  let shared = 0
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) shared += 1
  return (left.length - shared) + (right.length - shared)
}

function lower(score: number[], path: string, bestScore: number[], bestPath: string) {
  for (let index = 0; index < score.length; index += 1) {
    if (score[index] === bestScore[index]) continue
    return score[index] < bestScore[index]
  }
  return path < bestPath
}

function decodeSegment(segment: string) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

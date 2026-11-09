import type { CatalogInstrument, HarborEntry } from './types'

const PITCH: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
const DYNAMIC: Record<string, [number, number]> = {
  pp: [1, 31],
  p: [32, 52],
  mp: [53, 73],
  mf: [74, 94],
  f: [95, 114],
  ff: [115, 127],
}

export function noteMidi(name: string, octave: number) {
  const match = name.trim().toLowerCase().match(/^([a-g])([#b]|sharp|flat)?$/)
  if (!match || !Number.isFinite(octave)) return null
  let pc = PITCH[match[1]]
  const acc = match[2] || ''
  if (acc === '#' || acc === 'sharp') pc += 1
  if (acc === 'b' || acc === 'flat') pc -= 1
  const midi = (Math.round(octave) + 1) * 12 + pc
  if (midi < 0 || midi > 127) return null
  return midi
}

export interface ParsedSample {
  path: string
  root?: number
  layer?: number
  dynamic?: string
  roundRobin: number
  release: boolean
  articulation: string
}

const SKIP_FOLDER = new Set(['samples', 'sample', 'programs', 'instruments', 'mappings', 'modules'])

export function parseSamplePath(path: string, fallbackOctave = 3): ParsedSample {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const file = parts[parts.length - 1]?.replace(/\.[^.]+$/, '') ?? ''
  const release = parts.some((part) => /^(rel|releases?)$/i.test(part)) || /release/i.test(file)
  const rr = file.match(/rr(\d+)/i)?.[1] ?? file.match(/-(\d+)$/)?.[1]
  const layer = file.match(/vl(\d+)/i)?.[1] ?? file.match(/(?:^|_)v(\d+)(?!\d)/i)?.[1]
  const dynamic = file.match(/(?:^|_)(ff|pp|mf|mp|f|p)(?:_|$)/i)?.[1]?.toLowerCase()
  let root: number | undefined
  const numbered = file.match(/(?:^|_)(\d{3})(?:_|$)/)
  if (numbered) {
    const midi = Number(numbered[1])
    if (midi >= 0 && midi <= 127) root = midi
  }
  if (root == null) {
    const named = file.match(/(?:^|_)([a-g](?:#|b|sharp|flat)?)(-?\d)(?!\d)/i)
    if (named) root = noteMidi(named[1], Number(named[2])) ?? undefined
    else {
      const bare = file.match(/(?:^|_)([a-g](?:#|b)?)(?:_|$)/i)
      if (bare) root = noteMidi(bare[1], fallbackOctave) ?? undefined
    }
  }
  let articulation = 'Sustain'
  for (let i = parts.length - 2; i >= 0; i--) {
    if (!SKIP_FOLDER.has(parts[i].toLowerCase())) {
      articulation = parts[i]
      break
    }
  }
  return {
    path,
    root,
    layer: layer ? Number(layer) : undefined,
    dynamic,
    roundRobin: rr ? Math.max(1, Number(rr)) : 1,
    release,
    articulation,
  }
}

function layerBands(max: number) {
  const bands: [number, number][] = []
  for (let i = 1; i <= max; i++) {
    const lo = i === 1 ? 1 : Math.floor(((i - 1) * 127) / max) + 1
    const hi = i === max ? 127 : Math.floor((i * 127) / max)
    bands.push([lo, hi])
  }
  return bands
}

/** Audio paths inside one instrument become zone rows. Octave-less bass notes sit at octave 2. */
export function zonesFromPaths(instrument: Pick<CatalogInstrument, 'id' | 'name' | 'license' | 'source' | 'category'>, paths: string[]): HarborEntry[] {
  const octave = instrument.category === 'bass' ? 2 : 3
  const parsed = paths
    .filter((path) => /\.(wav|flac|aif|aiff)$/i.test(path))
    .map((path) => parseSamplePath(path, octave))
    .filter((item) => item.root != null)
  const byArticulation = new Map<string, ParsedSample[]>()
  for (const item of parsed) {
    const list = byArticulation.get(item.articulation) ?? []
    list.push(item)
    byArticulation.set(item.articulation, list)
  }
  const rows: HarborEntry[] = []
  for (const [articulation, items] of byArticulation) {
    const maxLayer = Math.max(0, ...items.map((item) => item.layer ?? 0))
    const bands = maxLayer > 1 ? layerBands(maxLayer) : null
    for (const item of items) {
      let velLo = 1
      let velHi = 127
      if (bands && item.layer) {
        const band = bands[Math.min(bands.length, item.layer) - 1]
        if (band) [velLo, velHi] = band
      } else if (!bands && item.dynamic && DYNAMIC[item.dynamic]) {
        [velLo, velHi] = DYNAMIC[item.dynamic]
      }
      rows.push({
        id: `${instrument.id}:${item.path}`,
        path: item.path,
        name: item.path.split('/').pop() ?? item.path,
        type: 'instrument',
        tags: [],
        durationSec: 0,
        sampleRate: 48000,
        license: instrument.license,
        source: instrument.source ?? '',
        instrument: instrument.name,
        articulation,
        root: item.root,
        velLo,
        velHi,
        roundRobin: item.roundRobin,
        release: item.release,
      })
    }
  }
  return rows
}
import type { HarborEntry } from './types'
import type { SamplerProgram, SampleZone } from '../audio/multisample/types'

export interface KeySpan {
  lokey: number
  hikey: number
}

/**
 * Spread sampled roots across the keyboard.
 * Each root owns the notes closer to it than to the next sampled root.
 * Unsampled keys play the nearest root, pitched.
 */
export function mapKeyRanges(roots: number[]): Map<number, KeySpan> {
  const unique = [...new Set(roots.map((root) => Math.max(0, Math.min(127, Math.round(root)))).filter((root) => Number.isFinite(root)))].sort((a, b) => a - b)
  const spans = new Map<number, KeySpan>()
  unique.forEach((root, index) => {
    const prev = unique[index - 1]
    const next = unique[index + 1]
    const lokey = prev == null ? 0 : Math.floor((prev + root) / 2) + 1
    const hikey = next == null ? 127 : Math.floor((root + next) / 2)
    spans.set(root, { lokey: Math.min(lokey, root), hikey: Math.max(hikey, root) })
  })
  return spans
}

export interface BuiltZone {
  entry: HarborEntry
  lokey: number
  hikey: number
  lovel: number
  hivel: number
  seq: number
  seqLength: number
  rrGroup: number
  articulation: string
  release: boolean
}

function clampVel(value: number | undefined, fallback: number) {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(127, Math.round(value)))
}

function groupId(text: string) {
  let hash = 2166136261
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % 100000 + 1
}

/**
 * Zones for one instrument.
 * Velocity bands stay separate. Round-robins share a key and a velocity, and cycle.
 * Release rows keep the key span of the same root.
 */
export function buildZones(entries: HarborEntry[]): BuiltZone[] {
  const playable = entries.filter((entry) => entry.type === 'instrument' && entry.root != null && !entry.release)
  const releases = entries.filter((entry) => entry.type === 'instrument' && entry.root != null && entry.release)
  const byArticulation = new Map<string, HarborEntry[]>()
  for (const entry of playable) {
    const articulation = entry.articulation || 'Sustain'
    const list = byArticulation.get(articulation) ?? []
    list.push(entry)
    byArticulation.set(articulation, list)
  }
  const built: BuiltZone[] = []
  for (const [articulation, rows] of byArticulation) {
    const explicit = rows.some((row) => row.velLo != null || row.velHi != null)
    const bands = new Map<string, { lo: number; hi: number; rows: HarborEntry[] }>()
    const open = rows.filter((row) => row.velLo == null && row.velHi == null)
    const declared = explicit ? rows.filter((row) => row.velLo != null || row.velHi != null) : rows
    for (const row of declared) {
      const lo = explicit ? clampVel(row.velLo, 1) : 1
      const hi = explicit ? clampVel(row.velHi, 127) : 127
      const key = `${Math.min(lo, hi)}-${Math.max(lo, hi)}`
      const band = bands.get(key) ?? { lo: Math.min(lo, hi), hi: Math.max(lo, hi), rows: [] }
      band.rows.push(row)
      bands.set(key, band)
    }
    if (explicit) {
      for (const row of open) {
        for (const band of bands.values()) band.rows.push(row)
      }
    }
    for (const band of bands.values()) {
      const { lovel, hivel } = { lovel: band.lo, hivel: band.hi }
      const bandRows = band.rows
      const spans = mapKeyRanges(bandRows.map((row) => row.root ?? 60))
      const atRoot = new Map<number, HarborEntry[]>()
      for (const row of bandRows) {
        const root = Math.max(0, Math.min(127, Math.round(row.root ?? 60)))
        const list = atRoot.get(root) ?? []
        list.push(row)
        atRoot.set(root, list)
      }
      for (const [root, group] of atRoot) {
        const span = spans.get(root) ?? { lokey: 0, hikey: 127 }
        const ordered = group.slice().sort((a, b) => (a.roundRobin ?? 1) - (b.roundRobin ?? 1) || a.id.localeCompare(b.id))
        const seqs = ordered.map((row, index) => row.roundRobin && row.roundRobin > 0 ? row.roundRobin : index + 1)
        const uniqueSeq = [...new Set(seqs)]
        const cycling = uniqueSeq.length > 1
        ordered.forEach((row, index) => {
          built.push({
            entry: row,
            lokey: span.lokey,
            hikey: span.hikey,
            lovel,
            hivel,
            seq: seqs[index],
            seqLength: uniqueSeq.length,
            rrGroup: cycling ? groupId(`${row.instrument ?? row.name}|${articulation}|${lovel}|${hivel}`) : 0,
            articulation,
            release: false,
          })
        })
      }
    }
  }
  const primary = [...byArticulation.keys()][0] || 'Sustain'
  for (const row of releases) {
    const articulation = row.articulation || primary
    const peers = byArticulation.get(articulation) ?? byArticulation.get(primary) ?? []
    const spans = mapKeyRanges(peers.map((peer) => peer.root ?? 60))
    const root = Math.max(0, Math.min(127, Math.round(row.root ?? 60)))
    const span = spans.get(root) ?? { lokey: root, hikey: root }
    built.push({
      entry: row,
      lokey: span.lokey,
      hikey: span.hikey,
      lovel: 1,
      hivel: 127,
      seq: 1,
      seqLength: 1,
      rrGroup: 0,
      articulation,
      release: true,
    })
  }
  return built
}

/**
 * Nearest sampled root owns every key, including the notes past the lowest and highest sample.
 * Velocity layers and round-robins keep their own samples and share that key map.
 */
export function fillKeyboard(program: SamplerProgram, lo = 0, hi = 127): SamplerProgram {
  const floor = Math.max(0, Math.min(127, lo))
  const ceil = Math.max(floor, Math.min(127, hi))
  const groups = new Map<string, SampleZone[]>()
  for (const zone of program.zones) {
    const key = `${zone.trigger}|${zone.swLast ?? ''}|${zone.lovel}|${zone.hivel}|${zone.mic}`
    const list = groups.get(key) ?? []
    list.push(zone)
    groups.set(key, list)
  }
  const zones = program.zones.map((zone) => ({ ...zone }))
  const byId = new Map(zones.map((zone) => [zone.id, zone]))
  for (const list of groups.values()) {
    const spans = mapKeyRanges(list.map((zone) => zone.root))
    for (const zone of list) {
      const span = spans.get(Math.max(0, Math.min(127, Math.round(zone.root))))
      const target = byId.get(zone.id)
      if (!span || !target) continue
      target.lokey = Math.max(floor, Math.min(span.lokey, ceil))
      target.hikey = Math.max(target.lokey, Math.min(ceil, span.hikey))
    }
  }
  return { ...program, zones }
}

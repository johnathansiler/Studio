import type { MapQuery, MapResult, MappedLayer, MicPosition, SampleRef, SamplerProgram, SampleZone } from './types'

/**
 * Pick the layers for one note.
 * Key range, velocity, keyswitch, trigger, and round-robin all apply here.
 * Every surviving mic plays; the engine mixes them.
 */
export function selectLayers(program: SamplerProgram, query: MapQuery): MapResult {
  const samples = new Map<string, SampleRef>()
  for (const sample of program.samples) samples.set(sample.id, sample)
  const matched: SampleZone[] = []
  for (const zone of program.zones) {
    if (query.note < zone.lokey || query.note > zone.hikey) continue
    if (!velocityHit(zone, query.velocity)) continue
    if (zone.trigger !== query.trigger) continue
    if (!switchHit(zone, query.keyswitch)) continue
    if (!samples.has(zone.sampleId)) continue
    matched.push(zone)
  }
  const groups = new Map<string, SampleZone[]>()
  for (const zone of matched) {
    const key = zone.rrGroup > 0 ? `g${zone.rrGroup}` : `z${zone.id}`
    const list = groups.get(key)
    if (list) list.push(zone)
    else groups.set(key, [zone])
  }
  const layers: MappedLayer[] = []
  const advance: number[] = []
  for (const list of groups.values()) {
    const seqs = [...new Set(list.map((zone) => zone.seq))].sort((a, b) => a - b)
    const groupId = list[0].rrGroup
    let chosen = list
    if (seqs.length > 1 && groupId > 0) {
      const counter = query.roundRobin[groupId] ?? 0
      const pick = seqs[Math.abs(counter) % seqs.length]
      chosen = list.filter((zone) => zone.seq === pick)
      advance.push(groupId)
    }
    for (const zone of chosen) {
      const sample = samples.get(zone.sampleId)
      if (!sample) continue
      layers.push({
        zone,
        sample,
        mic: micFor(program, zone.mic),
        tuneRatio: tuneRatio(zone, query.note),
      })
    }
  }
  return { layers, advance }
}

export function isKeyswitch(program: SamplerProgram, note: number) {
  return program.keyswitches.some((item) => item.key === note)
}

export function tuneRatio(zone: SampleZone, note: number) {
  const semis = (note - zone.root) * (Number.isFinite(zone.keytrack) ? zone.keytrack : 1) + zone.tuneCents / 100
  return 2 ** (semis / 12)
}

function velocityHit(zone: SampleZone, velocity: number) {
  const lo = zone.lovel <= 0 ? 1 : zone.lovel
  const hi = zone.hivel <= 0 ? 127 : zone.hivel
  return velocity >= lo && velocity <= hi
}

function switchHit(zone: SampleZone, keyswitch: number | null) {
  if (zone.swLast == null && zone.swLo == null && zone.swHi == null) return true
  if (keyswitch == null) return false
  if (zone.swLast != null && zone.swLast !== keyswitch) return false
  if (zone.swLo != null && keyswitch < zone.swLo) return false
  if (zone.swHi != null && keyswitch > zone.swHi) return false
  return true
}

function micFor(program: SamplerProgram, id: string): MicPosition {
  return program.mics.find((mic) => mic.id === id) ?? { id, name: id, gain: 1, pan: 0, mute: false }
}

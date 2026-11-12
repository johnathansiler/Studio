import { libraryFileUrl } from '../audio/multisample/source'
import { makeProgram, makeSample, makeZone, type SampleLicense, type SamplerProgram } from '../audio/multisample/types'
import { instrumentLibraryBase } from './contract'
import { familyFor } from './family'
import { licenseLabel } from './license'
import { buildZones, fillKeyboard } from './zones'
import { zonesFromPaths } from './names'
import type { CatalogInstrument, HarborEntry, InstrumentFamily } from './types'

export interface HarborInstrument {
  id: string
  name: string
  family: InstrumentFamily
  license: string
  label: string
  pack?: string
  source: string
  articulations: string[]
  zones: HarborEntry[]
  program: SamplerProgram
}

export function instrumentSlug(name: string) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return slug || 'instrument'
}

export function programLicense(license: string): SampleLicense {
  const text = license.trim().toLowerCase()
  if (text.startsWith('unlicense')) return 'Unlicense'
  if (text.startsWith('public domain')) return 'public-domain'
  return 'CC0-1.0'
}

export function sampleIdentity(entry: HarborEntry, articulation: string, trigger: 'attack' | 'release') {
  return [
    'harbor',
    instrumentSlug(entry.instrument || entry.name),
    articulation,
    String(entry.root ?? 60),
    String(entry.velLo ?? 1),
    String(entry.velHi ?? 127),
    String(entry.roundRobin ?? 1),
    trigger,
    entry.id,
  ].join(':')
}

export function articulationFromSample(id: string) {
  const parts = id.split(':')
  return parts[0] === 'harbor' ? parts[2] || 'Sustain' : ''
}

export function articulationsIn(program: SamplerProgram) {
  const names = new Set<string>()
  for (const sample of program.samples) {
    const name = articulationFromSample(sample.id)
    if (name) names.add(name)
  }
  return [...names]
}

/** Switch index stored on the zone. It is not a key the player steals from the keyboard. */

export function buildInstrument(name: string, entries: HarborEntry[]): HarborInstrument | null {
  const zones = entries.filter((entry) => entry.type === 'instrument')
  if (!zones.length) return null
  const built = buildZones(zones)
  if (!built.length) return null
  const id = `harbor:${instrumentSlug(name)}`
  const license = zones.find((entry) => entry.license)?.license ?? 'CC0-1.0'
  const labels = [...new Set(zones.map((entry) => licenseLabel(entry.license)).filter(Boolean))]
  const samples = [...new Map(built.map((zone) => {
    const sample = makeSample({
      id: sampleIdentity(zone.entry, zone.articulation, zone.release ? 'release' : 'attack'),
      url: libraryFileUrl(instrumentLibraryBase(), zone.entry.path),
      format: 'wav' as const,
      sampleRate: zone.entry.sampleRate || 48000,
      channels: 1,
      frameOffset: 0,
      frameCount: 0,
    })
    return [sample.id, sample] as const
  })).values()]
  const articulations = [...new Set(built.filter((zone) => !zone.release).map((zone) => zone.articulation))]
  const programZones = built.map((zone) => makeZone({
    id: `zone:${sampleIdentity(zone.entry, zone.articulation, zone.release ? 'release' : 'attack')}:${zone.lovel}-${zone.hivel}`,
    sampleId: sampleIdentity(zone.entry, zone.articulation, zone.release ? 'release' : 'attack'),
    lokey: zone.lokey,
    hikey: zone.hikey,
    lovel: zone.lovel,
    hivel: zone.hivel,
    root: zone.entry.root ?? 60,
    seq: zone.seq,
    seqLength: zone.seqLength,
    rrGroup: zone.rrGroup,
    rrMode: 'cycle',
    swLast: articulations.length > 1 ? Math.max(0, articulations.indexOf(zone.articulation)) : null,
    trigger: zone.release ? 'release' : 'attack',
    loopMode: 'one-shot',
    ampeg: zone.release
      ? { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.35 }
      : { attack: 0.008, hold: 0, decay: 0.18, sustain: 0.82, release: 0.4 },
  }))
  const program = makeProgram({
    id,
    name,
    author: zones.find((entry) => entry.source)?.source ?? '',
    license: programLicense(license),
    defaultSwitch: articulations.length > 1 ? 0 : null,
    keyswitches: [],
    zones: programZones,
    samples,
    voices: 32,
    play: { tune: 0, attack: 0.008, decay: 0.18, sustain: 0.82, release: 0.4, tone: 16000 },
  })
  const filled = fillKeyboard(program)
  return {
    id,
    name,
    family: familyFor(zones[0]),
    license,
    label: labels.join(' · ') || licenseLabel(license),
    pack: zones.find((entry) => entry.pack)?.pack,
    source: zones.find((entry) => entry.source)?.source ?? '',
    articulations,
    zones,
    program: filled,
  }
}

/** A program whose every velocity layer reaches the full keyboard from the given roots. */
export function programFromRoots(id: string, name: string, roots: number[], license: SampleLicense = 'CC0-1.0'): SamplerProgram {
  const entries: HarborEntry[] = roots.map((root) => ({
    id: `${id}-${root}`,
    path: `${id}/${root}.wav`,
    name: `${name} ${root}`,
    type: 'instrument',
    tags: [],
    durationSec: 1,
    sampleRate: 48000,
    license: 'CC0-1.0',
    source: '',
    instrument: name,
    articulation: 'Sustain',
    root,
    release: false,
  }))
  const built = buildInstrument(name, entries)
  if (!built) return makeProgram({ id: `harbor:${id}`, name, license })
  return fillKeyboard({ ...built.program, id: `harbor:${id}`, name, license })
}

export function programFromPaths(instrument: CatalogInstrument, paths: string[]) {
  const rows = zonesFromPaths(instrument, paths)
  const built = buildInstrument(instrument.name, rows)
  if (!built) return null
  return { ...built, id: `harbor:${instrument.id}`, program: fillKeyboard({ ...built.program, id: `harbor:${instrument.id}`, name: instrument.name }) }
}

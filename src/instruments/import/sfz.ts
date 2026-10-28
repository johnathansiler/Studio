import { clampNote, dbToGain, loopFromName, makeZone, triggerFromName } from '../engine/zone'
import type { Articulation, SampleInstrumentDef, SampleZone } from '../engine/types'

export interface SfzParse {
  def: SampleInstrumentDef
  /** sample opcode as written, before files are resolved. */
  paths: string[]
}

function strip(text: string) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((line) => {
      const cut = line.indexOf('//')
      return cut < 0 ? line : line.slice(0, cut)
    })
    .join('\n')
}

function opcodes(line: string): [string, string][] {
  const matches = [...line.matchAll(/([A-Za-z_][\w]*)=/g)]
  const out: [string, string][] = []
  for (let i = 0; i < matches.length; i++) {
    const key = matches[i][1].toLowerCase()
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? matches[i + 1].index ?? line.length : line.length
    out.push([key, line.slice(start, end).trim()])
  }
  return out
}

/** SFZ note number. Middle C is c4 / 60. */
export function sfzNote(value: string) {
  const raw = value.trim().toLowerCase()
  if (/^-?\d+$/.test(raw)) return clampNote(Number(raw))
  const match = raw.match(/^([a-g])([#b]?)(-?\d)$/)
  if (!match) return 60
  const names: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
  let semi = names[match[1]] ?? 0
  if (match[2] === '#') semi += 1
  if (match[2] === 'b') semi -= 1
  return clampNote((Number(match[3]) + 1) * 12 + semi)
}

function num(value: string | undefined, fallback: number) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function apply(zone: SampleZone, bag: Record<string, string>, pathPrefix: string) {
  if (bag.key) {
    const key = sfzNote(bag.key)
    zone.loKey = key
    zone.hiKey = key
    zone.root = key
  }
  if (bag.lokey) zone.loKey = sfzNote(bag.lokey)
  if (bag.hikey) zone.hiKey = sfzNote(bag.hikey)
  if (bag.pitch_keycenter) zone.root = sfzNote(bag.pitch_keycenter)
  if (bag.lovel) zone.loVel = clampNote(Number(bag.lovel))
  if (bag.hivel) zone.hiVel = clampNote(Number(bag.hivel))
  zone.tune += num(bag.tune, 0)
  if (bag.volume) zone.gain *= dbToGain(num(bag.volume, 0))
  if (bag.pan) zone.pan = Math.max(-1, Math.min(1, num(bag.pan, 0) / 100))
  if (bag.offset) zone.start = Math.max(0, Math.round(num(bag.offset, 0)))
  if (bag.end) zone.end = Math.max(0, Math.round(num(bag.end, 0)))
  if (bag.loop_start) zone.loopStart = Math.max(0, Math.round(num(bag.loop_start, 0)))
  if (bag.loop_end) zone.loopEnd = Math.max(0, Math.round(num(bag.loop_end, 0)))
  if (bag.loop_mode) zone.loopMode = loopFromName(bag.loop_mode)
  if (bag.trigger) zone.trigger = triggerFromName(bag.trigger)
  if (bag.seq_position) zone.seqPosition = Math.max(0, Math.round(num(bag.seq_position, 0)))
  if (bag.seq_length) zone.seqLength = Math.max(1, Math.round(num(bag.seq_length, 1)))
  if (bag.group) zone.group = Math.round(num(bag.group, 0))
  if (bag.off_by) zone.offBy = Math.round(num(bag.off_by, 0))
  if (bag.ampeg_attack) zone.attack = Math.max(0, num(bag.ampeg_attack, 0))
  if (bag.ampeg_decay) zone.decay = Math.max(0, num(bag.ampeg_decay, 0))
  if (bag.ampeg_sustain) zone.sustain = Math.max(0, Math.min(1, num(bag.ampeg_sustain, 100) / 100))
  if (bag.ampeg_release) zone.release = Math.max(0, num(bag.ampeg_release, 0))
  if (bag.xfin_lovel && bag.xfin_hivel) zone.velFadeIn = Math.max(0, sfzNote(bag.xfin_hivel) - sfzNote(bag.xfin_lovel))
  if (bag.xfout_lovel && bag.xfout_hivel) zone.velFadeOut = Math.max(0, sfzNote(bag.xfout_hivel) - sfzNote(bag.xfout_lovel))
  const mic = bag.mic || bag.mic_position
  if (mic) zone.mic = mic.trim()
  if (bag.sw_label) zone.articulation = bag.sw_label.trim()
  else if (bag.sw_last) zone.articulation = `sw-${sfzNote(bag.sw_last)}`
  if (bag.sample) zone.sampleId = `${pathPrefix}${bag.sample}`.replace(/\\/g, '/')
}

/** Parse an SFZ file. Sample paths stay relative; the importer pairs them with local files. */
export function parseSfz(text: string, name = 'SFZ'): SfzParse {
  const lines = strip(text).split(/\r?\n/)
  let prefix = ''
  const global: Record<string, string> = {}
  let group: Record<string, string> = {}
  let region: Record<string, string> | null = null
  let scope: 'global' | 'group' | 'region' = 'global'
  const zones: SampleZone[] = []
  const switches = new Map<string, number>()
  let defaultSwitch = ''
  const flush = () => {
    if (!region?.sample && !region?.sw_last && !region?.sw_label) {
      region = null
      return
    }
    const bag = { ...global, ...group, ...region }
    if (!bag.sample) {
      region = null
      return
    }
    const zone = makeZone({ id: `sfz-${zones.length + 1}`, sampleId: '' })
    apply(zone, bag, prefix)
    if (zone.hiKey < zone.loKey) [zone.loKey, zone.hiKey] = [zone.hiKey, zone.loKey]
    if (zone.hiVel < zone.loVel) [zone.loVel, zone.hiVel] = [zone.hiVel, zone.loVel]
    if (bag.sw_last && zone.articulation) switches.set(zone.articulation, sfzNote(bag.sw_last))
    zones.push(zone)
    region = null
  }
  const take = (bag: Record<string, string>, line: string) => {
    for (const [key, value] of opcodes(line)) {
      if (key === 'default_path') prefix = value.endsWith('/') ? value : `${value}/`
      else bag[key] = value
      if (key === 'sw_default') defaultSwitch = /^-?\d+$/.test(value) || /^[a-g][#b]?-?\d$/i.test(value) ? `sw-${sfzNote(value)}` : value
      if (key === 'sw_label' && bag === global) defaultSwitch = defaultSwitch || value
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const header = line.match(/^<([^>]+)>/)
    if (header) {
      const tag = header[1].trim().toLowerCase()
      const rest = line.slice(header[0].length)
      if (tag === 'region') {
        flush()
        region = {}
        scope = 'region'
        take(region, rest)
      } else if (tag === 'group') {
        flush()
        group = {}
        scope = 'group'
        take(group, rest)
      } else if (tag === 'global' || tag === 'control') {
        flush()
        scope = 'global'
        take(global, rest)
      }
      continue
    }
    if (scope === 'region' && region) take(region, line)
    else if (scope === 'group') take(group, line)
    else take(global, line)
  }
  flush()
  const articulations: Articulation[] = []
  const seen = new Set<string>()
  for (const zone of zones) {
    if (!zone.articulation || seen.has(zone.articulation)) continue
    seen.add(zone.articulation)
    const fromName = zone.articulation.startsWith('sw-') ? Number(zone.articulation.slice(3)) : NaN
    const key = switches.get(zone.articulation) ?? fromName
    articulations.push({
      id: zone.articulation,
      name: zone.articulation,
      keyswitch: Number.isFinite(key) ? key : -1,
      description: `Articulation ${zone.articulation}. The matching keyswitch selects it.`,
    })
  }
  const defaultNote = defaultSwitch.startsWith('sw-') ? Number(defaultSwitch.slice(3)) : NaN
  const initial = articulations.find((item) => item.id === defaultSwitch || item.keyswitch === defaultNote)?.id
    ?? (zones.length > 0 && zones.every((zone) => zone.articulation) ? articulations[0]?.id ?? '' : '')
  const mics = [...new Set(zones.map((zone) => zone.mic).filter(Boolean))].map((id) => ({
    id,
    name: id,
    gain: 1,
    description: `Level of the ${id} microphone.`,
  }))
  return {
    def: {
      id: `sfz-${name}`,
      name,
      zones,
      articulations,
      mics,
      defaultArticulation: initial,
      controls: [],
    },
    paths: zones.map((zone) => zone.sampleId),
  }
}

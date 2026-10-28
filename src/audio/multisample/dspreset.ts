import type { MicPosition, SamplerProgram, ZoneTrigger } from './types'
import { clampMidi, makeProgram, makeSample, makeZone, samplerId } from './types'
import { attr, childrenNamed, parseXml, type XmlNode } from './xml'

/** DecentSampler `.dspreset` XML. Velocities of 0–1 are scaled to MIDI 1–127. */
export function importDecentSampler(xml: string, name = 'Decent Sampler'): SamplerProgram {
  const root = parseXml(xml)
  const groups = collectGroups(root)
  const normalized = velocitiesAreUnit(groups)
  const mics = new Map<string, MicPosition>()
  const samples: SamplerProgram['samples'] = []
  const zones: SamplerProgram['zones'] = []
  let rr = 1
  groups.forEach((group, groupIndex) => {
    const seqMode = (attr(group, 'seqMode', 'seqmode') || 'always').toLowerCase()
    const cycling = seqMode === 'round_robin' || seqMode === 'random'
    const sampleNodes = childrenNamed(group, 'sample')
    const seqLength = cycling ? Math.max(1, sampleNodes.length) : 1
    if (cycling) rr += 1
    const groupRr = cycling ? rr : 0
    sampleNodes.forEach((sample, index) => {
      const path = attr(sample, 'path') || ''
      if (!path) return
      const sampleId = samplerId('ds')
      samples.push(makeSample({ id: sampleId, url: path.replace(/\\/g, '/'), format: 'wav' }))
      const rootNote = midi(attr(sample, 'rootNote') ?? attr(group, 'rootNote'), 60)
      const lo = midi(attr(sample, 'loNote') ?? attr(group, 'loNote'), 0)
      const hi = midi(attr(sample, 'hiNote') ?? attr(group, 'hiNote'), 127)
      const mic = attr(sample, 'mic') || attr(group, 'mic') || attr(sample, 'tags') || attr(group, 'tags') || 'main'
      if (!mics.has(mic)) mics.set(mic, { id: mic, name: mic === 'main' ? 'Main' : mic, gain: 1, pan: 0, mute: false })
      const trigger = triggerOf(attr(sample, 'trigger') ?? attr(group, 'trigger'))
      const loop = truthy(attr(sample, 'loopEnabled') ?? attr(group, 'loopEnabled'))
      const seq = integer(attr(sample, 'seqPosition'), index + 1)
      zones.push(makeZone({
        id: `ds_${groupIndex + 1}_${index + 1}`,
        sampleId,
        lokey: Math.min(lo, hi),
        hikey: Math.max(lo, hi),
        lovel: velocity(attr(sample, 'loVel') ?? attr(group, 'loVel'), 0, normalized),
        hivel: velocity(attr(sample, 'hiVel') ?? attr(group, 'hiVel'), 1, normalized),
        root: rootNote,
        tuneCents: number(attr(sample, 'tuning') ?? attr(group, 'tuning'), 0),
        seq: cycling ? seq : 1,
        seqLength,
        rrGroup: groupRr,
        swLast: switched(attr(sample, 'swLast', 'sw_last') ?? attr(group, 'swLast', 'sw_last')),
        swLo: switched(attr(sample, 'swLokey', 'sw_lokey') ?? attr(group, 'swLokey', 'sw_lokey')),
        swHi: switched(attr(sample, 'swHikey', 'sw_hikey') ?? attr(group, 'swHikey', 'sw_hikey')),
        trigger,
        offset: Math.max(0, integer(attr(sample, 'start'), 0)),
        end: Math.max(0, integer(attr(sample, 'end'), 0)),
        loopMode: loop ? 'loop' : 'none',
        loopStart: Math.max(0, integer(attr(sample, 'loopStart'), 0)),
        loopEnd: Math.max(0, integer(attr(sample, 'loopEnd'), 0)),
        gainDb: number(attr(sample, 'volume') ?? attr(group, 'volume'), 0),
        pan: clamp(number(attr(sample, 'pan') ?? attr(group, 'pan'), 0) / 100, -1, 1),
        mic,
      }))
    })
  })
  const switches = new Map<number, string>()
  for (const zone of zones) if (zone.swLast != null) switches.set(zone.swLast, `Key ${zone.swLast}`)
  return makeProgram({
    name: name.replace(/\.dspreset$/i, ''),
    license: 'CC0-1.0',
    defaultSwitch: switches.size ? [...switches.keys()][0] : null,
    keyswitches: [...switches.entries()].map(([key, label]) => ({ key, label, articulation: `sw-${key}` })),
    mics: mics.size ? [...mics.values()] : undefined,
    zones,
    samples,
  })
}

function collectGroups(root: XmlNode) {
  const holder = childrenNamed(root, 'groups')[0] ?? root
  const groups = childrenNamed(holder, 'group')
  if (groups.length) return groups
  const loose = childrenNamed(holder, 'sample')
  if (!loose.length) return []
  return [{ name: 'group', attrs: {}, children: loose, text: '' }]
}

function velocitiesAreUnit(groups: XmlNode[]) {
  let saw = false
  for (const group of groups) {
    const values = [attr(group, 'loVel'), attr(group, 'hiVel')]
    for (const sample of childrenNamed(group, 'sample')) {
      values.push(attr(sample, 'loVel'), attr(sample, 'hiVel'))
    }
    for (const value of values) {
      if (value == null) continue
      saw = true
      if (Number(value) > 1) return false
    }
  }
  return saw
}

function velocity(value: string | undefined, fallback: number, normalized: boolean) {
  const parsed = value == null ? fallback : Number(value)
  const safe = Number.isFinite(parsed) ? parsed : fallback
  if (!normalized) return Math.max(1, Math.min(127, Math.round(safe || 1)))
  if (safe <= 0) return 1
  return Math.max(1, Math.min(127, Math.round(safe * 127)))
}

function triggerOf(value: string | undefined): ZoneTrigger {
  return value === 'release' || value === 'release_key' ? 'release' : 'attack'
}

function switched(value: string | undefined) {
  if (value == null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  return clampMidi(parsed)
}

function midi(value: string | undefined, fallback: number) {
  if (value == null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? clampMidi(parsed) : fallback
}

function number(value: string | undefined, fallback: number) {
  if (value == null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integer(value: string | undefined, fallback: number) {
  return Math.max(0, Math.round(number(value, fallback)))
}

function truthy(value: string | undefined) {
  return value === '1' || value === 'true' || value === 'yes'
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

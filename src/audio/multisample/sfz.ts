import type { Keyswitch, LoopMode, MicPosition, SamplerProgram, ZoneTrigger } from './types'
import { clampMidi, emptyAmpeg, makeProgram, makeSample, makeZone, samplerId } from './types'

export interface SfzFile {
  name: string
  text: string
}

/**
 * SFZ text → a sampler program.
 * `files` supplies `#include` targets and is otherwise unused (samples stay paths).
 */
export function importSfz(text: string, name = 'SFZ', files?: Map<string, string | ArrayBuffer>): SamplerProgram {
  const source = preprocess(stripBom(text), files, 0)
  const defines = new Map<string, string>()
  let defaultPath = ''
  const global: Record<string, string> = {}
  let group: Record<string, string> = {}
  let groupIndex = 0
  const regions: { opcodes: Record<string, string>; groupIndex: number }[] = []
  const labels = new Map<number, string>()
  let swDefault: number | null = null
  let pending: Record<string, string> | null = null
  let section: 'none' | 'control' | 'global' | 'group' | 'region' = 'none'

  const flush = () => {
    if (section === 'region' && pending) regions.push({ opcodes: pending, groupIndex })
    pending = null
  }

  for (const rawLine of source.split(/\r?\n/)) {
    const defined = substitute(stripComment(rawLine).trim(), defines)
    if (!defined) continue
    const directive = defined.match(/^#define\s+(\$\w+)\s+(.+)$/i)
    if (directive) {
      defines.set(directive[1], directive[2].trim())
      continue
    }
    if (/^#include\b/i.test(defined)) continue
    const header = defined.match(/^<([^>]+)>/i)
    let rest = defined
    if (header) {
      flush()
      const kind = header[1].trim().toLowerCase()
      rest = defined.slice(header[0].length).trim()
      if (kind === 'control') section = 'control'
      else if (kind === 'global') {
        section = 'global'
        for (const key of Object.keys(global)) delete global[key]
      } else if (kind === 'group') {
        section = 'group'
        groupIndex += 1
        group = {}
      } else if (kind === 'region') {
        section = 'region'
        pending = { ...global, ...group }
      } else section = 'none'
    }
    if (!rest) continue
    for (const [key, value] of opcodes(rest)) {
      if (key === 'sw_default') {
        const note = parseNote(value)
        if (note != null) swDefault = note
      }
      if (section === 'control') {
        if (key === 'default_path') defaultPath = value.replace(/\\/g, '/')
        continue
      }
      if (section === 'global') global[key] = value
      else if (section === 'group') group[key] = value
      else if (section === 'region' && pending) pending[key] = value
      if (key === 'sw_label' || key === 'sw_last') {
        const switched = key === 'sw_last' ? value : pending?.sw_last ?? group.sw_last ?? global.sw_last
        const label = key === 'sw_label' ? value : pending?.sw_label ?? group.sw_label ?? global.sw_label
        const note = switched != null ? parseNote(switched) : null
        if (note != null && label) labels.set(note, label)
      }
    }
  }
  flush()

  const mics = new Map<string, MicPosition>()
  const samples: SamplerProgram['samples'] = []
  const zones: SamplerProgram['zones'] = []
  const seenSample = new Map<string, string>()
  regions.forEach((region, index) => {
    const samplePath = region.opcodes.sample
    if (!samplePath) return
    const path = joinPath(defaultPath, samplePath)
    let sampleId = seenSample.get(path)
    if (!sampleId) {
      sampleId = samplerId('sfz')
      seenSample.set(path, sampleId)
      samples.push(makeSample({ id: sampleId, url: path, format: 'wav' }))
    }
    const key = region.opcodes.key
    const lokey = parseNote(region.opcodes.lokey ?? key ?? '0') ?? 0
    const hikey = parseNote(region.opcodes.hikey ?? key ?? '127') ?? 127
    const root = parseNote(region.opcodes.pitch_keycenter ?? region.opcodes.root ?? key ?? String(Math.round((lokey + hikey) / 2))) ?? 60
    const mic = region.opcodes.mic || (Number.isNaN(Number(region.opcodes.output)) ? region.opcodes.output : '') || 'main'
    if (!mics.has(mic)) mics.set(mic, { id: mic, name: mic === 'main' ? 'Main' : mic, gain: 1, pan: 0, mute: false })
    const seqLength = Math.max(1, integer(region.opcodes.seq_length, 1))
    const seq = Math.max(1, integer(region.opcodes.seq_position, 1))
    const sw = region.opcodes.sw_last != null ? parseNote(region.opcodes.sw_last) : null
    if (sw != null && !labels.has(sw)) labels.set(sw, `Key ${sw}`)
    const trigger: ZoneTrigger = region.opcodes.trigger === 'release' || region.opcodes.trigger === 'release_key' ? 'release' : 'attack'
    zones.push(makeZone({
      id: `sfz_${index + 1}`,
      sampleId,
      lokey,
      hikey,
      lovel: Math.max(1, integer(region.opcodes.lovel, 1)),
      hivel: integer(region.opcodes.hivel, 127),
      root,
      tuneCents: number(region.opcodes.tune, 0),
      seq,
      seqLength,
      rrGroup: seqLength > 1 ? (region.groupIndex === 0 ? 1 : region.groupIndex + 1) : 0,
      swLast: sw,
      swLo: region.opcodes.sw_lokey != null ? parseNote(region.opcodes.sw_lokey) : null,
      swHi: region.opcodes.sw_hikey != null ? parseNote(region.opcodes.sw_hikey) : null,
      trigger,
      offset: Math.max(0, integer(region.opcodes.offset, 0)),
      end: Math.max(0, integer(region.opcodes.end, 0)),
      loopMode: loopMode(region.opcodes.loop_mode),
      loopStart: Math.max(0, integer(region.opcodes.loop_start, 0)),
      loopEnd: Math.max(0, integer(region.opcodes.loop_end, 0)),
      gainDb: number(region.opcodes.volume, 0),
      pan: clampPan(number(region.opcodes.pan, 0) / 100),
      mic,
      exclusive: integer(region.opcodes.group, 0),
      offBy: integer(region.opcodes.off_by, 0),
      ampeg: {
        ...emptyAmpeg(),
        attack: number(region.opcodes.ampeg_attack, 0),
        hold: number(region.opcodes.ampeg_hold, 0),
        decay: number(region.opcodes.ampeg_decay, 0),
        sustain: number(region.opcodes.ampeg_sustain, 100) / 100,
        release: number(region.opcodes.ampeg_release, 0.03),
      },
    }))
  })

  const keyswitches: Keyswitch[] = [...labels.entries()].map(([key, label]) => ({
    key,
    label,
    articulation: label.toLowerCase().replace(/\s+/g, '-'),
  }))
  const firstSwitch = keyswitches[0]?.key ?? null
  return makeProgram({
    name: name.replace(/\.sfz$/i, ''),
    license: 'CC0-1.0',
    defaultSwitch: swDefault ?? firstSwitch,
    keyswitches,
    mics: mics.size ? [...mics.values()] : undefined,
    zones,
    samples,
  })
}

function preprocess(text: string, files: Map<string, string | ArrayBuffer> | undefined, depth: number): string {
  if (!files || depth > 4) return text
  return text.split(/\r?\n/).map((line) => {
    const include = line.match(/^\s*#include\s+"([^"]+)"/i)
    if (!include) return line
    const file = lookupFile(files, include[1])
    if (file == null) return ''
    const decoded = typeof file === 'string' ? file : new TextDecoder().decode(file)
    return preprocess(decoded, files, depth + 1)
  }).join('\n')
}

function lookupFile(files: Map<string, string | ArrayBuffer>, path: string) {
  const clean = path.replace(/\\/g, '/')
  if (files.has(clean)) return files.get(clean)
  const base = clean.split('/').pop() ?? clean
  for (const [name, value] of files) {
    if (name === base || name.endsWith(`/${base}`)) return value
  }
  return undefined
}

function opcodes(line: string): [string, string][] {
  const marks = [...line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)]
  return marks.map((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length
    const end = index + 1 < marks.length ? marks[index + 1].index ?? line.length : line.length
    let value = line.slice(start, end).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    return [mark[1].toLowerCase(), value]
  })
}

function stripComment(line: string) {
  const define = line.match(/^\s*#(define|include)\b/i)
  if (define) return line
  const hash = line.indexOf('#')
  return hash >= 0 ? line.slice(0, hash) : line
}

function substitute(line: string, defines: Map<string, string>) {
  if (!defines.size) return line
  return line.replace(/\$[A-Za-z0-9_]+/g, (token) => defines.get(token) ?? token)
}

function joinPath(root: string, sample: string) {
  const path = sample.replace(/\\/g, '/').replace(/^"|"$/g, '')
  if (!root || /^(https?:)?\//.test(path)) return path
  return `${root.replace(/\/?$/, '/')}${path.replace(/^\.\//, '')}`
}

function loopMode(value: string | undefined): LoopMode {
  if (value === 'one_shot') return 'one-shot'
  if (value === 'loop_continuous') return 'loop'
  if (value === 'loop_sustain') return 'sustain'
  return 'none'
}

const NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }

export function parseNote(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const trimmed = value.trim()
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return clampMidi(Number(trimmed))
  const match = trimmed.match(/^([a-gA-G])([#b]?)(-?\d+)$/)
  if (!match) return null
  let semi = NAMES[match[1].toLowerCase()] ?? 0
  if (match[2] === '#') semi += 1
  if (match[2] === 'b') semi -= 1
  return clampMidi((Number(match[3]) + 1) * 12 + semi)
}

function number(value: string | undefined, fallback: number) {
  if (value == null) return fallback
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function integer(value: string | undefined, fallback: number) {
  return Math.round(number(value, fallback))
}

function clampPan(value: number) {
  return Math.max(-1, Math.min(1, value))
}

function stripBom(text: string) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

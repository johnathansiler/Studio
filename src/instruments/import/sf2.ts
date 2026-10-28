import { dbToGain, makeZone } from '../engine/zone'
import type { SampleInstrumentDef } from '../engine/types'

const INSTRUMENT = 41
const KEY_RANGE = 43
const VEL_RANGE = 44
const ATTENUATION = 48
const COARSE_TUNE = 51
const FINE_TUNE = 52
const SAMPLE_ID = 53
const SAMPLE_MODES = 54
const EXCLUSIVE = 57
const ROOT_KEY = 58
const ATTACK = 34
const DECAY = 36
const SUSTAIN = 37
const RELEASE = 38
const PAN = 17

const ADD = new Set([0, 1, 2, 3, 4, 12, 45, 50, PAN, ATTENUATION, COARSE_TUNE, FINE_TUNE, ATTACK, 35, DECAY, SUSTAIN, RELEASE])

export interface Sf2Sample {
  id: string
  sampleRate: number
  channels: Float32Array[]
}

export interface Sf2Parse {
  def: SampleInstrumentDef
  samples: Sf2Sample[]
}

interface Gen {
  oper: number
  signed: number
  lo: number
  hi: number
}

function text(view: DataView, offset: number, length: number) {
  let out = ''
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i)
    if (!code) break
    out += String.fromCharCode(code)
  }
  return out
}

function four(view: DataView, offset: number) {
  return text(view, offset, 4)
}

interface Node {
  id: string
  data: number
  size: number
}

function list(view: DataView, data: number, size: number) {
  const type = four(view, data)
  const children: Node[] = []
  let offset = data + 4
  const end = data + size
  while (offset + 8 <= end) {
    const id = four(view, offset)
    const child = view.getUint32(offset + 4, true)
    children.push({ id, data: offset + 8, size: child })
    offset += 8 + child + (child % 2)
  }
  return { type, children }
}

function gensOf(view: DataView, data: number, from: number, to: number): Gen[] {
  const out: Gen[] = []
  for (let index = from; index < to; index++) {
    const at = data + index * 4
    if (at + 4 > data + view.byteLength) break
    const amount = view.getUint16(at + 2, true)
    out.push({ oper: view.getUint16(at, true), signed: view.getInt16(at + 2, true), lo: amount & 255, hi: (amount >> 8) & 255 })
  }
  return out
}

function zonesInRange(view: DataView, bagData: number, genData: number, fromBag: number, toBag: number) {
  const starts: number[] = []
  for (let i = fromBag; i <= toBag; i++) starts.push(view.getUint16(bagData + i * 4, true))
  let global: Gen[] = []
  const zones: Gen[][] = []
  for (let i = 0; i < toBag - fromBag; i++) {
    const gens = gensOf(view, genData, starts[i] ?? 0, starts[i + 1] ?? starts[i] ?? 0)
    const real = gens.some((gen) => gen.oper === SAMPLE_ID || gen.oper === INSTRUMENT)
    if (!real) global = gens
    else zones.push([...global, ...gens])
  }
  return zones
}

function timecents(value: number) {
  if (value <= -12000) return 0
  return Math.max(0, Math.min(20, 2 ** (value / 1200)))
}

function find(gens: Gen[], oper: number) {
  for (let i = gens.length - 1; i >= 0; i--) if (gens[i].oper === oper) return gens[i]
  return null
}

function merged(instrument: Gen[], preset: Gen[]) {
  const map = new Map<number, Gen>()
  for (const gen of instrument) map.set(gen.oper, { ...gen })
  for (const gen of preset) {
    if (gen.oper === INSTRUMENT || gen.oper === SAMPLE_ID || gen.oper === SAMPLE_MODES || gen.oper === ROOT_KEY || gen.oper === EXCLUSIVE) continue
    if (gen.oper === KEY_RANGE || gen.oper === VEL_RANGE) {
      const have = map.get(gen.oper)
      if (!have) map.set(gen.oper, { ...gen })
      else map.set(gen.oper, { ...have, lo: Math.max(have.lo, gen.lo), hi: Math.min(have.hi, gen.hi) })
      continue
    }
    const have = map.get(gen.oper)
    if (!have) map.set(gen.oper, { ...gen })
    else if (ADD.has(gen.oper)) map.set(gen.oper, { ...have, signed: have.signed + gen.signed, lo: have.lo, hi: have.hi })
    else map.set(gen.oper, { ...gen })
  }
  return [...map.values()]
}

interface Header {
  name: string
  start: number
  end: number
  loopStart: number
  loopEnd: number
  sampleRate: number
  pitch: number
  correction: number
  link: number
  type: number
}

/**
 * Read a SoundFont 2 bank from bytes the user opened.
 * 16-bit samples are the usual case. A `sm24` chunk, when present, restores the low byte.
 */
export function parseSf2(bytes: Uint8Array, idPrefix = 'sf2'): Sf2Parse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (four(view, 0) !== 'RIFF' || four(view, 8) !== 'sfbk') throw new Error('Not a SoundFont')
  const riffSize = view.getUint32(4, true)
  const top = { children: [] as Node[] }
  {
    let offset = 12
    const end = Math.min(view.byteLength, 8 + riffSize)
    while (offset + 8 <= end) {
      const id = four(view, offset)
      const child = view.getUint32(offset + 4, true)
      top.children.push({ id, data: offset + 8, size: child })
      offset += 8 + child + (child % 2)
    }
  }
  const info = top.children.find((child) => child.id === 'LIST' && four(view, child.data) === 'INFO')
  const sdta = top.children.find((child) => child.id === 'LIST' && four(view, child.data) === 'sdta')
  const pdta = top.children.find((child) => child.id === 'LIST' && four(view, child.data) === 'pdta')
  if (!sdta || !pdta) throw new Error('SoundFont is missing samples')
  const data = list(view, sdta.data, sdta.size)
  const tables = list(view, pdta.data, pdta.size)
  const smpl = data.children.find((child) => child.id === 'smpl')
  const sm24 = data.children.find((child) => child.id === 'sm24')
  if (!smpl) throw new Error('SoundFont has no sample data')
  const table = (id: string) => tables.children.find((child) => child.id === id)
  const shdr = table('shdr')
  const phdr = table('phdr')
  const pbag = table('pbag')
  const pgen = table('pgen')
  const inst = table('inst')
  const ibag = table('ibag')
  const igen = table('igen')
  if (!shdr || !phdr || !pbag || !pgen || !inst || !ibag || !igen) throw new Error('SoundFont is missing preset tables')

  const sampleCount = Math.floor(smpl.size / 2)
  const pcm = new Float32Array(sampleCount)
  for (let i = 0; i < sampleCount; i++) {
    const high = view.getInt16(smpl.data + i * 2, true)
    const extra = sm24 && i < sm24.size ? view.getUint8(sm24.data + i) : null
    if (extra == null) pcm[i] = high / 32768
    else {
      let value = (high << 8) | extra
      if (value & 0x800000) value -= 0x1000000
      pcm[i] = value / 8388608
    }
  }
  const headers: Header[] = []
  const headerCount = Math.floor(shdr.size / 46)
  for (let i = 0; i < headerCount - 1; i++) {
    const at = shdr.data + i * 46
    headers.push({
      name: text(view, at, 20),
      start: view.getUint32(at + 20, true),
      end: view.getUint32(at + 24, true),
      loopStart: view.getUint32(at + 28, true),
      loopEnd: view.getUint32(at + 32, true),
      sampleRate: view.getUint32(at + 36, true) || 44100,
      pitch: view.getUint8(at + 40),
      correction: view.getInt8(at + 41),
      link: view.getUint16(at + 42, true),
      type: view.getUint16(at + 44, true),
    })
  }
  const instruments: { name: string; zones: Gen[][] }[] = []
  const instCount = Math.floor(inst.size / 22)
  for (let i = 0; i < instCount - 1; i++) {
    const at = inst.data + i * 22
    const bag = view.getUint16(at + 20, true)
    const next = view.getUint16(inst.data + (i + 1) * 22 + 20, true)
    instruments.push({ name: text(view, at, 20), zones: zonesInRange(view, ibag.data, igen.data, bag, next) })
  }
  const presets: { name: string; zones: Gen[][] }[] = []
  const presetCount = Math.floor(phdr.size / 38)
  let bankName = 'SoundFont'
  const infoList = info ? list(view, info.data, info.size) : null
  const inam = infoList?.children.find((child) => child.id === 'INAM')
  if (inam) bankName = text(view, inam.data, inam.size).trim() || bankName
  for (let i = 0; i < presetCount - 1; i++) {
    const at = phdr.data + i * 38
    const bag = view.getUint16(at + 24, true)
    const next = view.getUint16(phdr.data + (i + 1) * 38 + 24, true)
    const name = text(view, at, 20).trim()
    if (i === 0 && name) bankName = name
    presets.push({ name, zones: zonesInRange(view, pbag.data, pgen.data, bag, next) })
  }

  const samples: Sf2Sample[] = []
  const known = new Map<string, Sf2Sample>()
  const zones = []
  const sliceSample = (index: number, from: number, to: number) => {
    const header = headers[index]
    if (!header) return null
    const start = Math.max(0, Math.min(pcm.length, from))
    const end = Math.max(start, Math.min(pcm.length, to))
    const id = `${idPrefix}:${index}:${start}:${end}`
    const cached = known.get(id)
    if (cached) return { id, header, start, end }
    const mono = pcm.slice(start, end)
    const channels = [mono]
    const link = headers[header.link]
    if ((header.type & 4) !== 0 && link && header.link !== index) {
      const linkedFrom = Math.max(0, Math.min(pcm.length, link.start + (start - header.start)))
      const linkedTo = Math.min(pcm.length, linkedFrom + mono.length)
      channels.push(pcm.slice(linkedFrom, linkedTo))
    }
    const sample = { id, sampleRate: header.sampleRate, channels }
    known.set(id, sample)
    samples.push(sample)
    return { id, header, start, end }
  }

  for (const preset of presets) {
    for (const presetZone of preset.zones) {
      const instGen = find(presetZone, INSTRUMENT)
      const instrument = instGen ? instruments[instGen.signed] : null
      if (!instrument) continue
      for (const instZone of instrument.zones) {
        const gens = merged(instZone, presetZone)
        const sampleGen = find(gens, SAMPLE_ID)
        if (!sampleGen) continue
        const header = headers[sampleGen.signed]
        if (!header) continue
        const coarse = (oper: number) => (find(gens, oper)?.signed ?? 0) * 32768
        const fine = (oper: number) => find(gens, oper)?.signed ?? 0
        const from = header.start + fine(0) + coarse(4)
        const to = header.end + fine(1) + coarse(12)
        const sliced = sliceSample(sampleGen.signed, from, to)
        if (!sliced || sliced.end - sliced.start < 2) continue
        const loopFrom = header.loopStart + fine(2) + coarse(45) - sliced.start
        const loopTo = header.loopEnd + fine(3) + coarse(50) - sliced.start
        const mode = find(gens, SAMPLE_MODES)?.signed ?? 0
        const loopMode = mode === 1 ? 'forward' : mode === 3 ? 'sustain' : 'none'
        const rootGen = find(gens, ROOT_KEY)
        const root = rootGen && rootGen.signed >= 0 && rootGen.signed <= 127 ? rootGen.signed : header.pitch === 255 ? 60 : header.pitch
        const key = find(gens, KEY_RANGE)
        const vel = find(gens, VEL_RANGE)
        const exclusive = find(gens, EXCLUSIVE)?.signed ?? 0
        const attack = find(gens, ATTACK)
        const decay = find(gens, DECAY)
        const sustain = find(gens, SUSTAIN)
        const release = find(gens, RELEASE)
        const attenuation = find(gens, ATTENUATION)?.signed ?? 0
        zones.push(makeZone({
          id: `sf2-${zones.length + 1}`,
          sampleId: sliced.id,
          root,
          loKey: key ? key.lo : 0,
          hiKey: key ? key.hi : 127,
          loVel: vel ? vel.lo : 0,
          hiVel: vel ? vel.hi : 127,
          tune: header.correction + fine(FINE_TUNE) + fine(COARSE_TUNE) * 100,
          gain: dbToGain(-attenuation / 10),
          pan: Math.max(-1, Math.min(1, fine(PAN) / 500)),
          start: 0,
          end: sliced.end - sliced.start,
          loopStart: Math.max(0, loopFrom),
          loopEnd: Math.max(0, loopTo),
          loopMode: loopTo > loopFrom + 1 ? loopMode : 'none',
          group: exclusive > 0 ? exclusive : 0,
          offBy: exclusive > 0 ? exclusive : 0,
          attack: attack ? timecents(attack.signed) : null,
          decay: decay ? timecents(decay.signed) : null,
          sustain: sustain ? 10 ** (-sustain.signed / 200) : null,
          release: release ? timecents(release.signed) : null,
        }))
      }
    }
  }
  return {
    def: {
      id: idPrefix,
      name: bankName || 'SoundFont',
      zones,
      articulations: [],
      mics: [],
      defaultArticulation: '',
      controls: [],
    },
    samples,
  }
}

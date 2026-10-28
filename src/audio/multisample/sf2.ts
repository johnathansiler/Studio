import type { LoopMode, SamplerProgram, SamplePack, SampleRef } from './types'
import { makeProgram, makeSample, makeZone, samplerId } from './types'

const GEN = {
  startAddrsOffset: 0,
  endAddrsOffset: 1,
  startloopAddrsOffset: 2,
  endloopAddrsOffset: 3,
  startAddrsCoarseOffset: 4,
  endAddrsCoarseOffset: 12,
  pan: 17,
  attackVolEnv: 34,
  holdVolEnv: 35,
  decayVolEnv: 36,
  sustainVolEnv: 37,
  releaseVolEnv: 38,
  instrument: 41,
  keyRange: 43,
  velRange: 44,
  startloopAddrsCoarseOffset: 45,
  initialAttenuation: 48,
  endloopAddrsCoarseOffset: 50,
  coarseTune: 51,
  fineTune: 52,
  sampleID: 53,
  sampleModes: 54,
  scaleTuning: 56,
  exclusiveClass: 57,
  overridingRootKey: 58,
} as const

interface Bag {
  gen: number
  mod: number
}

interface GenMap {
  values: Map<number, number>
  key?: [number, number]
  vel?: [number, number]
}

interface Header {
  name: string
  start: number
  end: number
  startLoop: number
  endLoop: number
  sampleRate: number
  originalPitch: number
  pitchCorrection: number
}

interface PresetHeader {
  name: string
  bank: number
  preset: number
  bag: number
}

interface InstHeader {
  name: string
  bag: number
}

export interface SoundFontImport {
  programs: SamplerProgram[]
  pack: SamplePack
}

/** SoundFont 2. One program per preset. PCM stays packed until a note asks for it. */
export function importSoundFont(bytes: ArrayBuffer): SoundFontImport {
  const view = new DataView(bytes)
  const root = parseRiff(view, 0, bytes.byteLength).find((chunk) => chunk.id === 'RIFF' && chunk.type === 'sfbk')
  if (!root?.children) throw new Error('Not a SoundFont')
  const smpl = find(root.children, 'smpl')
  const pdta = findList(root.children, 'pdta')
  if (!smpl || !pdta?.children) throw new Error('SoundFont is missing sample data')
  const sm24 = find(root.children, 'sm24')
  const presets = readPresets(view, find(pdta.children, 'phdr'))
  const pbags = readBags(view, find(pdta.children, 'pbag'))
  const pgens = readGens(view, find(pdta.children, 'pgen'))
  const instruments = readInstruments(view, find(pdta.children, 'inst'))
  const ibags = readBags(view, find(pdta.children, 'ibag'))
  const igens = readGens(view, find(pdta.children, 'igen'))
  const samples = readSamples(view, find(pdta.children, 'shdr'))
  if (presets.length < 2 || instruments.length < 2 || samples.length < 2) throw new Error('SoundFont has no presets')
  const pack: SamplePack = {
    id: `sf2pack_${smpl.size}_${samples.length}`,
    pcm: bytes.slice(smpl.start, smpl.start + smpl.size),
    sm24: sm24 ? bytes.slice(sm24.start, sm24.start + sm24.size) : undefined,
    channels: 1,
  }
  const programs: SamplerProgram[] = []
  for (let p = 0; p < presets.length - 1; p++) {
    const preset = presets[p]
    if (/^EOP/i.test(preset.name)) continue
    const presetZones = bagMaps(pbags, pgens, preset.bag, presets[p + 1]?.bag ?? pbags.length)
    const presetGlobal = presetZones.find((zone) => !zone.values.has(GEN.instrument))
    const zones = []
    const sampleRefs: SampleRef[] = []
    for (const zone of presetZones) {
      const instIndex = zone.values.get(GEN.instrument)
      if (instIndex == null || !instruments[instIndex]) continue
      const inst = instruments[instIndex]
      const instZones = bagMaps(ibags, igens, inst.bag, instruments[instIndex + 1]?.bag ?? ibags.length)
      const instGlobal = instZones.find((item) => !item.values.has(GEN.sampleID))
      for (const item of instZones) {
        const sampleIndex = item.values.get(GEN.sampleID)
        if (sampleIndex == null || !samples[sampleIndex] || /^EOS/i.test(samples[sampleIndex].name)) continue
        const presetGens = overlay(presetGlobal, zone)
        const instGens = overlay(instGlobal, item)
        const gens = overlay(presetGens, instGens)
        gens.key = intersect(presetGens.key, instGens.key)
        gens.vel = intersect(presetGens.vel, instGens.vel)
        const header = samples[sampleIndex]
        const built = zoneFrom(gens, header, pack, sampleIndex, zones.length)
        if (!built) continue
        zones.push(built.zone)
        sampleRefs.push(built.sample)
      }
    }
    if (!zones.length) continue
    programs.push(makeProgram({
      id: samplerId('sf2'),
      name: preset.name.trim() || `Preset ${preset.preset}`,
      author: '',
      license: 'public-domain',
      zones,
      samples: sampleRefs,
      voices: 32,
    }))
  }
  if (!programs.length) throw new Error('SoundFont presets had no samples')
  return { programs, pack }
}

function zoneFrom(gens: GenMap, header: Header, pack: SamplePack, sampleIndex: number, index: number) {
  const start = header.start + amount(gens, GEN.startAddrsOffset) + amount(gens, GEN.startAddrsCoarseOffset) * 32768
  const end = header.end + amount(gens, GEN.endAddrsOffset) + amount(gens, GEN.endAddrsCoarseOffset) * 32768
  const loopStart = header.startLoop + amount(gens, GEN.startloopAddrsOffset) + amount(gens, GEN.startloopAddrsCoarseOffset) * 32768
  const loopEnd = header.endLoop + amount(gens, GEN.endloopAddrsOffset) + amount(gens, GEN.endloopAddrsCoarseOffset) * 32768
  const frames = end - start
  if (frames < 2) return null
  const [lokey, hikey] = gens.key ?? [0, 127]
  const [lovel, hivel] = gens.vel ?? [0, 127]
  if (lokey > hikey || lovel > hivel) return null
  const rootRaw = gens.values.has(GEN.overridingRootKey) ? amount(gens, GEN.overridingRootKey) : header.originalPitch
  const root = rootRaw >= 0 && rootRaw <= 127 ? rootRaw : header.originalPitch <= 127 ? header.originalPitch : 60
  const mode = amount(gens, GEN.sampleModes)
  const loop: LoopMode = mode === 1 || mode === 2 ? 'loop' : mode === 3 ? 'sustain' : 'none'
  const tune = amount(gens, GEN.fineTune) + amount(gens, GEN.coarseTune) * 100 + header.pitchCorrection
  const attenuation = amount(gens, GEN.initialAttenuation)
  const sample = makeSample({
    id: `sf2:${sampleIndex}:${index + 1}`,
    url: '',
    format: pack.sm24 ? 'pcm-s24le' : 'pcm-s16le',
    sampleRate: header.sampleRate || 48000,
    channels: 1,
    frameOffset: Math.max(0, start),
    frameCount: frames,
    packId: pack.id,
  })
  const zone = makeZone({
    id: `sf2_${index + 1}`,
    sampleId: sample.id,
    lokey,
    hikey,
    lovel,
    hivel,
    root,
    tuneCents: tune,
    keytrack: (gens.values.get(GEN.scaleTuning) ?? 100) / 100,
    loopMode: loop,
    loopStart: Math.max(0, loopStart - start),
    loopEnd: Math.max(0, loopEnd - start),
    gainDb: attenuation ? -attenuation / 10 : 0,
    pan: Math.max(-1, Math.min(1, amount(gens, GEN.pan) / 500)),
    exclusive: amount(gens, GEN.exclusiveClass),
    ampeg: {
      attack: timecents(gens.values.get(GEN.attackVolEnv), 0.001),
      hold: timecents(gens.values.get(GEN.holdVolEnv), 0),
      decay: timecents(gens.values.get(GEN.decayVolEnv), 0),
      sustain: sustainGain(gens.values.get(GEN.sustainVolEnv) ?? 0),
      release: timecents(gens.values.get(GEN.releaseVolEnv), 0.03),
    },
  })
  return { zone, sample }
}

function bagMaps(bags: Bag[], gens: RawGen[], from: number, to: number) {
  const maps: GenMap[] = []
  for (let i = from; i < to; i++) {
    const start = bags[i]?.gen ?? 0
    const end = bags[i + 1]?.gen ?? gens.length
    maps.push(genMap(gens.slice(start, end)))
  }
  return maps
}

function overlay(base: GenMap | undefined, extra: GenMap): GenMap {
  if (!base) return { values: new Map(extra.values), key: extra.key, vel: extra.vel }
  const values = new Map(base.values)
  for (const [key, value] of extra.values) values.set(key, value)
  return { values, key: extra.key ?? base.key, vel: extra.vel ?? base.vel }
}

function intersect(a: [number, number] | undefined, b: [number, number] | undefined) {
  if (!a && !b) return undefined
  return [Math.max(a?.[0] ?? 0, b?.[0] ?? 0), Math.min(a?.[1] ?? 127, b?.[1] ?? 127)] as [number, number]
}

function genMap(gens: RawGen[]): GenMap {
  const values = new Map<number, number>()
  let key: [number, number] | undefined
  let vel: [number, number] | undefined
  for (const gen of gens) {
    if (gen.op === GEN.keyRange) key = [gen.lo, gen.hi]
    else if (gen.op === GEN.velRange) vel = [gen.lo, gen.hi]
    else values.set(gen.op, gen.amount)
  }
  return { values, key, vel }
}

function amount(gens: GenMap, op: number) {
  return gens.values.get(op) ?? 0
}

function timecents(value: number | undefined, fallback: number) {
  if (value == null) return fallback
  const seconds = 2 ** (value / 1200)
  if (!Number.isFinite(seconds)) return fallback
  return Math.max(0, Math.min(20, seconds))
}

function sustainGain(centibels: number) {
  const gain = 10 ** (-centibels / 200)
  return Math.max(0, Math.min(1, gain))
}

interface RawGen {
  op: number
  amount: number
  lo: number
  hi: number
}

interface Chunk {
  id: string
  type?: string
  start: number
  size: number
  children?: Chunk[]
}

function parseRiff(view: DataView, offset: number, end: number): Chunk[] {
  const chunks: Chunk[] = []
  while (offset + 8 <= end) {
    const id = four(view, offset)
    const size = view.getUint32(offset + 4, true)
    const start = offset + 8
    const next = start + size + (size % 2)
    if (next < start) break
    if (id === 'RIFF' || id === 'LIST') {
      const type = four(view, start)
      chunks.push({ id, type, start: start + 4, size: Math.max(0, size - 4), children: parseRiff(view, start + 4, Math.min(end, start + size)) })
    } else chunks.push({ id, start, size })
    offset = Math.min(end, next)
    if (!id.trim()) break
  }
  return chunks
}

function find(chunks: Chunk[], id: string): Chunk | undefined {
  for (const chunk of chunks) {
    if (chunk.id === id) return chunk
    if (chunk.children) {
      const nested = find(chunk.children, id)
      if (nested) return nested
    }
  }
  return undefined
}

function findList(chunks: Chunk[], type: string): Chunk | undefined {
  for (const chunk of chunks) {
    if (chunk.id === 'LIST' && chunk.type === type) return chunk
    if (chunk.children) {
      const nested = findList(chunk.children, type)
      if (nested) return nested
    }
  }
  return undefined
}

function readPresets(view: DataView, chunk: Chunk | undefined): PresetHeader[] {
  if (!chunk) return []
  const out: PresetHeader[] = []
  for (let offset = 0; offset + 38 <= chunk.size; offset += 38) {
    const at = chunk.start + offset
    out.push({
      name: nameOf(view, at, 20),
      preset: view.getUint16(at + 20, true),
      bank: view.getUint16(at + 22, true),
      bag: view.getUint16(at + 24, true),
    })
  }
  return out
}

function readInstruments(view: DataView, chunk: Chunk | undefined): InstHeader[] {
  if (!chunk) return []
  const out: InstHeader[] = []
  for (let offset = 0; offset + 22 <= chunk.size; offset += 22) {
    const at = chunk.start + offset
    out.push({ name: nameOf(view, at, 20), bag: view.getUint16(at + 20, true) })
  }
  return out
}

function readBags(view: DataView, chunk: Chunk | undefined): Bag[] {
  if (!chunk) return []
  const out: Bag[] = []
  for (let offset = 0; offset + 4 <= chunk.size; offset += 4) {
    const at = chunk.start + offset
    out.push({ gen: view.getUint16(at, true), mod: view.getUint16(at + 2, true) })
  }
  return out
}

function readGens(view: DataView, chunk: Chunk | undefined): RawGen[] {
  if (!chunk) return []
  const out: RawGen[] = []
  for (let offset = 0; offset + 4 <= chunk.size; offset += 4) {
    const at = chunk.start + offset
    out.push({
      op: view.getUint16(at, true),
      amount: view.getInt16(at + 2, true),
      lo: view.getUint8(at + 2),
      hi: view.getUint8(at + 3),
    })
  }
  return out
}

function readSamples(view: DataView, chunk: Chunk | undefined): Header[] {
  if (!chunk) return []
  const out: Header[] = []
  for (let offset = 0; offset + 46 <= chunk.size; offset += 46) {
    const at = chunk.start + offset
    out.push({
      name: nameOf(view, at, 20),
      start: view.getUint32(at + 20, true),
      end: view.getUint32(at + 24, true),
      startLoop: view.getUint32(at + 28, true),
      endLoop: view.getUint32(at + 32, true),
      sampleRate: view.getUint32(at + 36, true),
      originalPitch: view.getUint8(at + 40),
      pitchCorrection: view.getInt8(at + 41),
    })
  }
  return out
}

function nameOf(view: DataView, offset: number, length: number) {
  let text = ''
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i)
    if (!code) break
    text += String.fromCharCode(code)
  }
  return text
}

function four(view: DataView, offset: number) {
  let text = ''
  for (let i = 0; i < 4; i++) text += String.fromCharCode(view.getUint8(offset + i))
  return text
}

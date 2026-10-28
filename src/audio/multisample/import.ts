import { decodeSampleBytes } from './cache'
import { importDecentSampler } from './dspreset'
import { importSfz } from './sfz'
import { importSoundFont } from './sf2'
import type { SamplePack, SamplerProgram } from './types'
import { resolveSampleUrl } from './source'

export interface LocalSample {
  id: string
  name: string
  sampleRate: number
  channels: Float32Array[]
}

export interface ImportedInstrument {
  program: SamplerProgram
  programs: SamplerProgram[]
  pack: SamplePack | null
}

/** SFZ, SoundFont 2, or DecentSampler. The name picks the parser when the bytes are ambiguous. */
export function importInstrument(name: string, bytes: ArrayBuffer | string): ImportedInstrument {
  const lower = name.toLowerCase()
  if (lower.endsWith('.sf2') || isSoundFont(bytes)) {
    const binary = typeof bytes === 'string' ? new TextEncoder().encode(bytes).buffer : bytes
    const font = importSoundFont(binary)
    return { program: font.programs[0], programs: font.programs, pack: font.pack }
  }
  const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes)
  if (lower.endsWith('.dspreset') || /<decentsampler[\s>]/i.test(text)) {
    const program = importDecentSampler(text, fileStem(name))
    return { program, programs: [program], pack: null }
  }
  const program = importSfz(text, fileStem(name))
  return { program, programs: [program], pack: null }
}

/** Point sample paths at sibling files the user picked with the preset. */
export function bindLocalSamples(program: SamplerProgram, files: Map<string, ArrayBuffer>): { program: SamplerProgram; assets: LocalSample[] } {
  const assets: LocalSample[] = []
  const samples = program.samples.map((sample) => {
    if (!sample.url || sample.packId) return sample
    const bytes = lookup(files, sample.url)
    if (!bytes) return sample
    let decoded: { sampleRate: number; channels: Float32Array[] }
    try {
      decoded = decodeSampleBytes(bytes, sample)
    } catch {
      return sample
    }
    assets.push({
      id: sample.id,
      name: baseName(sample.url),
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
    })
    return { ...sample, bufferId: sample.id, url: '' }
  })
  return { program: { ...program, samples }, assets }
}

/** Rewrite relative sample paths against a preset's Hugging Face URL. */
export function absolutizeProgram(program: SamplerProgram, presetUrl: string): SamplerProgram {
  return {
    ...program,
    samples: program.samples.map((sample) => {
      if (!sample.url || sample.packId) return sample
      return { ...sample, url: resolveSampleUrl(presetUrl, sample.url) }
    }),
  }
}

function isSoundFont(bytes: ArrayBuffer | string) {
  if (typeof bytes === 'string' || bytes.byteLength < 12) return false
  const view = new Uint8Array(bytes, 0, 12)
  const riff = String.fromCharCode(view[0], view[1], view[2], view[3])
  const kind = String.fromCharCode(view[8], view[9], view[10], view[11])
  return riff === 'RIFF' && kind === 'sfbk'
}

function lookup(files: Map<string, ArrayBuffer>, path: string) {
  const clean = path.replace(/\\/g, '/')
  if (files.has(clean)) return files.get(clean)
  if (files.has(path)) return files.get(path)
  const base = baseName(clean).toLowerCase()
  for (const [name, value] of files) {
    const file = name.replace(/\\/g, '/')
    if (file.toLowerCase() === clean.toLowerCase() || baseName(file).toLowerCase() === base) return value
  }
  return undefined
}

function baseName(path: string) {
  const clean = path.replace(/\\/g, '/')
  return clean.split('/').pop() || clean
}

function fileStem(name: string) {
  return baseName(name).replace(/\.(sfz|sf2|dspreset)$/i, '') || 'Instrument'
}

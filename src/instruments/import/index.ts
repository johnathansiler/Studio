import { contentHash } from '../../storage/content'
import type { SampleInstrumentDef } from '../engine/types'
import { decodeFlac } from '../../model/flac'
import { decodeWavPCM } from '../../model/wav'
import { parseDspreset } from './dspreset'
import { parseSf2 } from './sf2'
import { parseSfz } from './sfz'

export interface LocalFile {
  name: string
  /** Folder-relative path when the user opened a directory. */
  path?: string
  bytes: Uint8Array
}

export interface ImportedSample {
  id: string
  sampleRate: number
  channels: Float32Array[]
}

export interface ImportedInstrument {
  def: SampleInstrumentDef
  samples: ImportedSample[]
  warnings: string[]
}

function lower(value: string) {
  return value.replace(/\\/g, '/').toLowerCase()
}

function findFile(files: LocalFile[], samplePath: string) {
  const wanted = lower(samplePath).replace(/^\.\//, '')
  const base = wanted.split('/').pop() ?? wanted
  return files.find((file) => lower(file.path || file.name).endsWith(wanted))
    ?? files.find((file) => lower(file.name) === base)
    ?? null
}

function decodeAudio(bytes: Uint8Array) {
  const copy = bytes.slice()
  const head = new TextDecoder().decode(copy.subarray(0, 4))
  if (head === 'fLaC') return decodeFlac(copy)
  return decodeWavPCM(copy.buffer as ArrayBuffer)
}

async function resolvePaths(def: SampleInstrumentDef, files: LocalFile[]) {
  const warnings: string[] = []
  const samples: ImportedSample[] = []
  const ids = new Map<string, string>()
  for (const zone of def.zones) {
    const path = zone.sampleId
    if (!path || ids.has(path)) {
      zone.sampleId = ids.get(path) ?? zone.sampleId
      continue
    }
    const file = findFile(files, path)
    if (!file) {
      warnings.push(`Missing sample ${path}`)
      ids.set(path, '')
      zone.sampleId = ''
      continue
    }
    try {
      const hash = await contentHash(file.bytes)
      const decoded = decodeAudio(file.bytes)
      ids.set(path, hash)
      zone.sampleId = hash
      if (!samples.some((sample) => sample.id === hash)) {
        samples.push({ id: hash, sampleRate: decoded.sampleRate, channels: decoded.channels })
      }
      if (!(zone.end > zone.start)) zone.end = decoded.channels[0]?.length ?? 0
    } catch {
      warnings.push(`Could not read ${file.name}`)
      ids.set(path, '')
      zone.sampleId = ''
    }
  }
  def.zones = def.zones.filter((zone) => zone.sampleId)
  return { warnings, samples }
}

/**
 * Import an SFZ, SoundFont (.sf2), or DecentSampler (.dspreset) the user opened on this device.
 * Companion WAV or FLAC files are matched by path. Nothing is downloaded.
 */
export async function importInstrument(files: LocalFile[]): Promise<ImportedInstrument> {
  if (!files.length) throw new Error('Choose an instrument file')
  const sf2 = files.find((file) => lower(file.name).endsWith('.sf2') || lower(file.path || '').endsWith('.sf2'))
  if (sf2) {
    const hash = (await contentHash(sf2.bytes)).slice(0, 16)
    const parsed = parseSf2(sf2.bytes, hash)
    return { def: parsed.def, samples: parsed.samples, warnings: parsed.def.zones.length ? [] : ['SoundFont had no playable zones'] }
  }
  const ds = files.find((file) => {
    const name = lower(file.path || file.name)
    return name.endsWith('.dspreset')
  })
  if (ds) {
    const text = new TextDecoder().decode(ds.bytes)
    const parsed = parseDspreset(text, ds.name.replace(/\.dspreset$/i, ''))
    const resolved = await resolvePaths(parsed.def, files)
    return { def: parsed.def, ...resolved }
  }
  const sfz = files.find((file) => lower(file.path || file.name).endsWith('.sfz'))
  if (sfz) {
    const text = new TextDecoder().decode(sfz.bytes)
    const parsed = parseSfz(text, sfz.name.replace(/\.sfz$/i, ''))
    const resolved = await resolvePaths(parsed.def, files)
    return { def: parsed.def, ...resolved }
  }
  throw new Error('Open an .sfz, .sf2, or .dspreset file')
}

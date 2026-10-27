import { base64ToBytes } from '../storage/idb'
import { contentHash } from '../storage/content'
import { migrateProject } from './schema'
import { encodeFlac, decodeFlac } from './flac'
import type { AudioAsset, Project } from './types'
import { decodeWavPCM, encodeWav } from './wav'
import { unzip, zipFiles } from './zip'

export async function packProject(project: Project, assets: Iterable<AudioAsset>, options: { audio: 'wav' | 'flac' }): Promise<Uint8Array> {
  const migrated = migrateProject(project)
  const refs: { id: string; name: string; sampleRate: number; file: string }[] = []
  const files: { name: string; data: Uint8Array }[] = []
  const seen = new Set<string>()
  for (const asset of assets) {
    const encoded = options.audio === 'flac'
      ? encodeFlac(asset.channels, asset.sampleRate, 16)
      : new Uint8Array(encodeWav(asset.channels, asset.sampleRate, { bits: 32 }))
    const hash = await contentHash(encoded)
    const file = `audio/${hash}.${options.audio === 'flac' ? 'flac' : 'wav'}`
    refs.push({ id: asset.id, name: asset.name, sampleRate: asset.sampleRate, file })
    if (!seen.has(file)) {
      seen.add(file)
      files.push({ name: file, data: encoded })
    }
  }
  const doc = { kind: 'cueharbor', schema: migrated.version, project: migrated, assets: refs }
  files.unshift({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(doc)) })
  return zipFiles(files)
}

export async function unpackProject(bytes: Uint8Array): Promise<{ project: Project; assets: AudioAsset[] }> {
  if (bytes[0] === 0x7b) return unpackLegacy(JSON.parse(new TextDecoder().decode(bytes)))
  const files = await unzip(bytes)
  const projectFile = files.find((file) => file.name === 'project.json')
  if (!projectFile) throw new Error('Not a CueHarbor project')
  const doc = JSON.parse(new TextDecoder().decode(projectFile.data)) as {
    project: unknown
    assets: { id: string; name: string; sampleRate: number; file: string }[]
  }
  const project = migrateProject(doc.project)
  const assets: AudioAsset[] = []
  for (const ref of doc.assets ?? []) {
    const file = files.find((item) => item.name === ref.file)
    if (!file) throw new Error(`Missing ${ref.file}`)
    const decoded = ref.file.endsWith('.flac') ? decodeFlac(file.data) : decodeWavPCM(toBuffer(file.data))
    assets.push({ id: ref.id, name: ref.name, sampleRate: decoded.sampleRate || ref.sampleRate, channels: decoded.channels })
  }
  return { project, assets }
}

function unpackLegacy(parsed: { project: unknown; assets?: { id: string; name: string; sampleRate: number; wav: string }[] }) {
  const project = migrateProject(parsed.project)
  const assets: AudioAsset[] = []
  for (const asset of parsed.assets ?? []) {
    const decoded = decodeWavPCM(toBuffer(base64ToBytes(asset.wav)))
    assets.push({ id: asset.id, name: asset.name, sampleRate: decoded.sampleRate || asset.sampleRate, channels: decoded.channels })
  }
  return { project, assets }
}

function toBuffer(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

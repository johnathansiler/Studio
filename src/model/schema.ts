import { normalizeProject } from '../audio/plugins/catalog'
import { createEmptyProject, SCHEMA_VERSION, type Project } from './types'

export function migrateProject(input: unknown): Project {
  if (!input || typeof input !== 'object') throw new Error('Not a project')
  const raw = input as Partial<Project>
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1
  if (version > SCHEMA_VERSION) throw new Error(`Project schema ${version} is newer than ${SCHEMA_VERSION}`)
  const base = createEmptyProject(raw.sampleRate || 48000, typeof raw.name === 'string' ? raw.name : 'Untitled')
  const merged: Project = {
    ...base,
    ...raw,
    id: raw.id || base.id,
    name: typeof raw.name === 'string' ? raw.name : base.name,
    sampleRate: raw.sampleRate || base.sampleRate,
    tempo: raw.tempo || base.tempo,
    timeSignature: raw.timeSignature ?? base.timeSignature,
    tracks: Array.isArray(raw.tracks) ? raw.tracks : base.tracks,
    version: SCHEMA_VERSION,
  }
  return normalizeProject(merged)
}

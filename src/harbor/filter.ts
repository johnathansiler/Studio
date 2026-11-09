import { bpmMatchesProject } from '../sounds/catalog'
import { sameMusicalKey } from './key'
import type { HarborEntry, LoopKind } from './types'

export interface LoopQuery {
  text: string
  bpm: 'any' | 'project'
  key: string
  kind: 'any' | LoopKind
  instrument: string
  projectBpm: number
}

export function filterHarborLoops(entries: HarborEntry[], query: LoopQuery) {
  const tokens = query.text.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return entries.filter((entry) => {
    if (entry.type !== 'loop') return false
    if (query.kind !== 'any' && entry.loopKind !== query.kind) return false
    if (query.instrument && (entry.instrument ?? '') !== query.instrument) return false
    if (query.key && !sameMusicalKey(query.key, entry.key)) return false
    if (query.bpm === 'project' && (entry.bpm == null || !bpmMatchesProject(entry.bpm, query.projectBpm))) return false
    if (!tokens.length) return true
    const hay = `${entry.name} ${entry.instrument ?? ''} ${entry.pack ?? ''} ${entry.key ?? ''} ${entry.loopKind ?? ''} ${entry.tags.join(' ')}`.toLowerCase()
    return tokens.every((token) => hay.includes(token))
  })
}

export function loopKeys(entries: HarborEntry[]) {
  return [...new Set(entries.filter((entry) => entry.type === 'loop' && entry.key).map((entry) => entry.key as string))].sort((a, b) => a.localeCompare(b))
}

export function loopInstruments(entries: HarborEntry[]) {
  return [...new Set(entries.filter((entry) => entry.type === 'loop' && entry.instrument).map((entry) => entry.instrument as string))].sort((a, b) => a.localeCompare(b))
}

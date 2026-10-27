import type { AudioAsset, Project } from '../model/types'

export interface WorkspaceSnapshot {
  view: 'arrange' | 'mix' | 'session' | 'beats'
  transportMode: 'arrangement' | 'session'
  positionSamples: number
  selectedTrackId: string | null
  surface: 'studio' | 'artist'
  phonePane: 'edit' | 'room'
}

export const SNAPSHOT_LIMIT = 8

export interface AssetRef {
  id: string
  name: string
  sampleRate: number
  hash: string
}

export interface ProjectDoc {
  id: string
  name: string
  savedAt: number
  project: Project
  workspace?: WorkspaceSnapshot
  assets: AssetRef[]
  peaks: number[]
  bytes: number
}

export interface SnapshotDoc extends ProjectDoc {
  key: string
  projectId: string
  slot: number
}

export async function contentHash(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes)
  const digest = await crypto.subtle.digest('SHA-256', copy)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function previewPeaks(channels: Float32Array[], bins = 48): number[] {
  const data = channels[0]
  if (!data?.length) return []
  const width = Math.max(1, Math.floor(data.length / bins))
  const peaks: number[] = []
  const count = Math.min(bins, data.length)
  for (let i = 0; i < count; i++) {
    let peak = 0
    const start = i * width
    const end = Math.min(data.length, start + width)
    for (let j = start; j < end; j++) peak = Math.max(peak, Math.abs(data[j] || 0))
    peaks.push(Math.round(peak * 1000) / 1000)
  }
  return peaks
}

export function dedupeBlobs(items: { hash: string; wav: Uint8Array }[]): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>()
  for (const item of items) if (!map.has(item.hash)) map.set(item.hash, item.wav)
  return map
}

export function planCommit(input: {
  next: ProjectDoc
  current: ProjectDoc | null
  snapshots: SnapshotDoc[]
  snapshot: boolean
  limit?: number
}): { current: ProjectDoc; snapshots: SnapshotDoc[] } {
  const limit = input.limit ?? SNAPSHOT_LIMIT
  let snapshots = input.snapshots.map((item, index) => ({ ...item, slot: Number.isFinite(item.slot) ? item.slot : index }))
  if (input.snapshot && input.current) {
    let slot = 0
    if (snapshots.length < limit) {
      const used = new Set(snapshots.map((item) => item.slot))
      while (used.has(slot)) slot += 1
    } else {
      const oldest = snapshots.reduce((best, item) => (item.savedAt < best.savedAt ? item : best))
      slot = oldest.slot
      snapshots = snapshots.filter((item) => item.slot !== slot)
    }
    snapshots.push({
      ...input.current,
      key: `${input.current.id}:${slot}`,
      projectId: input.current.id,
      slot,
    })
  }
  return { current: input.next, snapshots }
}

/** A staging record is the completed write. Prefer it when it is newer. */
export function chooseCurrent(staging: ProjectDoc | null, current: ProjectDoc | null): ProjectDoc | null {
  if (!staging) return current
  if (!current) return staging
  return staging.savedAt >= current.savedAt ? staging : current
}

export function longestPeaks(assets: AudioAsset[]): number[] {
  let best: Float32Array[] | null = null
  let length = 0
  for (const asset of assets) {
    const n = asset.channels[0]?.length ?? 0
    if (n >= length) {
      length = n
      best = asset.channels
    }
  }
  return best ? previewPeaks(best) : []
}

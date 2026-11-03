/** Quiet copies while a session stays open. Recording and the button do not wait. */
export const VERSION_INTERVAL_MS = 5 * 60 * 1000

export const VERSION_LIMIT = 32

export type VersionReason = 'record' | 'timer' | 'manual'

export interface VersionListItem {
  id: string
  projectId: string
  roomCode: string
  name: string
  by: string
  at: number
  reason: VersionReason
  digest: string
}

/** Clock label for a version. Hours stay local so the list matches the machine. */
export function versionWhen(at: number): string {
  const date = new Date(at)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function versionTitle(reason: VersionReason, at: number): string {
  const when = versionWhen(at)
  if (reason === 'record') return `Recording ${when}`
  if (reason === 'timer') return `Auto ${when}`
  return `Version ${when}`
}

/**
 * Manual saves always land. Recording and the timer skip a copy that matches
 * the last one. The timer also waits out the interval.
 */
export function shouldSaveVersion(input: {
  reason: VersionReason
  lastAt: number | null
  now: number
  digest: string
  lastDigest: string | null
  intervalMs?: number
}): boolean {
  if (input.reason !== 'manual' && input.lastDigest && input.digest === input.lastDigest) return false
  if (input.reason === 'manual' || input.reason === 'record') return true
  const interval = input.intervalMs ?? VERSION_INTERVAL_MS
  if (input.lastAt == null) return true
  return input.now - input.lastAt >= interval
}

/** Ids to drop once a project has more than `limit` named versions. Newest stay. */
export function expiredVersionIds(items: { id: string; at: number }[], limit = VERSION_LIMIT): string[] {
  const sorted = [...items].sort((left, right) => right.at - left.at || (left.id < right.id ? -1 : 1))
  return sorted.slice(Math.max(0, limit)).map((item) => item.id)
}

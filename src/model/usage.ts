/** Opus at its cap plus the low video layer. Bits per second of one published stream. */
export const STREAM_BPS = 510_000 + 100_000

export const CAP_NOTICE =
  "Cloudflare's monthly media limit was reached. This call is a direct connection (STUN only) until next month."

export interface UsageSnapshot {
  month: string
  bytes: number
  gigabytes: number
  capGigabytes: number
  blocked: boolean
}

/** Calendar month in UTC, `YYYY-MM`. */
export function monthKey(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${now.getUTCFullYear()}-${month}`
}

/** Decimal gigabytes, matching Cloudflare's 1,000 GB free-tier meter. */
export function capGigabytes(raw: string | undefined): number {
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return 500
  return value
}

export function capBytes(gigabytes: number): number {
  return Math.round(gigabytes * 1_000_000_000)
}

/**
 * Conservative Cloudflare egress for one interval.
 * SFU pulls (each subscriber receives every published stream) plus TURN relay
 * of the same media on the way up and on the way down. Counting both is
 * deliberate: the cap sits at half the free tier, and under-counting can bill.
 */
export function estimateBytesPerSecond(publishers: number, subscribers: number): number {
  const pubs = Math.max(0, publishers)
  const subs = Math.max(0, subscribers)
  const stream = STREAM_BPS / 8
  const sfuPulls = pubs * subs * stream
  const turnUp = pubs * stream
  const turnDown = pubs * subs * stream
  return sfuPulls + turnUp + turnDown
}

/** Credit whichever is larger. The same bytes are never added twice. */
export function creditSession(credited: number, reported: number, estimated: number): { credited: number; added: number } {
  const next = Math.max(0, credited, reported, estimated)
  return { credited: next, added: Math.max(0, next - Math.max(0, credited)) }
}

export function usageSnapshot(bytes: number, gigabytesCap: number, month: string): UsageSnapshot {
  const safeBytes = Math.max(0, Math.round(bytes))
  const cap = capBytes(gigabytesCap)
  return {
    month,
    bytes: safeBytes,
    gigabytes: Math.round((safeBytes / 1_000_000_000) * 1000) / 1000,
    capGigabytes: gigabytesCap,
    blocked: safeBytes >= cap,
  }
}

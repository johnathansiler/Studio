import { downloadBlob } from './format'

/** Phones use the system share sheet. Everywhere else copies the link. */
export async function shareSessionLink(
  url: string,
  input: {
    phone: boolean
    share?: (data: ShareData) => Promise<void>
    writeText?: (value: string) => Promise<void>
  },
): Promise<'shared' | 'copied' | 'aborted' | 'failed'> {
  const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> }
  const share = input.share ?? (input.phone ? nav.share?.bind(nav) : undefined)
  if (input.phone && typeof share === 'function') {
    try {
      await share({ title: 'CueHarbor session', url })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'aborted'
    }
  }
  const write = input.writeText ?? ((value: string) => navigator.clipboard.writeText(value))
  try {
    await write(url)
    return 'copied'
  } catch {
    return 'failed'
  }
}

/** Phones use the system share sheet. Everywhere else copies the link. */

export async function shareOrDownload(filename: string, blob: Blob, phone: boolean): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' })
  const nav = navigator as Navigator & { canShare?: (data?: ShareData) => boolean }
  if (phone && typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: filename.replace(/\.[^.]+$/, '') })
      return 'shared'
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared'
    }
  }
  downloadBlob(filename, blob)
  return 'downloaded'
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function ageLabel(savedAt: number) {
  const seconds = Math.max(0, (Date.now() - savedAt) / 1000)
  if (seconds < 60) return 'now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

/** The insert DSP chunk. AudioWorklet keeps a static import of createAll; the page loads this on demand. */

let pending: Promise<typeof import('./createAll')> | null = null

export function loadProcessors() {
  pending ??= import('./createAll')
  return pending
}

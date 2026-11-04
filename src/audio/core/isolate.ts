/** True only when COOP/COEP made SharedArrayBuffer available to this page. */
export function isolationAvailable() {
  return crossOriginIsolatedSafe() && typeof SharedArrayBuffer === 'function'
}

function crossOriginIsolatedSafe() {
  try {
    return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
  } catch {
    return false
  }
}

/** Tracks that must stay on the audio thread: notes, sample voices, or a sidechain. */
const LOCAL = new Set(['sampler', 'steps', 'pads', 'drums', 'drum-machine', 'synth'])

export function canOffloadChain(plugins: readonly { pluginId: string; sidechain?: string; enabled?: boolean }[]) {
  return plugins.every((plugin) => !LOCAL.has(plugin.pluginId) && !(plugin.enabled !== false && plugin.sidechain))
}

/**
 * Use the worker pool only when it finishes inside the quantum and beats one thread.
 * A slower pool would add dropouts, so the audio thread keeps the chain.
 */
export function adoptRealtime(sequentialMs: number, parallelMs: number, misses: number, budgetMs: number) {
  if (misses > 0) return false
  if (parallelMs <= 0 || sequentialMs <= 0) return false
  return parallelMs < sequentialMs && parallelMs < budgetMs
}

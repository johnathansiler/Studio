import type { PluginModule } from './types'

const loaders: Record<string, () => Promise<{ default: PluginModule }>> = {
  eq: () => import('./eq'),
  compressor: () => import('./compressor'),
  deesser: () => import('./deesser'),
  gate: () => import('./gate'),
  limiter: () => import('./limiter'),
  saturator: () => import('./saturator'),
  doubler: () => import('./doubler'),
  chorus: () => import('./chorus'),
  delay: () => import('./delay'),
  reverb: () => import('./reverb'),
  tune: () => import('./tune'),
  pitch: () => import('./pitch'),
  amp: () => import('./amp').then((mod) => ({ default: mod.ampModule() })),
}

const cache = new Map<string, PluginModule>()

export function pluginIds() {
  return Object.keys(loaders)
}

/** Load a plugin the first time it is inserted. Later calls reuse the module. */
export function peekModule(id: string) {
  return cache.get(id) ?? null
}

export async function loadModule(id: string): Promise<PluginModule | null> {
  const cached = cache.get(id)
  if (cached) return cached
  const loader = loaders[id]
  if (!loader) return null
  const imported = await loader()
  cache.set(id, imported.default)
  return imported.default
}

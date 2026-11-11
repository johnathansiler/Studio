import { CORE_IDS, targetOf } from './ids'
import type { PluginModule } from './types'

const loaders: Record<string, () => Promise<{ default: PluginModule }>> = Object.fromEntries(
  CORE_IDS.map((id) => [id, () => import('./createAll').then((mod) => ({ default: mod.moduleFor(id) }))]),
)

const cache = new Map<string, PluginModule>()

export function pluginIds() {
  return Object.keys(loaders)
}

/** Load a plugin the first time it is inserted. Later calls reuse the module. */
export function peekModule(id: string) {
  return cache.get(targetOf(id)) ?? null
}

export async function loadModule(id: string): Promise<PluginModule | null> {
  const core = targetOf(id)
  const cached = cache.get(core)
  if (cached) return cached
  const loader = loaders[core]
  if (!loader) return null
  const imported = await loader()
  cache.set(core, imported.default)
  return imported.default
}

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
  sampler: () => import('./sampler'),
  fet: () => import('./models').then((mod) => ({ default: mod.moduleFor('fet') })),
  opto: () => import('./models').then((mod) => ({ default: mod.moduleFor('opto') })),
  bus: () => import('./models').then((mod) => ({ default: mod.moduleFor('bus') })),
  vari: () => import('./models').then((mod) => ({ default: mod.moduleFor('vari') })),
  passive: () => import('./models').then((mod) => ({ default: mod.moduleFor('passive') })),
  pre: () => import('./models').then((mod) => ({ default: mod.moduleFor('pre') })),
  channel: () => import('./models').then((mod) => ({ default: mod.moduleFor('channel') })),
  prop: () => import('./models').then((mod) => ({ default: mod.moduleFor('prop') })),
  focus: () => import('./models').then((mod) => ({ default: mod.moduleFor('focus') })),
  tape: () => import('./models').then((mod) => ({ default: mod.moduleFor('tape') })),
  sum: () => import('./models').then((mod) => ({ default: mod.moduleFor('sum') })),
  plate: () => import('./models').then((mod) => ({ default: mod.moduleFor('plate') })),
  hall: () => import('./models').then((mod) => ({ default: mod.moduleFor('hall') })),
  conv: () => import('./models').then((mod) => ({ default: mod.moduleFor('conv') })),
  echo: () => import('./models').then((mod) => ({ default: mod.moduleFor('echo') })),
  bbd: () => import('./models').then((mod) => ({ default: mod.moduleFor('bbd') })),
  digital: () => import('./models').then((mod) => ({ default: mod.moduleFor('digital') })),
  ensemble: () => import('./models').then((mod) => ({ default: mod.moduleFor('ensemble') })),
  phase: () => import('./models').then((mod) => ({ default: mod.moduleFor('phase') })),
  rotor: () => import('./models').then((mod) => ({ default: mod.moduleFor('rotor') })),
  peak: () => import('./models').then((mod) => ({ default: mod.moduleFor('peak') })),
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

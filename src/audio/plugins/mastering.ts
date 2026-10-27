import { createBrick, createClip, createDither, createDynamicEq, createGlue, createImager, createMasterEq, createMasterMeter, createMaxim, createMs, createMultiband, createTape } from '../master/process'
import { descriptor, FACTORY } from './catalog'
import type { PluginModule, Processor } from './types'

const creators: Record<string, (sampleRate: number) => Processor> = {
  meq: createMasterEq,
  deq: createDynamicEq,
  mbcomp: createMultiband,
  glue: createGlue,
  brick: createBrick,
  maxim: createMaxim,
  mtape: createTape,
  image: createImager,
  msbox: createMs,
  clip: createClip,
  dither: () => createDither(),
  meter: createMasterMeter,
}

export function module(id: string): PluginModule {
  const spec = descriptor(id)
  const create = creators[id]
  if (!spec || !create) throw new Error(`Unknown mastering plugin ${id}`)
  return { descriptor: spec, presets: FACTORY[id] ?? [], create }
}

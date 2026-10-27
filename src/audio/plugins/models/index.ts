import type { PluginModule } from '../types'
import { busModule, fetModule, optoModule, peakModule, variModule } from './dynamics'
import { channelModule, focusModule, passiveModule, preModule, propModule } from './eqs'
import { sumModule, tapeModule } from './color'
import { bbdModule, convModule, digitalModule, echoModule, ensembleModule, hallModule, phaseModule, plateModule, rotorModule } from './space'

const modules: Record<string, () => PluginModule> = {
  fet: fetModule,
  opto: optoModule,
  bus: busModule,
  vari: variModule,
  peak: peakModule,
  passive: passiveModule,
  pre: preModule,
  channel: channelModule,
  prop: propModule,
  focus: focusModule,
  tape: tapeModule,
  sum: sumModule,
  plate: plateModule,
  hall: hallModule,
  conv: convModule,
  echo: echoModule,
  bbd: bbdModule,
  digital: digitalModule,
  ensemble: ensembleModule,
  phase: phaseModule,
  rotor: rotorModule,
}

export function moduleFor(id: string): PluginModule {
  const factory = modules[id]
  if (!factory) throw new Error(`Unknown model ${id}`)
  return factory()
}

export const MODEL_IDS = Object.keys(modules)

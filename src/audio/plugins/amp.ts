import { descriptor, FACTORY } from './catalog'
import { createAmpState, processAmp, resetAmpState } from './ampDsp'
import type { PluginModule, Processor } from './types'

export function createAmp(sampleRate: number): Processor {
  const state = createAmpState(sampleRate)
  const tuner = { hz: 0, cents: 0, note: 0 }
  return {
    latencySamples: 0,
    tuner,
    reset() {
      resetAmpState(state)
      tuner.hz = 0
      tuner.cents = 0
      tuner.note = 0
    },
    process(input, output, params, ctx) {
      processAmp(state, input, output, params, {
        sampleRate: ctx.sampleRate,
        tempo: ctx.tempo,
        quality: ctx.quality,
      })
      if (state.readout) {
        tuner.hz = state.readout.hz
        tuner.cents = state.readout.cents
        tuner.note = state.readout.note
      }
    },
  }
}

export function ampModule(): PluginModule {
  const spec = descriptor('amp')
  if (!spec) throw new Error('Amp is missing from the catalog')
  return {
    descriptor: spec,
    presets: FACTORY.amp ?? [],
    create: (sampleRate) => createAmp(sampleRate),
  }
}

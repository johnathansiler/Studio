/** Sampler/drums insert. Pad audio is voiced by the instrument; this slot stays transparent. */

import type { PluginModule, Processor } from './types'

function create(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let c = 0; c < output.length; c++) {
        const src = input[c] ?? input[0]
        if (src && output[c]) output[c].set(src)
      }
    },
  }
}

const mpc: PluginModule = {
  descriptor: { id: 'sampler-drums', name: 'Sampler/drums', version: '1', params: [] },
  presets: [],
  create,
}

export default mpc

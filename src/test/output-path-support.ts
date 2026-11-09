import type { Processor } from '../audio/plugins/types'

export function passthroughProcessor(): Processor {
  return {
    latencySamples: 0,
    reset() {},
    process(input, output) {
      for (let channel = 0; channel < output.length; channel++) {
        const src = input[Math.min(channel, input.length - 1)]
        if (src && output[channel]) output[channel].set(src)
      }
    },
  }
}

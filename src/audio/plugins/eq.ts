import { descriptor, FACTORY } from './catalog'
import { copyCoeffs, designBiquad, sanitize, tickBiquad, type Biquad } from './dsp'
import type { PluginModule, Processor } from './types'

const desc = descriptor('eq')!

export const presets = FACTORY.eq

export function create(sampleRate: number): Processor {
  const filters: Biquad[] = Array.from({ length: 10 }, () => designBiquad('peaking', sampleRate, 1000, 1, 0))
  const spectrum = new Float32Array(32)
  let designed = ''
  return {
    latencySamples: 0,
    spectrum,
    reset() {
      for (const filter of filters) {
        filter.x1 = filter.x2 = filter.y1 = filter.y2 = 0
      }
    },
    process(input, output, params, ctx) {
      const key = JSON.stringify(params)
      if (key !== designed) {
        const next = [
          designBiquad('highpass', ctx.sampleRate, params.hp, 0.7),
          designBiquad('lowshelf', ctx.sampleRate, params.lowF, params.lowQ, params.lowG),
          designBiquad('peaking', ctx.sampleRate, params.midF, params.midQ, params.midG),
          designBiquad('highshelf', ctx.sampleRate, params.highF, params.highQ, params.highG),
          designBiquad('lowpass', ctx.sampleRate, params.lp, 0.7),
        ]
        next.forEach((filter, index) => {
          copyCoeffs(filters[index], filter)
          copyCoeffs(filters[index + 5], filter)
        })
        designed = key
      }
      const n = input[0]?.length ?? 0
      for (let c = 0; c < output.length; c++) {
        const src = input[Math.min(c, input.length - 1)]
        const bank = c === 0 ? 0 : 5
        for (let i = 0; i < n; i++) {
          let sample = src?.[i] ?? 0
          for (let b = 0; b < 5; b++) sample = tickBiquad(filters[bank + b], sample)
          output[c][i] = sanitize(sample)
        }
      }
      if (ctx.quality === 'full') fillSpectrum(input[0], spectrum)
    },
  }
}

function fillSpectrum(input: Float32Array | undefined, spectrum: Float32Array) {
  if (!input) return
  const n = Math.min(input.length, 256)
  for (let bin = 0; bin < spectrum.length; bin++) {
    const freq = ((bin + 1) / spectrum.length) * Math.PI
    let real = 0
    let imag = 0
    for (let i = 0; i < n; i++) {
      real += (input[i] || 0) * Math.cos(freq * i)
      imag -= (input[i] || 0) * Math.sin(freq * i)
    }
    spectrum[bin] = Math.sqrt(real * real + imag * imag) / n
  }
}

const plugin: PluginModule = { descriptor: desc, presets, create }
export default plugin

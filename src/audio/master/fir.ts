/** FFT, linear-phase FIR, and 2x/4x oversampling. Linear-phase EQ stays on the offline bounce. */

export function fft(real: Float32Array, imag: Float32Array, inverse = false) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]
      real[i] = real[j]
      real[j] = tr
      const ti = imag[i]
      imag[i] = imag[j]
      imag[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI / len) * (inverse ? 1 : -1)
    const wlenR = Math.cos(ang)
    const wlenI = Math.sin(ang)
    const half = len >> 1
    for (let i = 0; i < n; i += len) {
      let wR = 1
      let wI = 0
      for (let j = 0; j < half; j++) {
        const uR = real[i + j]
        const uI = imag[i + j]
        const vR = real[i + j + half] * wR - imag[i + j + half] * wI
        const vI = real[i + j + half] * wI + imag[i + j + half] * wR
        real[i + j] = uR + vR
        imag[i + j] = uI + vI
        real[i + j + half] = uR - vR
        imag[i + j + half] = uI - vI
        const nextR = wR * wlenR - wI * wlenI
        wI = wR * wlenI + wI * wlenR
        wR = nextR
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n
      imag[i] /= n
    }
  }
}

/** Zero-phase magnitude sampled at FFT bins, shifted so the impulse sits in the center. */
export function linearKernel(magnitude: (freq: number) => number, sampleRate: number, size = 1024) {
  const real = new Float32Array(size)
  const imag = new Float32Array(size)
  for (let k = 0; k <= size / 2; k++) {
    const mag = magnitude((k * sampleRate) / size)
    const safe = Number.isFinite(mag) ? Math.max(0, mag) : 1
    real[k] = safe
    if (k > 0 && k < size / 2) real[size - k] = safe
  }
  fft(real, imag, true)
  const kernel = new Float32Array(size)
  const half = size / 2
  for (let i = 0; i < size; i++) kernel[i] = real[(i + half) % size] || 0
  return kernel
}

export function createFir(kernel: Float32Array) {
  const taps = kernel.length
  const history = new Float32Array(taps)
  return {
    /** Samples from the write index to the kernel center. */
    latency: taps / 2 - 1,
    reset() {
      history.fill(0)
    },
    process(input: Float32Array, output: Float32Array) {
      const n = input.length
      for (let i = 0; i < n; i++) {
        history.copyWithin(0, 1)
        history[taps - 1] = input[i] || 0
        let acc = 0
        for (let k = 0; k < taps; k++) acc += history[k] * kernel[k]
        output[i] = acc
      }
    },
  }
}

/** Windowed-sinc lowpass. `gain` is the DC gain. Cutoff is a fraction of this filter's sample rate. */
export function sincKernel(taps: number, cutoff: number, gain: number) {
  const kernel = new Float32Array(taps)
  const mid = (taps - 1) / 2
  let sum = 0
  for (let n = 0; n < taps; n++) {
    const x = n - mid
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x)
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / Math.max(1, taps - 1))
    kernel[n] = sinc * window
    sum += kernel[n]
  }
  const scale = sum === 0 ? 1 : gain / sum
  for (let n = 0; n < taps; n++) kernel[n] *= scale
  return kernel
}

export interface Oversample {
  factor: number
  latency: number
  reset(): void
  /** Upsample, run `shape` at the high rate, and downsample back to the block length. */
  process(input: Float32Array, output: Float32Array, shape: (sample: number) => number): void
}

export function createOversample(factor: 1 | 2 | 4, taps = 64): Oversample {
  if (factor === 1) {
    return {
      factor,
      latency: 0,
      reset() {},
      process(input, output, shape) {
        for (let i = 0; i < input.length; i++) output[i] = shape(input[i] || 0)
      },
    }
  }
  const up = sincKernel(taps, 0.5 / factor, factor)
  const down = sincKernel(taps, 0.5 / factor, 1)
  const upState = new Float32Array(taps)
  const downState = new Float32Array(taps)
  const group = Math.floor((taps - 1) / 2)
  return {
    factor,
    latency: Math.floor(group / factor) * 2,
    reset() {
      upState.fill(0)
      downState.fill(0)
    },
    process(input, output, shape) {
      const n = input.length
      let produced = 0
      const hold = new Float32Array(factor)
      let holdCount = 0
      const emit = (sample: number) => {
        downState.copyWithin(0, 1)
        downState[taps - 1] = sample
        hold[holdCount++] = sample
        if (holdCount < factor) return
        let acc = 0
        for (let k = 0; k < taps; k++) acc += downState[k] * down[k]
        if (produced < n) output[produced] = acc
        produced += 1
        holdCount = 0
      }
      for (let i = 0; i < n; i++) {
        for (let p = 0; p < factor; p++) {
          upState.copyWithin(0, 1)
          upState[taps - 1] = p === 0 ? (input[i] || 0) : 0
          let acc = 0
          for (let k = 0; k < taps; k++) acc += upState[k] * up[k]
          emit(shape(acc))
        }
      }
      for (let i = produced; i < n; i++) output[i] = 0
    },
  }
}

export function createDownsample(factor: 1 | 2 | 4, taps = 64) {
  if (factor === 1) {
    return {
      latency: 0,
      reset() {},
      process(input: Float32Array, output: Float32Array) {
        output.set(input.subarray(0, output.length))
      },
    }
  }
  const kernel = sincKernel(taps, 0.5 / factor, 1)
  const state = new Float32Array(taps)
  let hold = 0
  return {
    latency: Math.floor((taps - 1) / 2 / factor),
    reset() {
      state.fill(0)
      hold = 0
    },
    process(input: Float32Array, output: Float32Array) {
      let produced = 0
      for (let i = 0; i < input.length && produced < output.length; i++) {
        state.copyWithin(0, 1)
        state[taps - 1] = input[i] || 0
        hold += 1
        if (hold < factor) continue
        hold = 0
        let acc = 0
        for (let k = 0; k < taps; k++) acc += state[k] * kernel[k]
        output[produced] = acc
        produced += 1
      }
    },
  }
}

/** Peak of a 4x oversampled reconstruction, linear amplitude. */
export function truePeakLinear(channel: Float32Array, taps = 64) {
  const os = createOversample(4, taps)
  const out = new Float32Array(channel.length)
  let peak = 0
  os.process(channel, out, (sample) => {
    peak = Math.max(peak, Math.abs(sample))
    return sample
  })
  for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(out[i] || 0), Math.abs(channel[i] || 0))
  return peak
}

export function truePeakDb(channels: Float32Array[], taps = 64) {
  let peak = 0
  for (const channel of channels) peak = Math.max(peak, truePeakLinear(channel, taps))
  if (peak < 1e-8) return -70
  return 20 * Math.log10(peak)
}

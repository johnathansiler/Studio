/** In-place radix-2 FFT. `inverse` scales by 1/n. */
export function fft(re: Float64Array, im: Float64Array, inverse = false) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i]
      const ti = im[i]
      re[i] = re[j]
      im[i] = im[j]
      re[j] = tr
      im[j] = ti
    }
  }
  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wlenRe = Math.cos(ang)
    const wlenIm = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wRe = 1
      let wIm = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const j = i + k + half
        const vRe = re[j] * wRe - im[j] * wIm
        const vIm = re[j] * wIm + im[j] * wRe
        re[j] = re[i + k] - vRe
        im[j] = im[i + k] - vIm
        re[i + k] += vRe
        im[i + k] += vIm
        const nextRe = wRe * wlenRe - wIm * wlenIm
        wIm = wRe * wlenIm + wIm * wlenRe
        wRe = nextRe
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n
      im[i] /= n
    }
  }
}

export function hann(n: number) {
  const window = new Float64Array(n)
  for (let i = 0; i < n; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n)
  return window
}

export interface Spectrum {
  re: Float64Array[]
  im: Float64Array[]
}

export function frameCount(length: number, fftSize: number, hop: number) {
  if (length <= fftSize) return 1
  return Math.floor((length - fftSize) / hop) + 1
}

export function analyze(channel: Float32Array, fftSize: number, hop: number, window: Float64Array): Spectrum {
  const frames = frameCount(channel.length, fftSize, hop)
  const re: Float64Array[] = []
  const im: Float64Array[] = []
  for (let frame = 0; frame < frames; frame++) {
    const real = new Float64Array(fftSize)
    const imag = new Float64Array(fftSize)
    const start = frame * hop
    for (let i = 0; i < fftSize; i++) {
      const sample = channel[start + i] || 0
      real[i] = sample * window[i]
    }
    fft(real, imag, false)
    re.push(real)
    im.push(imag)
  }
  return { re, im }
}

export function synthesize(spec: Spectrum, length: number, fftSize: number, hop: number, window: Float64Array) {
  const acc = new Float64Array(length)
  const norm = new Float64Array(length)
  const frames = spec.re.length
  for (let frame = 0; frame < frames; frame++) {
    const real = Float64Array.from(spec.re[frame])
    const imag = Float64Array.from(spec.im[frame])
    fft(real, imag, true)
    const start = frame * hop
    for (let i = 0; i < fftSize; i++) {
      const at = start + i
      if (at >= length) break
      const w = window[i]
      acc[at] += real[i] * w
      norm[at] += w * w
    }
  }
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = norm[i] > 1e-8 ? acc[i] / norm[i] : 0
  return out
}

export function mirror(re: Float64Array, im: Float64Array) {
  const n = re.length
  im[0] = 0
  if (n % 2 === 0) im[n >> 1] = 0
  for (let k = 1; k < n >> 1; k++) {
    re[n - k] = re[k]
    im[n - k] = -im[k]
  }
}

/** In-place radix-2 complex FFT. `inverse` divides by n. Length must be a power of two. */

export function fft(real: Float32Array, imag: Float32Array, inverse = false) {
  const n = real.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = real[i]
      const ti = imag[i]
      real[i] = real[j]
      imag[i] = imag[j]
      real[j] = tr
      imag[j] = ti
    }
  }
  const sign = inverse ? 1 : -1
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len
    const wlenR = Math.cos(ang)
    const wlenI = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let wr = 1
      let wi = 0
      const half = len >> 1
      for (let k = 0; k < half; k++) {
        const ur = real[i + k]
        const ui = imag[i + k]
        const vr = real[i + k + half] * wr - imag[i + k + half] * wi
        const vi = real[i + k + half] * wi + imag[i + k + half] * wr
        real[i + k] = ur + vr
        imag[i + k] = ui + vi
        real[i + k + half] = ur - vr
        imag[i + k + half] = ui - vi
        const next = wr * wlenR - wi * wlenI
        wi = wr * wlenI + wi * wlenR
        wr = next
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

export function nextPow2(value: number) {
  let n = 1
  while (n < value) n <<= 1
  return n
}

export function hann(index: number, length: number) {
  if (length <= 1) return 1
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (length - 1))
}

/** Windowed magnitude spectrum, length n/2. */
export function magnitudeSpectrum(frame: Float32Array, n: number) {
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  const len = Math.min(n, frame.length)
  for (let i = 0; i < len; i++) real[i] = (frame[i] || 0) * hann(i, len)
  fft(real, imag, false)
  const bins = n >> 1
  const mag = new Float32Array(bins)
  for (let i = 0; i < bins; i++) mag[i] = Math.hypot(real[i], imag[i])
  return mag
}

/** Linear autocorrelation via FFT. `acf[tau]` sums `x[j] * x[j + tau]`. */
export function autocorrelate(frame: Float32Array) {
  const n = nextPow2(frame.length * 2)
  const real = new Float32Array(n)
  const imag = new Float32Array(n)
  real.set(frame)
  fft(real, imag, false)
  for (let i = 0; i < n; i++) {
    real[i] = real[i] * real[i] + imag[i] * imag[i]
    imag[i] = 0
  }
  fft(real, imag, true)
  return real.subarray(0, frame.length)
}

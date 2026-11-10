/**
 * PolyBLEP residuals for discontinuities in naive oscillators.
 * A few arithmetic ops at each edge, no oversampling and no added latency.
 */

export function polyBlep(phase: number, dt: number) {
  if (!(dt > 1e-8)) return 0
  const t = phase - Math.floor(phase)
  if (t < dt) {
    const x = t / dt
    return x + x - x * x - 1
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt
    return x * x + x + x + 1
  }
  return 0
}

/** How many sine partials stay under Nyquist. Eco caps the count so a phone voice stays cheap. */
export function partialsFor(dt: number, quality: 'full' | 'eco' = 'full') {
  const under = Math.floor(0.45 / Math.max(dt, 1e-8))
  const cap = quality === 'eco' ? 16 : 40
  return Math.max(1, Math.min(cap, under))
}

/** Saw from the Fourier series. Partials stop at Nyquist, so nothing folds back. */
export function additiveSaw(phase: number, partials: number) {
  const base = (phase - Math.floor(phase)) * Math.PI * 2
  const n = Math.max(1, partials | 0)
  let sum = 0
  for (let k = 1; k <= n; k++) sum += Math.sin(base * k) / k
  // 1.18 leaves the Gibbs peak under the naive ±1 saw so levels stay inside the voice trim.
  return (sum * 2) / Math.PI / 1.18
}

/** Square from odd partials, same Nyquist limit as the saw. */
export function additiveSquare(phase: number, partials: number) {
  const base = (phase - Math.floor(phase)) * Math.PI * 2
  const n = Math.max(1, partials | 0)
  let sum = 0
  for (let k = 1; k <= n; k += 2) sum += Math.sin(base * k) / k
  return (sum * 4) / Math.PI / 1.18
}

/** PolyBLEP saw. Phase 0 lands near a zero crossing. Used when a pulse width is not a square. */
export function blepSaw(phase: number, dt: number) {
  const p = phase - Math.floor(phase)
  return 2 * p - 1 - polyBlep(p, dt)
}

export function blepSquare(phase: number, dt: number) {
  const p = phase - Math.floor(phase)
  const other = p < 0.5 ? p + 0.5 : p - 0.5
  return (p < 0.5 ? 1 : -1) + polyBlep(p, dt) - polyBlep(other, dt)
}

export function blepPulse(phase: number, dt: number, width: number) {
  const p = phase - Math.floor(phase)
  const pw = Math.min(0.95, Math.max(0.05, width))
  const edge = p - pw
  const other = edge < 0 ? edge + 1 : edge
  return (p < pw ? 1 : -1) + polyBlep(p, dt) - polyBlep(other, dt)
}

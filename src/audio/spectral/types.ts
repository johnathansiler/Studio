/** Time is 0–1 across the repaired slice. Frequency is Hz. */
export interface SpectralPoint {
  t: number
  hz: number
}

export type SpectralTool = 'box' | 'lasso' | 'harmonic'
export type SpectralAction = 'attenuate' | 'heal' | 'declick' | 'dehum' | 'denoise'

export interface SpectralRegion {
  tool: SpectralTool
  points: SpectralPoint[]
  /** Harmonic partials, counting the fundamental as 1. */
  partials?: number
  /** Half-width of each partial, as a fraction of its frequency. */
  width?: number
}

export interface SpectralOp {
  id: string
  action: SpectralAction
  /** 0–1. 1 removes the selection. */
  amount: number
  region: SpectralRegion
  /** Mains frequency for de-hum. Omit to choose 50 or 60 Hz from the audio. */
  humHz?: number
}

/**
 * Non-destructive spectral edit. The source asset is never overwritten.
 * Playback uses a rendered copy while this stays enabled.
 */
export interface SpectralRepair {
  sourceBufferId: string
  /** Source sample where t = 0. */
  origin: number
  /** Source samples spanned by t = 1. */
  span: number
  enabled: boolean
  ops: SpectralOp[]
  /** Log-band magnitudes learned from a noise-only selection. */
  noiseBands?: number[]
  noiseRate?: number
  renderedKey?: string
  renderId?: string
}

export interface SpectralSettings {
  fftSize: number
  hop: number
}

/** Offline render. Overlap is 75% so a steady tone survives the round trip. */
export const HQ_SPECTRAL: SpectralSettings = { fftSize: 4096, hop: 1024 }

export const NOISE_BANDS = 64

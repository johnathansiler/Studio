/**
 * Key of one mono buffer.
 *
 * Harmonic pitch-class profile, A440, cosine window, spectral whitening,
 * 25–3500 Hz. The default profile is the Essentia EDMA pair. A reading under
 * the confidence gate is Unsure. Drums, one-shots, and noise stay unnamed.
 */

import type { KeyReading } from './clipKey'
import { readHpcpKey, type KeyProfile } from './hpcpKey'

export type { KeyProfile }

export interface KeyDetectOptions {
  profile?: KeyProfile
  /** Kept so older callers still type-check. The HPCP reader uses the whole buffer. */
  loop?: boolean
}

const PROFILES: KeyProfile[] = ['edma', 'temperley', 'krumhansl', 'blend']

function chosenProfile(options: KeyDetectOptions): KeyProfile {
  if (options.profile) return options.profile
  const env = typeof process !== 'undefined' ? process.env.CUE_KEY_PROFILE : ''
  if (env === 'edma' || env === 'temperley' || env === 'krumhansl' || env === 'blend') return env
  return 'edma'
}

export function estimateKey(samples: Float32Array, sampleRate: number, options: KeyDetectOptions = {}): KeyReading {
  return readHpcpKey(samples, sampleRate, chosenProfile(options))
}

/** One analysis pass per profile. The default shipped profile is EDMA. */
export function estimateProfiles(samples: Float32Array, sampleRate: number, _loop?: boolean): Record<KeyProfile, KeyReading> {
  const out = {} as Record<KeyProfile, KeyReading>
  for (const profile of PROFILES) out[profile] = readHpcpKey(samples, sampleRate, profile)
  return out
}

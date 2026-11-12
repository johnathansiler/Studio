import { allScales, registerScales } from './scales'
import type { ScaleSpec } from './types'

let pending: Promise<ScaleSpec[]> | null = null

/** Load ragas, maqamat, makam, dastgah, and the rest. Safe to call more than once. */
export function loadScaleCatalog(): Promise<ScaleSpec[]> {
  if (!pending) {
    pending = import('./catalog/world').then((mod) => {
      registerScales(mod.WORLD_SCALES)
      return allScales()
    })
  }
  return pending
}


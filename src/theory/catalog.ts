import { allScales, registerScales } from './scales'
import type { ScaleSpec } from './types'

let pending: Promise<ScaleSpec[]> | null = null
let loaded = false

/** Load ragas, maqamat, makam, dastgah, and the rest. Safe to call more than once. */
export function loadScaleCatalog(): Promise<ScaleSpec[]> {
  if (!pending) {
    pending = import('./catalog/world').then((mod) => {
      registerScales(mod.WORLD_SCALES)
      loaded = true
      return allScales()
    })
  }
  return pending
}

export function catalogLoaded() {
  return loaded
}

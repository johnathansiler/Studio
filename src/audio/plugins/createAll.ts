import type { Processor } from './types'
import { createCore } from './dispatch'
import { targetOf } from './ids'

/** Every insert, created inside the audio thread. The UI still loads plugins one at a time. */
export function createProcessor(id: string, sampleRate: number): Processor | null {
  try {
    return createCore(targetOf(id), sampleRate)
  } catch {
    return null
  }
}

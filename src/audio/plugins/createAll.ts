import type { Processor } from './types'
import { createCore } from './dispatch'
import { targetOf, type CoreId } from './ids'
import { wasmDspRequested } from '../wasm/flag'
import { createWasmInsert, wasmInsertSupported } from '../wasm/insert'

/** Every insert, created inside the audio thread. The UI still loads plugins one at a time. */
export function createProcessor(id: string, sampleRate: number): Processor | null {
  const core = targetOf(id)
  if (wasmDspRequested() && wasmInsertSupported(core)) {
    try {
      return createWasmInsert(core, sampleRate)
    } catch {
      return createFallback(core, sampleRate)
    }
  }
  return createFallback(core, sampleRate)
}

function createFallback(id: CoreId, sampleRate: number): Processor | null {
  try {
    return createCore(id, sampleRate)
  } catch {
    return null
  }
}

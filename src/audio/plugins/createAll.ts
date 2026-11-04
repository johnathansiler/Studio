import type { Processor } from './types'
import { createCore } from './dispatch'
import { targetOf, type CoreId } from './ids'
import { wasmDspRequested } from '../wasm/flag'
import { wasmInsertSupported } from '../wasm/codes'

type WasmFactory = (id: string, sampleRate: number) => Processor

let wasmFactory: WasmFactory | null = null
let wasmPreload: Promise<void> | null = null

/**
 * Load the Rust insert chunk. Returns immediately while the flag is off,
 * so a normal session never fetches `dspBytes`.
 * `createProcessor` stays synchronous: await this before building a flagged chain.
 */
export function preloadWasmInserts(): Promise<void> {
  if (!wasmDspRequested()) return Promise.resolve()
  if (wasmFactory) return Promise.resolve()
  wasmPreload ??= (async () => {
    const [{ loadDspWasmBytes }, insert] = await Promise.all([
      import('../wasm/engine'),
      import('../wasm/insert'),
    ])
    await loadDspWasmBytes()
    wasmFactory = insert.createWasmInsert
  })().catch((error: unknown) => {
    wasmPreload = null
    throw error
  })
  return wasmPreload
}

/** Every insert, created inside the audio thread. The UI still loads plugins one at a time. */
export function createProcessor(id: string, sampleRate: number): Processor | null {
  const core = targetOf(id)
  if (wasmDspRequested() && wasmFactory && wasmInsertSupported(core)) {
    try {
      return wasmFactory(core, sampleRate)
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

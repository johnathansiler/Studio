import type { Processor } from './types'
import { createCore } from './dispatch'

export { moduleFor } from './dispatch'
import { targetOf, type CoreId } from './ids'
import { wasmDspRequested } from '../wasm/flag'
import { wasmInsertSupported } from '../wasm/codes'

type WasmFactory = (id: string, sampleRate: number) => Processor

let wasmFactory: WasmFactory | null = null
let wasmSampler: ((sampleRate: number) => Processor) | null = null
let wasmPreload: Promise<void> | null = null
let wasmGaveUp = false

/**
 * Load the Rust insert chunk. Returns immediately for `?wasmDsp=0`.
 * A failed fetch or instantiate is swallowed so the TypeScript processors run instead.
 * `createProcessor` stays synchronous: await this before building a chain.
 */
export function preloadWasmInserts(): Promise<void> {
  if (!wasmDspRequested()) return Promise.resolve()
  if (wasmFactory || wasmGaveUp) return Promise.resolve()
  wasmPreload ??= (async () => {
    try {
      const [{ loadDspWasmBytes }, insert] = await Promise.all([
        import('../wasm/engine'),
        import('../wasm/insert'),
      ])
      await loadDspWasmBytes()
      const voices = await import('../wasm/voices')
      await voices.preloadVoices()
      wasmFactory = insert.createWasmInsert
      wasmSampler = voices.createWasmSampler
    } catch {
      wasmGaveUp = true
      wasmFactory = null
    }
  })()
  return wasmPreload
}

/** Every insert, created inside the audio thread. The UI still loads plugins one at a time. */
export function createProcessor(id: string, sampleRate: number): Processor | null {
  const core = targetOf(id)
  if (wasmDspRequested() && core === 'sampler' && wasmSampler) {
    try {
      return wasmSampler(sampleRate)
    } catch {
      return createFallback(core, sampleRate)
    }
  }
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

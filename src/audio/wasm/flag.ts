const FLAG = '__CUEHARBOR_WASM_DSP__'

type FlagGlobal = typeof globalThis & {
  [FLAG]?: boolean
  location?: { search?: string }
}

/** The Rust insert chain stays off unless a test or the page sets `?wasmDsp=1`. */
export function wasmDspRequested(global: FlagGlobal = globalThis as FlagGlobal): boolean {
  if (global[FLAG] === true) return true
  const search = global.location?.search
  if (!search) return false
  return new URLSearchParams(search).get('wasmDsp') === '1'
}

/**
 * Boot the WASM worklet only when the flag is on.
 * The import stays dynamic so a normal page load does not instantiate the module.
 */
export function maybeBootWasmDsp(): void {
  if (!wasmDspRequested()) return
  void import('./loader').then((mod) => mod.bootWasmDsp())
}

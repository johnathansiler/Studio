const FLAG = '__CUEHARBOR_WASM_DSP__'

type FlagGlobal = typeof globalThis & {
  [FLAG]?: boolean
  location?: { search?: string }
}

/**
 * The Rust insert chain is the website default.
 * `?wasmDsp=0` or `__CUEHARBOR_WASM_DSP__ === false` forces the TypeScript processors.
 * `?wasmDsp=1` still forces the Rust chain.
 */
export function wasmDspRequested(global: FlagGlobal = globalThis as FlagGlobal): boolean {
  const search = global.location?.search
  if (search) {
    const value = new URLSearchParams(search).get('wasmDsp')
    if (value === '0') return false
    if (value === '1') return true
  }
  if (global[FLAG] === false) return false
  if (global[FLAG] === true) return true
  return true
}

/**
 * The standalone EQ worklet is not the insert chain. Tests call this directly.
 * A normal page preloads the insert module instead.
 */

/**
 * Fetch the DSP chunk after the first gesture, and again when the browser is idle,
 * so Play is not the first thing that waits on it.
 */
export function scheduleWasmPreload(): void {
  if (typeof window === 'undefined') return
  if (!wasmDspRequested()) return
  let started = false
  const start = () => {
    if (started) return
    started = true
    void import('../plugins/createAll').then((mod) => mod.preloadWasmInserts()).catch(() => undefined)
  }
  const idle = window.requestIdleCallback
  if (typeof idle === 'function') idle(() => start(), { timeout: 1200 })
  else window.setTimeout(start, 300)
  window.addEventListener('pointerdown', start, { once: true, capture: true })
  window.addEventListener('keydown', start, { once: true, capture: true })
  window.addEventListener('touchstart', start, { once: true, capture: true })
}

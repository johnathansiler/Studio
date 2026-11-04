/** Plugin codes shared with `core/dsp/src/plugin.rs`. No WASM bytes live in this file. */
export const WASM_INSERTS: Record<string, number> = {
  tune: 0,
  eq: 1,
  compressor: 2,
  vocal: 3,
  saturator: 4,
  reverb: 5,
  delay: 6,
  mod: 7,
  limiter: 8,
  synth: 9,
  scaler: 10,
}

export function wasmInsertSupported(id: string) {
  return Object.prototype.hasOwnProperty.call(WASM_INSERTS, id)
}

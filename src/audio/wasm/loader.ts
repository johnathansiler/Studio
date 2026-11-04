import eqWorkletUrl from './eq.worklet.ts?worker&url'
import { wasmDspRequested } from './flag'

type AudioHost = typeof globalThis & {
  AudioContext?: typeof AudioContext
  AudioWorkletNode?: typeof AudioWorkletNode
}

/** Load the Rust EQ worklet. Returns null when `?wasmDsp=0` forces the TypeScript processors. */
export async function loadWasmEqWorklet(ctx: AudioContext): Promise<AudioWorkletNode | null> {
  if (!wasmDspRequested()) return null
  const HostNode = (globalThis as AudioHost).AudioWorkletNode
  if (!HostNode) return null
  await ctx.audioWorklet.addModule(eqWorkletUrl)
  return new HostNode(ctx, 'cueharbor-wasm-eq', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
  })
}

/** Standalone EQ worklet. The insert chain does not use this entry. */
export async function bootWasmDsp(): Promise<AudioWorkletNode | null> {
  if (!wasmDspRequested()) return null
  const HostContext = (globalThis as AudioHost).AudioContext
  if (!HostContext) return null
  return loadWasmEqWorklet(new HostContext())
}

declare module 'onnxruntime-web/wasm' {
  export const env: { wasm: { numThreads: number; wasmPaths: string; proxy: boolean } }
  export class Tensor {
    constructor(type: 'float32', data: Float32Array, dims: number[])
  }
  export class InferenceSession {
    static create(
      bytes: Uint8Array,
      options: { executionProviders: string[]; graphOptimizationLevel: 'disabled' | 'all' },
    ): Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: readonly number[] }>> }>
  }
}

declare module 'onnxruntime-web/webgpu' {
  export const env: { wasm: { numThreads: number; wasmPaths: string; proxy: boolean } }
  export class Tensor {
    constructor(type: 'float32', data: Float32Array, dims: number[])
  }
  export class InferenceSession {
    static create(
      bytes: Uint8Array,
      options: { executionProviders: string[]; graphOptimizationLevel: 'disabled' | 'all' },
    ): Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: readonly number[] }>> }>
  }
}

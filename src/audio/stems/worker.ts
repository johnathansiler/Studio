import { MODEL_RATE, modelFor, separateMix, type StemCheckpoint, type StemMode } from './engine'
import { loadWeights } from './load'
import { ORT_WASM_BASE } from './runtime'

interface StartMessage {
  type: 'start'
  channels: Float32Array[]
  sampleRate: number
  mode: StemMode
  shifts: number
  checkpoint?: StemCheckpoint
}

interface CancelMessage {
  type: 'cancel'
}

type OrtTensor = { data: Float32Array; dims: readonly number[] }
type OrtModule = {
  env: { wasm: { numThreads: number; wasmPaths: string; proxy: boolean } }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
  InferenceSession: { create: (bytes: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel: 'disabled' | 'all' }) => Promise<{ run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensor>> }> }
}

let cancel = false
let session: { run: (feeds: Record<string, unknown>) => Promise<Record<string, OrtTensor>> } | null = null
let sessionUrl = ''
let tensorCtor: OrtModule['Tensor'] | null = null

function post(message: Record<string, unknown>, transfer: Transferable[] = []) {
  self.postMessage(message, { transfer })
}

async function runtime(webgpu: boolean): Promise<OrtModule> {
  const ort = (webgpu ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm')) as unknown as OrtModule
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = ORT_WASM_BASE
  return ort
}

async function openSession(bytes: ArrayBuffer, webgpu: boolean) {
  try {
    const ort = await runtime(webgpu)
    tensorCtor = ort.Tensor
    return await ort.InferenceSession.create(new Uint8Array(bytes), {
      executionProviders: webgpu ? ['webgpu', 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'disabled',
    })
  } catch (error) {
    if (!webgpu) throw error
    const ort = await runtime(false)
    tensorCtor = ort.Tensor
    return ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'], graphOptimizationLevel: 'disabled' })
  }
}

function unpack(tensor: OrtTensor): Float32Array[][] {
  const stems = tensor.dims[1] ?? 0
  const channels = tensor.dims[2] ?? 2
  const samples = tensor.dims[3] ?? 0
  const data = tensor.data
  const out: Float32Array[][] = []
  for (let stem = 0; stem < stems; stem++) {
    const pair: Float32Array[] = []
    for (let channel = 0; channel < channels; channel++) {
      const start = ((stem * channels) + channel) * samples
      pair.push(data.slice(start, start + samples))
    }
    out.push(pair)
  }
  return out
}

self.onmessage = (event: MessageEvent<StartMessage | CancelMessage>) => {
  const message = event.data
  if (message.type === 'cancel') {
    cancel = true
    return
  }
  cancel = false
  void run(message)
}

async function run(message: StartMessage) {
  const started = performance.now()
  try {
    const model = modelFor(message.mode)
    if (!session || sessionUrl !== model.url) {
      const weights = await loadWeights(message.mode, (received, total) => {
        post({ type: 'progress', phase: 'download', ratio: total ? received / total : 0, received, total, eta: '' })
      })
      const webgpu = typeof navigator !== 'undefined' && 'gpu' in navigator
      session = await openSession(weights, webgpu)
      sessionUrl = model.url
    }
    const active = session
    const Tensor = tensorCtor
    if (!active || !Tensor) throw new Error('Model session failed')
    const signal = { cancelled: false }
    const result = await separateMix(message.channels, message.sampleRate, message.mode, async (stereo) => {
      if (cancel) signal.cancelled = true
      const length = stereo[0].length
      const packed = new Float32Array(2 * length)
      packed.set(stereo[0], 0)
      packed.set(stereo[1], length)
      const output = await active.run({ mix: new Tensor('float32', packed, [1, 2, length]) })
      const tensor = output.stems ?? Object.values(output)[0]
      if (!tensor) throw new Error('Model returned no stems')
      return unpack(tensor)
    }, {
      shifts: message.shifts,
      checkpoint: message.checkpoint,
      signal,
      onProgress: (done, total) => {
        const elapsed = (performance.now() - started) / 1000
        const per = done > 0 ? elapsed / done : 0
        const eta = per * Math.max(0, total - done)
        post({ type: 'progress', phase: 'separate', ratio: done / total, received: done, total, eta: String(eta) })
      },
    })
    if (result.checkpoint) {
      const acc = result.checkpoint.acc
      const weight = result.checkpoint.weight
      const shiftSum = result.checkpoint.shiftSum
      const transfer = [acc.buffer, weight.buffer]
      if (shiftSum) transfer.push(shiftSum.buffer)
      post({ type: 'paused', checkpoint: result.checkpoint }, transfer)
      return
    }
    const stems = result.stems ?? []
    const transfer = stems.flatMap((stem) => stem.map((channel) => channel.buffer))
    post({ type: 'done', stems, sampleRate: message.sampleRate || MODEL_RATE }, transfer)
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : 'Stem separation failed' })
  }
}

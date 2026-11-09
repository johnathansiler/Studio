import { createSamplePool } from '../audio/voices/engine'

/**
 * One decoded zone through the sampler voice pool.
 * The pool is the Rust/WASM voice when that module is loaded, and the TypeScript voice otherwise.
 * Multi-sample notes, velocity, and round-robin stay on the TypeScript sampler.
 */
export function renderPitchedZone(options: {
  pcm: Float32Array
  fileRate: number
  sampleRate: number
  root: number
  note: number
  velocity?: number
  releaseAt?: number
  frames: number
}) {
  const frames = Math.max(1, options.frames | 0)
  const pool = createSamplePool(options.sampleRate)
  pool.load(1, options.pcm, options.fileRate)
  const pad = pool.pad(0)
  pad.setRegion(1, 0, options.pcm.length)
  pad.setPitch(Math.round(options.note) - Math.round(options.root), 0, 'vinyl')
  pad.setHold(true)
  pad.setFade(32, 32)
  const releaseAt = options.releaseAt == null ? frames + 1 : Math.max(0, options.releaseAt | 0)
  const velocity = options.velocity ?? 0.8
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  const block = 2048
  let started = false
  let released = releaseAt > frames
  for (let offset = 0; offset < frames; offset += block) {
    const count = Math.min(block, frames - offset)
    if (!started) {
      pool.note(0, 0, velocity)
      started = true
    }
    if (!released && releaseAt >= offset && releaseAt < offset + count) {
      pool.note(releaseAt - offset, 0, 0)
      released = true
    }
    pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
  }
  return left
}

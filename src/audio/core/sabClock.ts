/**
 * Shared block slots for a realtime mix. No DOM and no Web Audio types.
 * The audio callback publishes a quantum and later collects the worker output.
 * Workers wait on the doorbell. A missed block keeps the last output.
 */

export const SAB_TRACKS = 16
export const SAB_FRAMES = 2048

const HEADER = 4
const META = 4
const PLANES = 4

export function sabByteLength(tracks = SAB_TRACKS, frames = SAB_FRAMES) {
  return (HEADER + tracks * META + tracks * frames * PLANES) * 4
}

export function createSab(tracks = SAB_TRACKS, frames = SAB_FRAMES) {
  const sab = new SharedArrayBuffer(sabByteLength(tracks, frames))
  const ints = new Int32Array(sab)
  ints[0] = frames
  ints[1] = tracks
  return sab
}

export function sabInts(sab: SharedArrayBuffer) {
  return new Int32Array(sab)
}

function framesOf(ints: Int32Array) {
  return ints[0] || SAB_FRAMES
}

function tracksOf(ints: Int32Array) {
  return ints[1] || SAB_TRACKS
}

function floatBase(tracks: number) {
  return HEADER + tracks * META
}

export function statusIndex(track: number) {
  return HEADER + track * META
}

export function bellIndex() {
  return 2
}

function planeIndex(track: number, plane: number, frames: number, tracks: number) {
  return floatBase(tracks) + (track * PLANES + plane) * frames
}

/** Copy a quantum in and ring the workers. Does not wait. */
export function publishTrack(sab: SharedArrayBuffer, track: number, left: Float32Array, right: Float32Array, frames: number) {
  const ints = sabInts(sab)
  const count = tracksOf(ints)
  const cap = framesOf(ints)
  if (track < 0 || track >= count || frames <= 0 || frames > cap) return false
  const floats = new Float32Array(sab)
  const base = planeIndex(track, 0, cap, count)
  floats.set(left.subarray(0, frames), base)
  floats.set(right.subarray(0, frames), base + cap)
  ints[statusIndex(track) + 1] = frames
  Atomics.store(ints, statusIndex(track), 1)
  Atomics.add(ints, bellIndex(), 1)
  Atomics.notify(ints, bellIndex(), 1)
  return true
}

export type TakeResult = 'ready' | 'warming' | 'miss' | 'busy'

/** Copy a finished quantum out. `busy` means the worker still holds the slot. */
export function takeTrack(sab: SharedArrayBuffer, track: number, left: Float32Array, right: Float32Array, frames: number): TakeResult {
  const ints = sabInts(sab)
  const count = tracksOf(ints)
  const cap = framesOf(ints)
  if (track < 0 || track >= count) return 'miss'
  const state = Atomics.load(ints, statusIndex(track))
  if (state === 1) return 'busy'
  if (state !== 2) return 'warming'
  const floats = new Float32Array(sab)
  const base = planeIndex(track, 2, cap, count)
  const n = Math.min(frames, cap, left.length)
  left.set(floats.subarray(base, base + n))
  right.set(floats.subarray(base + cap, base + cap + n))
  Atomics.store(ints, statusIndex(track), 0)
  return 'ready'
}

export function claimTrack(sab: SharedArrayBuffer, track: number) {
  const ints = sabInts(sab)
  if (Atomics.load(ints, statusIndex(track)) !== 1) return null
  const cap = framesOf(ints)
  const count = tracksOf(ints)
  const frames = ints[statusIndex(track) + 1] || cap
  const floats = new Float32Array(sab)
  const inL = planeIndex(track, 0, cap, count)
  const outL = planeIndex(track, 2, cap, count)
  return {
    frames,
    input: [floats.subarray(inL, inL + frames), floats.subarray(inL + cap, inL + cap + frames)],
    output: [floats.subarray(outL, outL + frames), floats.subarray(outL + cap, outL + cap + frames)],
  }
}

export function finishTrack(sab: SharedArrayBuffer, track: number) {
  const ints = sabInts(sab)
  Atomics.store(ints, statusIndex(track), 2)
  Atomics.notify(ints, statusIndex(track), 1)
}

/** Publish every track, then wait until the workers finish or the timeout hits. */
export function blockingStep(sab: SharedArrayBuffer, inputs: Float32Array[][], timeoutMs: number) {
  const started = performance.now()
  for (let track = 0; track < inputs.length; track++) {
    const pair = inputs[track]
    publishTrack(sab, track, pair[0], pair[1] ?? pair[0], pair[0].length)
  }
  const publishMs = performance.now() - started
  const waited = performance.now()
  const outputs: Float32Array[][] = []
  let misses = 0
  for (let track = 0; track < inputs.length; track++) {
    const frames = inputs[track][0].length
    const left = new Float32Array(frames)
    const right = new Float32Array(frames)
    const done = waitForTrack(sab, track, timeoutMs)
    const took = takeTrack(sab, track, left, right, frames)
    if (!done || took !== 'ready') misses += 1
    outputs.push([left, right])
  }
  return { outputs, misses, publishMs, waitMs: performance.now() - waited }
}

export function waitForTrack(sab: SharedArrayBuffer, track: number, timeoutMs: number) {
  const ints = sabInts(sab)
  const index = statusIndex(track)
  const start = Date.now()
  while (Atomics.load(ints, index) !== 2) {
    if (Date.now() - start > timeoutMs) return false
    Atomics.wait(ints, index, 1, Math.max(0, timeoutMs - (Date.now() - start)))
  }
  return true
}

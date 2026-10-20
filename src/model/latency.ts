/** NTP offset. hostPerf ≈ guestPerf + offset. */
export function ntpOffset(t0: number, t1: number, t2: number, t3: number): { rtt: number; offset: number } {
  const rtt = t3 - t0 - (t2 - t1)
  const offset = (t1 - t0 + (t2 - t3)) / 2
  return { rtt, offset }
}

export function bestClockSample(samples: { rtt: number; offset: number }[]): { rtt: number; offset: number } | null {
  if (!samples.length) return null
  return samples.reduce((best, sample) => (sample.rtt < best.rtt ? sample : best))
}

/**
 * Fit performance.now() ≈ perfAtCtx0 + ctxTimeSeconds * 1000.
 * A fresh single-point fit tracks drift better than a long average.
 */
export function fitPerfAtContextZero(samples: { ctx: number; perf: number }[]): number {
  if (!samples.length) return 0
  const last = samples[samples.length - 1]
  return last.perf - last.ctx * 1000
}

export function perfAtContextTime(perfAtCtx0: number, ctxTime: number): number {
  return perfAtCtx0 + ctxTime * 1000
}

export function contextTimeAtPerf(perfAtCtx0: number, perf: number): number {
  return (perf - perfAtCtx0) / 1000
}

export interface OneWayEstimateInput {
  rttMs: number
  jitterBufferMs: number
  ptimeMs: number
  outputLatencyMs: number
  /** Measured tap-to-playout, when an audio ping succeeded. Excludes speaker output. */
  audioPingMs?: number | null
  pcmNetworkMs?: number | null
  pcmTargetMs?: number
  mode: 'opus' | 'pcm'
}

/**
 * Delay from the cue tap (pre-speaker) to the guest's ear.
 * Opus packetization is counted as half a frame (the average) with ±ptime/2 uncertainty.
 */
export function estimateCueOneWayMs(input: OneWayEstimateInput): { ms: number; uncertaintyMs: number; source: string } {
  if (input.mode === 'pcm' && input.pcmNetworkMs != null) {
    const target = input.pcmTargetMs ?? 20
    return {
      ms: input.pcmNetworkMs + target + input.outputLatencyMs,
      uncertaintyMs: 5,
      source: 'pcm',
    }
  }
  if (input.audioPingMs != null && input.audioPingMs >= 0) {
    return {
      ms: input.audioPingMs + input.outputLatencyMs,
      uncertaintyMs: 4,
      source: 'audio-ping',
    }
  }
  const halfFrame = input.ptimeMs / 2
  return {
    ms: input.rttMs / 2 + halfFrame + Math.max(0, input.jitterBufferMs) + input.outputLatencyMs,
    uncertaintyMs: halfFrame + 3,
    source: 'stats',
  }
}

export interface AlignedWindow {
  guestPerfStart: number
  guestPerfEnd: number
  placeAtSample: number
  compensationMs: number
}

/**
 * Map a host timeline record range to the guest capture clock.
 * The singer hears the cue late and the mic captures them later still.
 * Shifting the take earlier by that path makes the printed vocal line up
 * with the music they sang to, independent of network delay.
 */
export function alignedRecordWindow(args: {
  recordStartSample: number
  recordEndSample: number
  sampleRate: number
  cueEpochHostPerfMs: number
  cueEpochTimelineSample: number
  oneWayCueMs: number
  guestInputLatencyMs: number
  clockOffsetMs: number
}): AlignedWindow {
  const sampleToHostPerf = (sample: number) =>
    args.cueEpochHostPerfMs + ((sample - args.cueEpochTimelineSample) / args.sampleRate) * 1000
  const compensation = args.oneWayCueMs + args.guestInputLatencyMs
  const captureHostStart = sampleToHostPerf(args.recordStartSample) + compensation
  const captureHostEnd = sampleToHostPerf(args.recordEndSample) + compensation
  return {
    guestPerfStart: captureHostStart - args.clockOffsetMs,
    guestPerfEnd: captureHostEnd - args.clockOffsetMs,
    placeAtSample: args.recordStartSample,
    compensationMs: compensation,
  }
}

export function shiftPlacementForLateBuffer(
  placeAtSample: number,
  expectedGuestPerf: number,
  actualGuestPerf: number,
  sampleRate: number,
): number {
  const lateMs = actualGuestPerf - expectedGuestPerf
  return Math.round(placeAtSample + (lateMs * sampleRate) / 1000)
}

export function jamDelays(
  jamEnabled: boolean,
  jamDelayMs: number,
  oneWayMs: number,
): { localMonitorMs: number; remoteExtraMs: number } {
  if (!jamEnabled) return { localMonitorMs: 0, remoteExtraMs: 0 }
  const delay = Math.max(0, jamDelayMs)
  return {
    localMonitorMs: delay,
    remoteExtraMs: Math.max(0, delay - Math.max(0, oneWayMs)),
  }
}

/** Peak picker for a loopback or cue ping. Returns the sample offset of the strongest peak. */
export function findPeakOffset(recorded: Float32Array, playedAtSample: number, searchFrom = 0): number {
  let max = 0
  let idx = playedAtSample
  const start = Math.max(0, searchFrom)
  for (let i = start; i < recorded.length; i++) {
    const a = Math.abs(recorded[i])
    if (a > max) {
      max = a
      idx = i
    }
  }
  return idx - playedAtSample
}

export interface TimedPeak {
  perf: number
  mag: number
}

/**
 * Pair expected impulse times with detected peaks and return the median extra delay.
 * expectedGuestPerf is when the impulse would arrive with zero added delay.
 */
export function matchPingDelay(peaks: TimedPeak[], expectedGuestPerfs: number[], toleranceMs = 80): number | null {
  if (!peaks.length || !expectedGuestPerfs.length) return null
  const delays: number[] = []
  const used = new Set<number>()
  for (const expected of expectedGuestPerfs) {
    let best = -1
    let bestAbs = toleranceMs
    for (let i = 0; i < peaks.length; i++) {
      if (used.has(i)) continue
      const d = peaks[i].perf - expected
      const ad = Math.abs(d)
      if (d >= -10 && ad < bestAbs) {
        bestAbs = ad
        best = i
      }
    }
    if (best >= 0) {
      used.add(best)
      delays.push(peaks[best].perf - expected)
    }
  }
  if (delays.length < Math.min(3, expectedGuestPerfs.length)) return null
  delays.sort((a, b) => a - b)
  const mid = Math.floor(delays.length / 2)
  return delays.length % 2 ? delays[mid] : (delays[mid - 1] + delays[mid]) / 2
}

export function encodePcmFrame(seq: number, senderPerfMs: number, samples: Float32Array): ArrayBuffer {
  const buf = new ArrayBuffer(12 + samples.length * 4)
  const view = new DataView(buf)
  view.setUint32(0, seq >>> 0)
  view.setFloat64(4, senderPerfMs)
  new Float32Array(buf, 12).set(samples)
  return buf
}

export function decodePcmFrame(buf: ArrayBuffer): { seq: number; senderPerfMs: number; samples: Float32Array } | null {
  if (buf.byteLength < 12 || (buf.byteLength - 12) % 4 !== 0) return null
  const view = new DataView(buf)
  const samples = new Float32Array(buf.slice(12))
  return { seq: view.getUint32(0), senderPerfMs: view.getFloat64(4), samples }
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

export interface SliceChunk {
  /** performance.now() of the first sample */
  perfStart: number
  data: Float32Array
  right?: Float32Array
  sampleRate: number
}

export function sliceChunksByPerf(chunks: SliceChunk[], perfStart: number, perfEnd: number): { audio: Float32Array; right?: Float32Array; actualPerfStart: number } | null {
  if (perfEnd <= perfStart || !chunks.length) return null
  const sampleRate = chunks[0].sampleRate
  const spans = chunks
    .filter((c) => c.data.length)
    .map((c) => ({
      ...c,
      perfEnd: c.perfStart + (c.data.length / c.sampleRate) * 1000,
    }))
    .sort((a, b) => a.perfStart - b.perfStart)
  const covering = spans.filter((c) => c.perfEnd > perfStart && c.perfStart < perfEnd)
  if (!covering.length) return null
  const actual = Math.max(perfStart, covering[0].perfStart)
  const end = Math.min(perfEnd, covering[covering.length - 1].perfEnd)
  if (end <= actual) return null
  const total = Math.max(1, Math.round(((end - actual) / 1000) * sampleRate))
  const out = new Float32Array(total)
  const stereo = covering.some((chunk) => chunk.right && chunk.right.length)
  const right = stereo ? new Float32Array(total) : undefined
  for (const chunk of covering) {
    const chunkStartSample = Math.round(((chunk.perfStart - actual) / 1000) * sampleRate)
    const from = Math.max(0, Math.round(((actual - chunk.perfStart) / 1000) * sampleRate))
    let o = Math.max(0, chunkStartSample)
    for (let i = from; i < chunk.data.length && o < out.length; i++, o++) out[o] = chunk.data[i]
    if (right && chunk.right) {
      let r = Math.max(0, chunkStartSample)
      for (let i = from; i < chunk.right.length && r < right.length; i++, r++) right[r] = chunk.right[i]
    }
  }
  return { audio: out, right, actualPerfStart: actual }
}

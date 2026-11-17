/**
 * Output the speaker hears after Chrome's device callback.
 * When the context rate matches the hardware, each callback is copied.
 * When it does not, Chrome restarts the resampler kernel at the callback
 * boundary. That restart is one click per buffer, about 21 ms at 1024 frames
 * and 48 kHz. The graph tap on desktop never sees it: the click is after the
 * context, in the output resampler.
 */

export function renderDeviceOutput(input: Float32Array, contextRate: number, deviceRate: number, callbackFrames: number): Float32Array {
  const from = contextRate > 0 ? contextRate : deviceRate
  const to = deviceRate > 0 ? deviceRate : from
  const frames = Math.max(1, callbackFrames | 0)
  const outLen = Math.max(1, Math.round(input.length * to / from))
  const out = new Float32Array(outLen)
  if (from === to) {
    out.set(input.subarray(0, Math.min(input.length, outLen)))
    return out
  }
  const step = from / to
  let pos = 0
  for (let start = 0; start < outLen; start += frames) {
    const count = Math.min(frames, outLen - start)
    for (let i = 0; i < count; i++) {
      const at = pos
      const i0 = Math.floor(at)
      const frac = at - i0
      const prev = i < 4 ? 0 : sampleAt(input, i0)
      const next = sampleAt(input, i0 + 1)
      out[start + i] = prev + (next - prev) * frac
      pos += step
    }
  }
  return out
}

function sampleAt(input: Float32Array, index: number) {
  if (index < 0 || index >= input.length) return 0
  return input[index] || 0
}

/** Centers of second-difference spikes, clustered so one click is one event. */
export function clickEvents(buffer: Float32Array, threshold = 0.05, cluster = 8) {
  let peak = 0
  for (let i = 0; i < buffer.length; i++) peak = Math.max(peak, Math.abs(buffer[i] || 0))
  if (!(peak > 0)) return []
  const hits: number[] = []
  let last = -cluster - 1
  for (let i = 2; i < buffer.length; i++) {
    const rel = Math.abs((buffer[i] || 0) - 2 * (buffer[i - 1] || 0) + (buffer[i - 2] || 0)) / peak
    if (rel <= threshold || i - last <= cluster) continue
    hits.push(i)
    last = i
  }
  return hits
}

export function medianGap(events: number[]) {
  if (events.length < 2) return 0
  const gaps = []
  for (let i = 1; i < events.length; i++) gaps.push(events[i] - events[i - 1])
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] || 0
}

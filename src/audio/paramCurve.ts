export interface RampParam {
  value?: number
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
  setTargetAtTime?(value: number, time: number, timeConstant: number): void
}

/** About 10 ms. Long enough to hide zipper noise, short enough to feel immediate. */
export const PARAM_SMOOTH_SEC = 0.01

/**
 * Move an existing AudioParam to `value` without rebuilding the graph.
 * The current value is anchored, then a 5–15 ms exponential approach lands on the target.
 */
export function smoothParam(param: RampParam, value: number, now: number, seconds = PARAM_SMOOTH_SEC) {
  const target = Number.isFinite(value) ? value : 0
  const current = typeof param.value === 'number' && Number.isFinite(param.value) ? param.value : target
  const time = Number.isFinite(now) ? now : 0
  const tau = Math.min(0.015, Math.max(0.005, seconds))
  param.cancelScheduledValues(time)
  param.setValueAtTime(current, time)
  if (Math.abs(current - target) < 1e-5) return
  if (param.setTargetAtTime) param.setTargetAtTime(target, time, tau)
  else param.linearRampToValueAtTime(target, time + tau)
}

/**
 * One audio block of the same 5–15 ms approach `smoothParam` writes onto an AudioParam.
 * Plugin and instrument worklets use this so a knob does not click and does not add latency.
 */
export function glideValue(from: number, to: number, frames: number, rate: number, seconds = PARAM_SMOOTH_SEC) {
  const start = Number.isFinite(from) ? from : to
  const target = Number.isFinite(to) ? to : start
  if (Math.abs(start - target) < 1e-6) return target
  const tau = Math.min(0.015, Math.max(0.005, seconds))
  const alpha = 1 - Math.exp(-Math.max(1, frames) / Math.max(1, tau * (rate || 48000)))
  return start + (target - start) * alpha
}

/** Sample-accurate line between automation breakpoints on an AudioParam clock. */
export function applyRamps(param: RampParam, events: { time: number; value: number }[], now: number) {
  if (!events.length) return
  param.cancelScheduledValues(now)
  const firstTime = Math.max(now, events[0].time)
  param.setValueAtTime(events[0].value, firstTime)
  let prev = firstTime
  for (let i = 1; i < events.length; i++) {
    const time = Math.max(events[i].time, prev + 0.0001)
    param.linearRampToValueAtTime(events[i].value, time)
    prev = time
  }
}

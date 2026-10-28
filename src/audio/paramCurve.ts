export interface RampParam {
  cancelScheduledValues(time: number): void
  setValueAtTime(value: number, time: number): void
  linearRampToValueAtTime(value: number, time: number): void
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

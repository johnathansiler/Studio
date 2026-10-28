import { LiveCaptureBuffer, type CapturedClip } from '../model/midiTools'

const buffer = new LiveCaptureBuffer()
let enabled = true
let performanceOwns = false

/** The drum/keys deck handles notes itself while it is open. */
export function setPerformanceOwnsMidi(on: boolean) {
  performanceOwns = on
}

export function performanceOwnsMidi() {
  return performanceOwns
}

export function setCaptureEnabled(on: boolean) {
  enabled = on
  if (!on) buffer.clear()
}

export function captureEnabled() {
  return enabled
}

export function rememberPlayed(trackId: string, notes: { pitch: number; startBeat: number; durationBeats: number; velocity: number }[]) {
  if (!enabled || !notes.length) return
  buffer.add(trackId, notes)
}

export function rememberOn(trackId: string, pitch: number, beat: number, velocity: number) {
  if (!enabled) return
  buffer.noteOn(trackId, pitch, beat, velocity)
}

export function rememberOff(trackId: string, pitch: number, beat: number) {
  if (!enabled) return
  buffer.noteOff(trackId, pitch, beat)
}

export function recallCapture(trackId: string | null, nowBeat: number, windowBeats: number): CapturedClip | null {
  return buffer.clip(trackId, nowBeat, windowBeats)
}

export function captureLatest(trackId: string | null) {
  return buffer.latest(trackId)
}

export function clearCapture(trackId?: string) {
  buffer.clear(trackId)
}

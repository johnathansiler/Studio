/**
 * Shared live-input and playback gain, timing, and limiting.
 * Live notes start at AudioContext.currentTime. Playback of the same note
 * uses these same levels so the two paths stay in the linear range.
 */

export const ATTACK_SEC = 0.004
export const RELEASE_SEC = 0.005
/** Built-in synth voice, about -23 dB. Matches the transport oscillator. */
export const BUILTIN_PEAK = 0.07
/** Drum one-shot into the strip. About -12 dB at full velocity. */
export const DRUM_PEAK = 0.25
/** Pattern drums already sit near -13 dB. */
export const PATTERN_DRUM_PEAK = 0.22
export const DEDUPE_SEC = 0.008
export const MAX_LIVE_VOICES = 16
export const LIVE_QUANTUM = 128

export function clamp01(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/** Slightly eased curve. Full velocity stays at 1 so recorded notes do not jump. */
export function velocityCurve(velocity: number) {
  const v = clamp01(velocity)
  return v ** 1.05
}

export function builtinLevel(velocity: number) {
  return Math.max(0.001, BUILTIN_PEAK * velocityCurve(velocity))
}

export function drumLevel(velocity: number) {
  return Math.max(0.001, DRUM_PEAK * velocityCurve(velocity))
}

/** Live notes are due now. No lookahead. */
export function liveWhen(now: number) {
  return now
}

/** Seconds the scheduler waits after the event. Zero means the block that is already due. */
export function scheduleDelaySeconds(when: number, now: number) {
  if (!Number.isFinite(when) || !Number.isFinite(now)) return 0
  return Math.max(0, when - now)
}

/**
 * Drop a second note-on for the same pitch inside a few milliseconds.
 * A later note-on, or one after a note-off, still retriggers.
 */
export function acceptNoteOn(last: Map<number, number>, pitch: number, time: number, windowSec = DEDUPE_SEC) {
  const midi = Math.round(pitch)
  const prev = last.get(midi)
  if (prev != null && time >= prev && time - prev < windowSec) return false
  last.set(midi, time)
  return true
}

export function clearNote(last: Map<number, number>, pitch: number) {
  last.delete(Math.round(pitch))
}

/**
 * Identity at and below `knee`. Above it, a smooth approach to `ceiling`
 * with no downward jump (the old tanh handoff fell from ~0.98 to ~0.75).
 */
export function transparentLimit(sample: number, knee = 0.98, ceiling = 1) {
  if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0
  const a = Math.abs(sample)
  if (a <= knee) return sample
  const span = Math.max(1e-4, ceiling - knee)
  const limited = knee + span * Math.tanh((a - knee) / span)
  return Math.sign(sample) * Math.min(ceiling, limited)
}

/** Keep |x| <= 1 unchanged. Overs approach full scale instead of collapsing. */
export function continuousCeiling(sample: number) {
  if (!Number.isFinite(sample) || Math.abs(sample) < 1e-15) return 0
  const a = Math.abs(sample)
  if (a <= 1) return sample
  const limited = 1 + 0.02 * Math.tanh((a - 1) / 0.02)
  return Math.sign(sample) * Math.min(1.02, limited)
}

export interface RenderedNote {
  audio: Float32Array
  peak: number
  scheduleDelay: number
}

/**
 * One built-in voice, live or from the transport.
 * `kind` selects the start time: live is sample 0, playback is the same
 * render placed on the same clock. The waveform is the transport saw
 * envelope, not a separate live oscillator.
 */
export function renderMatchedNote(
  kind: 'live' | 'playback',
  pitch: number,
  velocity: number,
  sampleRate: number,
  frames: number,
  now = 0,
): RenderedNote {
  const when = kind === 'live' ? liveWhen(now) : now
  const delay = scheduleDelaySeconds(when, now)
  const start = Math.round(delay * sampleRate)
  const audio = renderSaw(pitch, builtinLevel(velocity), sampleRate, frames, start)
  let peak = 0
  for (let i = 0; i < audio.length; i++) {
    audio[i] = transparentLimit(audio[i])
    const a = Math.abs(audio[i])
    if (a > peak) peak = a
  }
  return { audio, peak, scheduleDelay: delay }
}

export function renderSaw(pitch: number, peak: number, sampleRate: number, frames: number, start = 0) {
  const out = new Float32Array(frames)
  const hz = 440 * 2 ** ((pitch - 69) / 12)
  const attack = Math.max(1, Math.round(ATTACK_SEC * sampleRate))
  let phase = 0
  for (let i = 0; i < frames; i++) {
    const n = i - start
    if (n < 0) continue
    const env = n < attack ? 0.0001 * (peak / 0.0001) ** (n / Math.max(1, attack)) : peak
    phase += hz / sampleRate
    phase -= Math.floor(phase)
    const saw = 2 * phase - 1
    out[i] = saw * env
  }
  return out
}

/** Sum deduped voices and keep the mix under the safety ceiling. */
export function mixMatchedNotes(
  notes: { pitch: number; velocity: number; at?: number }[],
  sampleRate: number,
  frames: number,
) {
  const mix = new Float32Array(frames)
  const seen = new Map<number, number>()
  let voices = 0
  for (const note of notes) {
    const at = note.at ?? 0
    if (!acceptNoteOn(seen, note.pitch, at)) continue
    if (voices >= MAX_LIVE_VOICES) break
    voices += 1
    const one = renderSaw(note.pitch, builtinLevel(note.velocity), sampleRate, frames, Math.round(at * sampleRate))
    for (let i = 0; i < frames; i++) mix[i] += one[i]
  }
  let peak = 0
  let clipped = 0
  for (let i = 0; i < frames; i++) {
    const limited = transparentLimit(mix[i])
    if (Math.abs(mix[i]) > 1) clipped += 1
    mix[i] = limited
    const a = Math.abs(limited)
    if (a > peak) peak = a
  }
  return { mix, peak, voices, clipped }
}

export function attackReached(audio: Float32Array, sampleRate: number, ratio = 0.5) {
  let peak = 0
  for (let i = 0; i < audio.length; i++) peak = Math.max(peak, Math.abs(audio[i]))
  const mark = peak * ratio
  for (let i = 0; i < audio.length; i++) {
    if (Math.abs(audio[i]) >= mark) return i / sampleRate
  }
  return -1
}

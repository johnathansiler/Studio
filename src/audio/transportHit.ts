/**
 * Pattern hits the transport plays: oscillators, resident drums, and the shared noise buffer.
 * AudioEngine.scheduleHit and the bounce both call this.
 */

import { notePanGains } from './level'
import type { RenderedHit } from '../model/steps'

export function connectNotePan(ctx: BaseAudioContext, source: AudioNode, dest: AudioNode, pan: number): AudioNode[] {
  const gains = notePanGains(pan)
  if (gains.left === 1 && gains.right === 1) {
    source.connect(dest)
    return []
  }
  if (typeof ctx.createChannelMerger === 'function' && typeof ctx.createGain === 'function') {
    const left = ctx.createGain()
    const right = ctx.createGain()
    left.channelCountMode = 'explicit'
    right.channelCountMode = 'explicit'
    left.channelCount = 1
    right.channelCount = 1
    left.gain.value = gains.left
    right.gain.value = gains.right
    const merge = ctx.createChannelMerger(2)
    source.connect(left)
    source.connect(right)
    left.connect(merge, 0, 0)
    right.connect(merge, 0, 1)
    merge.connect(dest)
    return [left, right, merge]
  }
  if (typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, Number.isFinite(pan) ? pan : 0))
    source.connect(panner)
    panner.connect(dest)
    return [panner]
  }
  source.connect(dest)
  return []
}

export function startTransportHit(opts: {
  ctx: BaseAudioContext
  destination: AudioNode
  hit: RenderedHit
  when: number
  dur: number
  noise: AudioBuffer
  resident: AudioBuffer | null
  hold?: (end: number, nodes: AudioNode[]) => void
}) {
  const { ctx, destination, hit, when, noise, resident, hold } = opts
  const dur = opts.dur
  if (hit.kind === 'kick') {
    // A realtime frequency ramp is k-rate and an offline ramp is per-sample, so the
    // sweep's phase drifts. Both paths play this buffer instead.
    const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
    const data = renderKick(ctx.sampleRate, dur, peak)
    const buffer = ctx.createBuffer(1, data.length, ctx.sampleRate)
    buffer.getChannelData(0).set(data)
    const src = ctx.createBufferSource()
    src.buffer = buffer
    connectNotePan(ctx, src, destination, hit.pan || 0)
    src.start(when)
    const end = when + data.length / ctx.sampleRate
    src.stop(end)
    hold?.(end + 0.03, [src])
    return
  }
  if (hit.kind === 'perc') {
    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = 440 * 2 ** ((hit.pitch - 69) / 12)
    envelope(ctx, osc, when, Math.min(0.16, dur), hit, undefined, destination, hold)
    return
  }
  if (hit.kind === 'openhat' || hit.kind === 'tom' || hit.kind === 'cymbal') {
    if (resident && playResident(ctx, resident, hit, when, destination, hold)) return
    if (hit.kind === 'tom') {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      const freq = Math.max(70, 80 * 2 ** ((hit.pitch - 36) / 24))
      osc.frequency.setValueAtTime(freq * 1.4, when)
      osc.frequency.exponentialRampToValueAtTime(Math.max(45, freq), when + 0.18)
      envelope(ctx, osc, when, Math.min(0.35, Math.max(0.12, dur * 2)), hit, undefined, destination, hold)
      return
    }
    const ring = ctx.createBufferSource()
    ring.buffer = noise
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = hit.kind === 'cymbal' ? 5000 : 6500
    ring.connect(filter)
    envelope(ctx, filter, when, hit.kind === 'cymbal' ? 0.7 : 0.5, hit, ring, destination, hold)
    return
  }
  const source = ctx.createBufferSource()
  source.buffer = noise
  if (hit.kind === 'hat') {
    const filter = ctx.createBiquadFilter()
    filter.type = 'highpass'
    filter.frequency.value = 7000
    source.connect(filter)
    envelope(ctx, filter, when, Math.min(0.06, dur), hit, source, destination, hold)
    return
  }
  if (hit.kind === 'clap') {
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.value = 1400
    source.connect(filter)
    envelope(ctx, filter, when, Math.min(0.18, dur), hit, source, destination, hold)
    return
  }
  const tone = ctx.createOscillator()
  tone.type = 'triangle'
  tone.frequency.value = 190
  const filter = ctx.createBiquadFilter()
  filter.type = 'highpass'
  filter.frequency.value = 800
  source.connect(filter)
  envelope(ctx, filter, when, Math.min(0.16, dur), hit, source, destination, hold)
  envelope(ctx, tone, when, 0.08, { ...hit, velocity: hit.velocity * 0.4 }, undefined, destination, hold)
}

/** Sample-accurate 160 Hz to 48 Hz kick, including the transport envelope. */
function renderKick(sampleRate: number, dur: number, peak: number) {
  const ramp = Math.max(0.02, Math.min(0.18, dur))
  const envDur = Math.min(0.28, dur + 0.05)
  const release = Math.max(0.03, envDur)
  const stop = envDur + 0.02
  const count = Math.max(1, Math.ceil(stop * sampleRate))
  const out = new Float32Array(count)
  const f0 = 160
  const f1 = 48
  let phase = 0
  for (let i = 0; i < count; i++) {
    const t = i / sampleRate
    const swept = t < ramp ? f0 * (f1 / f0) ** (t / ramp) : f1
    const attack = 0.005
    let gain = peak
    if (t < attack) gain = 0.0001 * (peak / 0.0001) ** (t / attack)
    else gain = peak * (0.0001 / peak) ** ((t - attack) / (release - attack))
    out[i] = Math.sin(phase) * gain
    phase += (2 * Math.PI * swept) / sampleRate
    if (phase > Math.PI * 2) phase -= Math.PI * 2
  }
  return out
}

function playResident(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  hit: RenderedHit,
  when: number,
  into: AudioNode,
  hold?: (end: number, nodes: AudioNode[]) => void,
) {
  const src = ctx.createBufferSource()
  const gain = ctx.createGain()
  src.buffer = buffer
  const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.003)
  src.connect(gain)
  const panNodes = connectNotePan(ctx, gain, into, hit.pan || 0)
  const gate = Math.max(0.08, Math.min(1, (hit.durationBeats || 0.2) / 0.2))
  src.start(when)
  const end = when + Math.max(0.05, buffer.duration * gate)
  src.stop(end)
  hold?.(end + 0.03, [src, gain, ...panNodes])
  return true
}

function envelope(
  ctx: BaseAudioContext,
  source: AudioNode,
  when: number,
  dur: number,
  hit: Pick<RenderedHit, 'velocity' | 'pan' | 'volume'>,
  extra: AudioNode | undefined,
  into: AudioNode,
  hold?: (end: number, nodes: AudioNode[]) => void,
) {
  const gain = ctx.createGain()
  const peak = Math.max(0.001, 0.22 * hit.velocity * Math.max(0, hit.volume ?? 1))
  gain.gain.setValueAtTime(0.0001, when)
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.005)
  gain.gain.exponentialRampToValueAtTime(0.0001, when + Math.max(0.03, dur))
  source.connect(gain)
  const panNodes = connectNotePan(ctx, gain, into, hit.pan || 0)
  const startable = source as AudioScheduledSourceNode
  const end = when + dur + 0.02
  if (typeof startable.start === 'function') {
    startable.start(when)
    startable.stop(end)
  }
  const extraSource = extra as AudioScheduledSourceNode | undefined
  if (extraSource && typeof extraSource.start === 'function') extraSource.start(when)
  if (extraSource && typeof extraSource.stop === 'function') extraSource.stop(end)
  if (hold) {
    const chain: AudioNode[] = [source, gain, ...panNodes]
    if (extra && extra !== source) chain.push(extra)
    hold(end + 0.03, chain)
  }
}

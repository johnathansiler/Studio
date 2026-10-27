import { describe, expect, it } from 'vitest'
import {
  detectBpm,
  detectTransients,
  peakIndex,
  pitchFactor,
  preferStretchCache,
  quantizeMarkerTargets,
  renderStretch,
  renderStretchBlocks,
  renderTempoFollow,
  samplesAtBeat,
  timeStretch,
} from '../audio/stretch/engine'
import { yinPitch } from '../audio/stretch/voice'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

function sine(freq: number, seconds: number, sampleRate: number) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return data
}

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

function hzOf(channel: Float32Array, sampleRate: number, expectHz: number) {
  const start = Math.floor(channel.length * 0.35)
  const frame = channel.subarray(start, start + 4096)
  const pitch = yinPitch(frame, sampleRate, Math.max(40, expectHz / 2), expectHz * 2)
  return pitch.hz
}

function smear(channel: Float32Array, sampleRate: number) {
  const at = peakIndex(channel)
  const radius = Math.round(sampleRate * 0.005)
  let energy = 0
  let inside = 0
  for (let i = 0; i < channel.length; i++) {
    const value = (channel[i] || 0) * (channel[i] || 0)
    energy += value
    if (Math.abs(i - at) <= radius) inside += value
  }
  return energy > 0 ? 1 - inside / energy : 0
}

describe('time stretch', () => {
  const rate = 48000

  it('keeps the requested length within 1 ms', () => {
    const input = sine(440, 0.5, rate)
    for (const ratio of [0.5, 1, 1.37, 2]) {
      const output = renderStretch([input], rate, { ratio, mode: 'tonal' })
      const expected = Math.round(input.length * ratio)
      expect(Math.abs(output[0].length - expected)).toBeLessThanOrEqual(1)
      expect(Math.abs(output[0].length - expected) / rate).toBeLessThan(0.001)
    }
  })

  it('preserves sine pitch within a few cents', () => {
    const input = sine(440, 0.6, rate)
    const output = renderStretch([input], rate, { ratio: 1.5, mode: 'tonal' })
    const hz = hzOf(output[0], rate, 440)
    expect(Math.abs(cents(hz, 440))).toBeLessThan(8)
  })

  it('transposes without changing length', () => {
    const input = sine(440, 0.6, rate)
    const output = renderStretch([input], rate, { ratio: 1, semitones: 2, mode: 'tonal' })
    expect(output[0].length).toBe(input.length)
    const hz = hzOf(output[0], rate, 440 * pitchFactor(2))
    expect(Math.abs(cents(hz, 440 * pitchFactor(2)))).toBeLessThan(12)
    const voice = renderStretch([sine(220, 0.7, rate)], rate, { ratio: 1, semitones: 3, mode: 'voice' })
    const voiced = hzOf(voice[0], rate, 220 * pitchFactor(3))
    expect(Math.abs(cents(voiced, 220 * pitchFactor(3)))).toBeLessThan(12)
    expect(voice[0].length).toBe(Math.round(0.7 * rate))
  })

  it('keeps a drum transient tighter than a tonal stretch', () => {
    const input = new Float32Array(rate)
    input[12000] = 1
    const beats = timeStretch(input, Math.round(rate * 1.5), 'beats', rate)
    const tonal = timeStretch(input, Math.round(rate * 1.5), 'tonal', rate)
    expect(smear(beats, rate)).toBeLessThan(0.08)
    expect(smear(beats, rate)).toBeLessThan(smear(tonal, rate))
  })

  it('matches a one-shot render when audio arrives in blocks', () => {
    const input = sine(330, 0.4, rate)
    const options = { ratio: 1.25, semitones: 1, mode: 'tonal' as const }
    const offline = renderStretch([input], rate, options)
    const live = renderStretchBlocks([input], rate, options, 192)
    expect(live[0].length).toBe(offline[0].length)
    let max = 0
    for (let i = 0; i < offline[0].length; i++) max = Math.max(max, Math.abs(offline[0][i] - live[0][i]))
    expect(max).toBeLessThan(1e-5)
  })

  it('lands a source beat on the project beat when tempo changes', () => {
    const input = new Float32Array(rate)
    input[24000] = 1
    const steady = renderTempoFollow(input, rate, 120, 60, [], 0, 'beats')
    expect(Math.abs(peakIndex(steady) - 48000)).toBeLessThan(rate * 0.001)
    const changed = renderTempoFollow(input, rate, 120, 120, [{ beat: 1, bpm: 60 }], 0, 'beats')
    input[36000] = 1
    const later = new Float32Array(rate)
    later[36000] = 1
    const moved = renderTempoFollow(later, rate, 120, 120, [{ beat: 1, bpm: 60 }], 0, 'beats')
    expect(Math.abs(peakIndex(moved) - 48000)).toBeLessThan(rate * 0.001)
    expect(samplesAtBeat(2, rate, 120, [{ beat: 0, bpm: 120 }, { beat: 1, bpm: 60 }])).toBeCloseTo(72000, 0)
    expect(changed.length).toBeGreaterThan(24000)
  })

  it('detects tempo and snaps warp markers', () => {
    const clicks = new Float32Array(rate * 2)
    for (let beat = 0; beat < 4; beat++) clicks[beat * Math.round(rate / 2)] = 1
    expect(detectBpm(clicks, rate)).toBe(120)
    expect(detectTransients(clicks, rate).length).toBeGreaterThan(2)
    const markers = quantizeMarkerTargets(
      [{ id: 'a', source: 0, target: 0 }, { id: 'b', source: 100, target: 0.3 }],
      0.25,
      1,
    )
    expect(markers[1].target).toBeCloseTo(0.25, 5)
  })

  it('caches stretched playback only when a phone is out of cpu', () => {
    expect(preferStretchCache(true, 0.8)).toBe(true)
    expect(preferStretchCache(true, 0.4)).toBe(false)
    expect(preferStretchCache(false, 0.9)).toBe(false)
  })

  it('undoes a pitch-preserving edge stretch', () => {
    const store = new ProjectStore(createEmptyProject(rate))
    const track = store.project.tracks[1]
    store.addAudioClip(track.id, {
      id: 'clip',
      name: 'Loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: 48000,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    })
    store.stretchClip(track.id, 'clip', 'end', 96000)
    const stretched = store.project.tracks[1].clips[0]
    expect(stretched.durationSamples).toBe(96000)
    expect(stretched.stretch?.sourceSamples).toBe(48000)
    expect(stretched.stretch?.mode).not.toBe('tape')
    store.undo()
    expect(store.project.tracks[1].clips[0].durationSamples).toBe(48000)
    expect(store.project.tracks[1].clips[0].stretch).toBeUndefined()
  })
})

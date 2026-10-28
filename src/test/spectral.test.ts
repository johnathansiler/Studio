import { describe, expect, it } from 'vitest'
import { spectralKey } from '../audio/spectral/edit'
import { regionContains } from '../audio/spectral/mask'
import { goertzelPower, renderSpectral, learnNoise } from '../audio/spectral/process'
import { HQ_SPECTRAL, type SpectralRegion, type SpectralRepair, type SpectralSettings } from '../audio/spectral/types'
import { heat, hzAt } from '../audio/spectral/display'
import { createEmptyProject, type AudioClip } from '../model/types'
import { arrangementDigest } from '../model/sessionSync'
import { selectSpectral } from '../state/select'
import { ProjectStore } from '../state/store'

const FAST: SpectralSettings = { fftSize: 512, hop: 128 }

function sine(freq: number, seconds: number, sampleRate: number, amp = 0.5) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return data
}

function mix(parts: Float32Array[]) {
  const out = new Float32Array(parts[0].length)
  for (const part of parts) for (let i = 0; i < out.length; i++) out[i] += part[i] || 0
  return out
}

function snr(original: Float32Array, rendered: Float32Array, skip: number) {
  let signal = 0
  let noise = 0
  const end = Math.min(original.length, rendered.length) - skip
  for (let i = skip; i < end; i++) {
    const err = original[i] - rendered[i]
    signal += original[i] * original[i]
    noise += err * err
  }
  return 10 * Math.log10(signal / Math.max(1e-12, noise))
}

function box(t0: number, t1: number, hz0: number, hz1: number): SpectralRegion {
  return { tool: 'box', points: [{ t: t0, hz: hz0 }, { t: t1, hz: hz1 }] }
}

function repair(region: SpectralRegion, action: SpectralRepair['ops'][number]['action'], amount = 1, extra: Partial<SpectralRepair> = {}): SpectralRepair {
  return {
    sourceBufferId: 'src',
    origin: 0,
    span: 1,
    enabled: true,
    noiseBands: extra.noiseBands,
    noiseRate: extra.noiseRate,
    ops: [{ id: 'op', action, amount, region, humHz: extra.ops?.[0]?.humHz }],
  }
}

describe('spectral repair', () => {
  it('round-trips a sine at the offline quality setting', () => {
    const rate = 8000
    const input = sine(440, 0.35, rate)
    const output = renderSpectral([input], rate, repair(box(0, 1, 20, 3000), 'attenuate', 0), FAST)
    expect(output[0].length).toBe(input.length)
    expect(snr(input, output[0], FAST.fftSize)).toBeGreaterThan(45)
  })

  it('attenuates a boxed tone and leaves the other', () => {
    const rate = 8000
    const input = mix([sine(440, 0.4, rate, 0.4), sine(2000, 0.4, rate, 0.4)])
    const output = renderSpectral([input], rate, repair(box(0, 1, 1500, 2600), 'attenuate', 1), FAST)[0]
    expect(goertzelPower(output, rate, 2000)).toBeLessThan(goertzelPower(input, rate, 2000) * 0.05)
    expect(goertzelPower(output, rate, 440)).toBeGreaterThan(goertzelPower(input, rate, 440) * 0.5)
  })

  it('heals a gap from the surrounding tone', () => {
    const rate = 8000
    const input = sine(440, 0.5, rate, 0.6)
    const broken = Float32Array.from(input)
    const gap0 = 1600
    const gap1 = 2200
    for (let i = gap0; i < gap1; i++) broken[i] = 0
    const output = renderSpectral([broken], rate, repair(box(gap0 / input.length, gap1 / input.length, 30, 3000), 'heal', 1), { fftSize: 256, hop: 64 })[0]
    let before = 0
    let after = 0
    for (let i = gap0; i < gap1; i++) {
      before += (input[i] - broken[i]) ** 2
      after += (input[i] - output[i]) ** 2
    }
    expect(after).toBeLessThan(before * 0.45)
  })

  it('removes a click without taking the tone with it', () => {
    const rate = 8000
    const input = sine(440, 0.4, rate, 0.25)
    const clicked = Float32Array.from(input)
    const at = 1600
    clicked[at] = 1
    clicked[at + 1] = -1
    clicked[at + 2] = 1
    const output = renderSpectral([clicked], rate, repair(box(0.2, 0.8, 20, 3900), 'declick', 1), FAST)[0]
    let peak = 0
    for (let i = at - 2; i <= at + 4; i++) peak = Math.max(peak, Math.abs(output[i]))
    expect(peak).toBeLessThan(0.55)
    expect(goertzelPower(output, rate, 440)).toBeGreaterThan(goertzelPower(input, rate, 440) * 0.5)
  })

  it('notches hum and keeps a nearby musical tone', () => {
    const rate = 8000
    const input = mix([sine(50, 0.7, rate, 0.45), sine(440, 0.7, rate, 0.35)])
    const output = renderSpectral([input], rate, repair(box(0, 1, 20, 3900), 'dehum', 1), FAST)[0]
    const midIn = input.subarray(800, input.length - 800)
    const midOut = output.subarray(800, output.length - 800)
    expect(goertzelPower(midOut, rate, 50)).toBeLessThan(goertzelPower(midIn, rate, 50) * 0.08)
    expect(goertzelPower(midOut, rate, 440)).toBeGreaterThan(goertzelPower(midIn, rate, 440) * 0.6)
  })

  it('learns a noise profile and improves the tone', () => {
    const rate = 8000
    const tone = sine(880, 0.6, rate, 0.35)
    const noisy = Float32Array.from(tone)
    let seed = 5
    const next = () => {
      seed = (seed * 16807) % 2147483647
      return seed / 2147483647 * 2 - 1
    }
    for (let i = 0; i < noisy.length; i++) noisy[i] += next() * 0.12
    for (let i = 0; i < 1600; i++) noisy[i] = next() * 0.12
    const profileRegion = box(0.02, 0.16, 40, 3900)
    const bands = learnNoise([noisy], rate, profileRegion, FAST)
    expect(bands).toHaveLength(64)
    expect(bands.some((value) => value > 0)).toBe(true)
    const output = renderSpectral([noisy], rate, repair(box(0, 1, 30, 3900), 'denoise', 1, { noiseBands: bands, noiseRate: rate }), FAST)[0]
    const lateIn = noisy.subarray(2400)
    const lateOut = output.subarray(2400)
    const toneIn = goertzelPower(lateIn, rate, 880)
    const toneOut = goertzelPower(lateOut, rate, 880)
    const restIn = energy(lateIn) - toneShare(lateIn, rate, 880)
    const restOut = energy(lateOut) - toneShare(lateOut, rate, 880)
    expect(toneOut / Math.max(1e-9, restOut)).toBeGreaterThan((toneIn / Math.max(1e-9, restIn)) * 1.4)
  })

  it('selects harmonic ridges and a lasso', () => {
    const harmonic: SpectralRegion = { tool: 'harmonic', partials: 4, width: 0.03, points: [{ t: 0.1, hz: 100 }, { t: 0.8, hz: 100 }] }
    expect(regionContains(harmonic, 0.4, 100)).toBe(true)
    expect(regionContains(harmonic, 0.4, 300)).toBe(true)
    expect(regionContains(harmonic, 0.4, 150)).toBe(false)
    expect(regionContains(harmonic, 0.02, 100)).toBe(false)
    const lasso: SpectralRegion = {
      tool: 'lasso',
      points: [
        { t: 0.2, hz: 200 },
        { t: 0.8, hz: 200 },
        { t: 0.5, hz: 800 },
      ],
    }
    expect(regionContains(lasso, 0.5, 400)).toBe(true)
    expect(regionContains(lasso, 0.5, 1200)).toBe(false)
    expect(hzAt(1, 100, 1000)).toBeCloseTo(100, 0)
    expect(hzAt(0, 100, 1000)).toBeCloseTo(1000, 0)
    expect(heat(-80)[1]).toBeLessThan(heat(-10)[0])
  })

  it('follows a harmonic selection when attenuating', () => {
    const rate = 8000
    const input = mix([sine(200, 0.45, rate, 0.3), sine(400, 0.45, rate, 0.3), sine(550, 0.45, rate, 0.3)])
    const region: SpectralRegion = { tool: 'harmonic', partials: 3, width: 0.04, points: [{ t: 0, hz: 200 }, { t: 1, hz: 200 }] }
    const output = renderSpectral([input], rate, repair(region, 'attenuate', 1), FAST)[0]
    expect(goertzelPower(output, rate, 200)).toBeLessThan(goertzelPower(input, rate, 200) * 0.2)
    expect(goertzelPower(output, rate, 400)).toBeLessThan(goertzelPower(input, rate, 400) * 0.2)
    expect(goertzelPower(output, rate, 550)).toBeGreaterThan(goertzelPower(input, rate, 550) * 0.55)
  })

  it('keeps the source, swaps playback, and undoes', () => {
    const rate = 8000
    const channel = mix([sine(440, 0.3, rate, 0.4), sine(1800, 0.3, rate, 0.4)])
    const original = Float32Array.from(channel)
    const project = createEmptyProject(rate)
    const track = project.tracks.find((item) => item.type === 'audio')!
    const clip: AudioClip = {
      id: 'clip-repair',
      name: 'Take',
      bufferId: 'src-1',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: channel.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    }
    track.clips = [clip]
    const store = new ProjectStore(project, new Map([['src-1', { id: 'src-1', name: 'Take', sampleRate: rate, channels: [channel] }]]))
    store.openSpectral(track.id, clip.id)
    expect(selectSpectral(store).clip?.id).toBe(clip.id)
    const before = arrangementDigest(store.project)
    store.applySpectralOp(track.id, clip.id, 'attenuate', box(0, 1, 1200, 2600), 1)
    expect(arrangementDigest(store.project)).not.toBe(before)
    const edited = store.track(track.id)!.clips[0]
    const rendered = renderSpectral([original], rate, { ...edited.spectral!, ops: edited.spectral!.ops }, FAST)
    store.installSpectral(track.id, clip.id, rendered, rate, spectralKey(edited.spectral!))
    const source = store.buffers.get('src-1')!.channels[0]
    for (let i = 0; i < original.length; i += 50) expect(source[i]).toBe(original[i])
    expect(store.track(track.id)!.clips[0].bufferId.startsWith('spec_')).toBe(true)
    expect(goertzelPower(store.buffers.get(store.track(track.id)!.clips[0].bufferId)!.channels[0], rate, 1800)).toBeLessThan(goertzelPower(original, rate, 1800) * 0.05)
    store.undo()
    expect(store.track(track.id)!.clips[0].bufferId).toBe('src-1')
    expect(store.track(track.id)!.clips[0].spectral).toBeUndefined()
    store.redo()
    expect(store.track(track.id)!.clips[0].spectral?.ops).toHaveLength(1)
    expect(store.buffers.get(store.track(track.id)!.clips[0].bufferId)?.channels[0].length).toBe(original.length)
  })

  it('runs the high-quality fft on a short tone', () => {
    const rate = 16000
    const input = sine(1000, 0.2, rate)
    const output = renderSpectral([input], rate, repair(box(0, 1, 400, 1600), 'attenuate', 1), HQ_SPECTRAL)[0]
    expect(output.length).toBe(input.length)
    expect(goertzelPower(output, rate, 1000)).toBeLessThan(goertzelPower(input, rate, 1000) * 0.08)
  })
})

function energy(samples: Float32Array) {
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i]
  return sum
}

function toneShare(samples: Float32Array, sampleRate: number, freq: number) {
  const n = samples.length
  let s = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * freq * i) / sampleRate
    s += samples[i] * Math.sin(phase)
    c += samples[i] * Math.cos(phase)
  }
  const a = (2 * s) / n
  const b = (2 * c) / n
  return ((a * a + b * b) * n) / 2
}

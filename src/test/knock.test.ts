import { describe, expect, it } from 'vitest'
import { RackRuntime } from '../audio/rack/dsp'
import {
  detectPitch,
  glideSamples,
  knockPadPitch,
  midiHz,
  renderDriveProbe,
  renderKnockBuffer,
  snapMidi,
  splitMonoBelow,
} from '../audio/rack/knock'
import { KNOCK_PRESETS } from '../model/knockPresets'
import { makeDevice } from '../model/rack'

function measureHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.05))
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 10)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return sampleRate / mean
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function mag(samples: Float32Array, freq: number, sampleRate: number) {
  const n = samples.length
  const k = Math.round((freq * n) / sampleRate)
  const w = (2 * Math.PI * k) / n
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    s0 = (samples[i] || 0) + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return (Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) * 2) / n
}

function toneParams(extra: Record<string, number> = {}) {
  const device = makeDevice('knock')
  Object.assign(device.params, {
    morph: 0,
    sub: 0,
    punch: 0,
    pdec: 10,
    click: 0,
    clevel: 0,
    attack: 0,
    hold: 0,
    decay: 3000,
    sustain: 1,
    release: 400,
    drive: 0,
    dmix: 0,
    phone: 0,
    cutoff: 12000,
    res: 0,
    fenv: 0,
    fine: 0,
    snap: 0,
    glide: 0,
    level: 0.65,
    ceiling: 1,
    duck: 0,
    tail: 0,
    smode: 0,
    fmode: 0,
  }, extra)
  return device
}

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / channel.length)
}

describe('knock bass', () => {
  it('holds the sustain pitch within 2 cents after the pitch drop', () => {
    const device = toneParams({ punch: 12, pdec: 20, pcurve: 1 })
    const runtime = new RackRuntime(48000)
    runtime.note(45, 0.9, 1)
    const audio = runtime.render({ devices: [device], cables: [], polyphony: 1 }, 24000, 120, 'full', new Map())[0]
    expect(cents(measureHz(audio, 48000), midiHz(45))).toBeLessThan(2)
  })

  it('finishes a glide on the target pitch at the glide time', () => {
    const sr = 48000
    const device = toneParams({ glide: 100, gcurve: 0, punch: 0 })
    const span = glideSamples(device.params, sr, (60 / 120) * sr)
    const traced = renderKnockBuffer(
      device.params,
      [{ sample: 0, pitch: 36, vel: 0.9 }, { sample: 1500, pitch: 48, vel: 0.9, slide: true }],
      sr,
      120,
      1500 + span + 8,
    )
    expect(Math.abs(traced.midi[1500 + span] - 48)).toBeLessThan(0.02)
    expect(Math.abs(traced.midi[1500 + Math.floor(span / 2)] - 48)).toBeGreaterThan(3)

    const runtime = new RackRuntime(sr)
    const rack = { devices: [device], cables: [], polyphony: 1 }
    runtime.note(36, 0.9, 1)
    runtime.render(rack, 1500, 120, 'full', new Map())
    runtime.note(48, 0.9, 1, true)
    runtime.render(rack, span, 120, 'full', new Map())
    const landed = runtime.render(rack, 16000, 120, 'full', new Map())[0]
    expect(cents(measureHz(landed, sr), midiHz(48))).toBeLessThan(2)
  })

  it('keeps hard-clip aliases under -80 dB at full drive', () => {
    const sr = 48000
    const freq = 7000
    const skip = 16000
    const n = 4800
    const audio = renderDriveProbe(freq, sr, skip + n, {
      drive: 1,
      dtype: 1,
      dmix: 1,
      band: 1,
      xover: 40,
      pre: 16000,
      post: 16000,
    })
    const slice = audio.subarray(skip)
    const fund = mag(slice, freq, sr)
    const alias = mag(slice, 13000, sr)
    expect(fund).toBeGreaterThan(0.02)
    expect(20 * Math.log10((alias + 1e-12) / fund)).toBeLessThan(-80)
  })

  it('stays near zero DC with a rectifying drive', () => {
    const device = toneParams({ drive: 1, dtype: 7, dmix: 1, band: 1, morph: 0.2 })
    const audio = renderKnockBuffer(device.params, [{ sample: 0, pitch: 36, vel: 0.85 }], 48000, 120, 36000).left
    let mean = 0
    const start = 8000
    for (let i = start; i < audio.length; i++) mean += audio[i]
    mean /= audio.length - start
    expect(Math.abs(mean)).toBeLessThan(0.002)
  })

  it('sums only the low band to the center', () => {
    const sr = 48000
    const n = 12000
    const state = { monoL: 0, monoR: 0 }
    const diff = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const low = Math.sin((2 * Math.PI * 55 * i) / sr)
      const left = low + Math.sin((2 * Math.PI * 1800 * i) / sr)
      const right = low + Math.sin((2 * Math.PI * 1800 * i) / sr + 1.2)
      const [l, r] = splitMonoBelow(left, right, state, 140, sr)
      diff[i] = l - r
    }
    const tail = diff.subarray(4000)
    expect(mag(tail, 55, sr)).toBeLessThan(0.005)
    expect(mag(tail, 1800, sr)).toBeGreaterThan(0.2)
  })

  it('holds the limiter ceiling', () => {
    const device = toneParams({
      drive: 1,
      dtype: 1,
      dmix: 1,
      morph: 1,
      level: 1,
      ceiling: 0.25,
      cutoff: 4000,
      phone: 0.4,
    })
    const audio = renderKnockBuffer(device.params, [{ sample: 0, pitch: 36, vel: 1 }], 48000, 120, 8000).left
    let peak = 0
    for (const sample of audio) peak = Math.max(peak, Math.abs(sample))
    expect(peak).toBeLessThanOrEqual(0.25 + 1e-4)
    expect(peak).toBeGreaterThan(0.15)
  })

  it('does not click on retrigger or legato', () => {
    const device = toneParams({ glide: 0, punch: 0, click: 0 })
    const runtime = new RackRuntime(48000)
    const rack = { devices: [device], cables: [], polyphony: 1 }
    runtime.note(40, 0.85, 1)
    const first = runtime.render(rack, 4000, 120, 'full', new Map())[0]
    runtime.note(40, 0.85, 1)
    const retrigger = runtime.render(rack, 300, 120, 'full', new Map())[0]
    runtime.note(47, 0.85, 1, true)
    const legato = runtime.render(rack, 300, 120, 'full', new Map())[0]
    const jump = (a: Float32Array, b: Float32Array) => {
      let max = Math.abs(b[0] - a[a.length - 1])
      for (let i = 1; i < b.length; i++) max = Math.max(max, Math.abs(b[i] - b[i - 1]))
      return max
    }
    expect(jump(first, retrigger)).toBeLessThan(0.05)
    expect(jump(retrigger, legato)).toBeLessThan(0.05)
  })

  it('tunes a sampled body to the played note', () => {
    const sr = 48000
    const buf = new Float32Array(sr / 4)
    for (let i = 0; i < buf.length; i++) buf[i] = Math.sin((2 * Math.PI * 100 * i) / sr)
    const found = detectPitch(buf, sr)
    const targetMidi = 69 + 12 * Math.log2(100 / 440)
    expect(Math.abs(found.midi - targetMidi)).toBeLessThan(0.2)
    const device = toneParams({ smode: 1, sroot: found.midi, cutoff: 8000 })
    const played = renderKnockBuffer(device.params, [{ sample: 0, pitch: 36, vel: 0.9 }], sr, 120, 20000, {
      samples: buf,
      sampleRate: sr,
    })
    expect(cents(measureHz(played.left, sr), midiHz(36))).toBeLessThan(15)
  })

  it('ships thirty original programs and an in-key pad row', () => {
    expect(KNOCK_PRESETS.length).toBeGreaterThanOrEqual(30)
    expect(new Set(KNOCK_PRESETS.map((item) => item.name)).size).toBe(KNOCK_PRESETS.length)
    expect(knockPadPitch(0, 0, 0)).toBe(24)
    expect(knockPadPitch(1, 0, 0)).toBe(26)
    expect(snapMidi(66, 0, 0, true)).toBe(65)
    for (const preset of KNOCK_PRESETS) {
      const device = makeDevice('knock', preset.name)
      const runtime = new RackRuntime(22050)
      runtime.note(36, 0.7, 1)
      const audio = runtime.render({ devices: [device], cables: [], polyphony: 1 }, 256, 120, 'eco', new Map())[0]
      for (const sample of audio) {
        expect(Number.isFinite(sample)).toBe(true)
        expect(Math.abs(sample)).toBeLessThanOrEqual(1.5)
      }
    }
  })

  it('ducks when the bus in front is loud', () => {
    const open = toneParams({ duck: 0 })
    const side = new Float32Array(5000)
    side.fill(0.8)
    const dry = renderKnockBuffer(open.params, [{ sample: 0, pitch: 40, vel: 1 }], 48000, 120, side.length)
    const wet = renderKnockBuffer({ ...open.params, duck: 1 }, [{ sample: 0, pitch: 40, vel: 1 }], 48000, 120, side.length, { sidechain: side })
    expect(rms(wet.left)).toBeLessThan(rms(dry.left) * 0.45)
  })
})

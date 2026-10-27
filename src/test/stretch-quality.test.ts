import { mkdirSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { designBiquad } from '../audio/plugins/dsp'
import { createSaturator } from '../audio/plugins/color'
import { resampleSinc } from '../audio/quality/resample'
import { scheduleStretchCommit, stretchSlot } from '../audio/stretch/commit'
import { peakIndex, pitchFactor, renderStretch, timeStretch } from '../audio/stretch/engine'
import { yinPitch } from '../audio/stretch/voice'
import { encodeWav } from '../model/wav'

const rate = 48000

function sine(freq: number, seconds: number, sampleRate = rate, amp = 0.5) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return data
}

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

function hzOf(channel: Float32Array, sampleRate: number, expectHz: number) {
  const start = Math.floor(channel.length * 0.4)
  const frame = channel.subarray(start, Math.min(channel.length, start + 4096))
  return yinPitch(frame, sampleRate, Math.max(40, expectHz / 2), expectHz * 2).hz
}

function rms(channel: Float32Array) {
  let sum = 0
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i]
  return Math.sqrt(sum / Math.max(1, channel.length))
}

function goertzel(channel: Float32Array, freq: number, sampleRate: number) {
  const n = channel.length
  const k = Math.max(1, Math.round((freq * n) / sampleRate))
  const coeff = 2 * Math.cos((2 * Math.PI * k) / n)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const s0 = channel[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

function tonePower(channel: Float32Array, freq: number, sampleRate: number) {
  const amp = (2 * Math.sqrt(Math.max(0, goertzel(channel, freq, sampleRate)))) / channel.length
  return (amp * amp) / 2
}

function thdn(channel: Float32Array, freq: number, sampleRate: number) {
  const start = Math.floor(channel.length * 0.25)
  const frame = channel.subarray(start, Math.min(channel.length, start + 8192))
  const n = frame.length
  const w = (2 * Math.PI * freq) / sampleRate
  let aa = 0
  let bb = 0
  let cc = 0
  let dd = 0
  let ee = 0
  for (let i = 0; i < n; i++) {
    const s = Math.sin(w * i)
    const c = Math.cos(w * i)
    aa += s * s
    bb += s * c
    cc += c * c
    dd += frame[i] * s
    ee += frame[i] * c
  }
  const det = aa * cc - bb * bb
  if (Math.abs(det) < 1e-12) return 1
  const sine = (dd * cc - bb * ee) / det
  const cosine = (aa * ee - bb * dd) / det
  let noise = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const err = frame[i] - (sine * Math.sin(w * i) + cosine * Math.cos(w * i))
    noise += err * err
    total += frame[i] * frame[i]
  }
  if (total < 1e-12) return 1
  return Math.sqrt(noise / total)
}

function crossings(channel: Float32Array, at: number, span: number) {
  let count = 0
  const end = Math.min(channel.length, at + span)
  for (let i = at + 1; i < end; i++) if ((channel[i - 1] || 0) <= 0 && (channel[i] || 0) > 0) count++
  return count
}

function smear(channel: Float32Array, sampleRate: number) {
  const at = peakIndex(channel)
  const radius = Math.round(sampleRate * 0.005)
  let energy = 0
  let inside = 0
  for (let i = 0; i < channel.length; i++) {
    const value = channel[i] * channel[i]
    energy += value
    if (Math.abs(i - at) <= radius) inside += value
  }
  return energy > 0 ? 1 - inside / energy : 0
}

function responseDb(filter: { b0: number; b1: number; b2: number; a1: number; a2: number }, freq: number, sampleRate: number) {
  const w = (2 * Math.PI * freq) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const numRe = filter.b0 + filter.b1 * c1 + filter.b2 * c2
  const numIm = -(filter.b1 * s1 + filter.b2 * s2)
  const denRe = 1 + filter.a1 * c1 + filter.a2 * c2
  const denIm = -(filter.a1 * s1 + filter.a2 * s2)
  return 20 * Math.log10(Math.hypot(numRe, numIm) / Math.max(1e-12, Math.hypot(denRe, denIm)))
}

function vowel(seconds = 0.45) {
  const data = new Float32Array(Math.round(seconds * rate))
  const f0 = 140
  for (let i = 0; i < data.length; i++) {
    let sample = 0
    for (let harmonic = 1; harmonic <= 28; harmonic++) {
      const freq = f0 * harmonic
      if (freq > rate * 0.45) break
      const env =
        Math.exp(-((freq - 700) ** 2) / (2 * 160 ** 2)) + 0.55 * Math.exp(-((freq - 1150) ** 2) / (2 * 200 ** 2))
      sample += (env / harmonic) * Math.sin((2 * Math.PI * freq * i) / rate)
    }
    data[i] = sample * 0.15
  }
  return data
}

function piano(seconds = 0.7) {
  const data = new Float32Array(Math.round(seconds * rate))
  const f0 = 261.63
  for (let i = 0; i < data.length; i++) {
    const env = Math.exp(-i / (rate * 0.22))
    let sample = 0
    for (let harmonic = 1; harmonic <= 10; harmonic++) sample += Math.sin((2 * Math.PI * f0 * harmonic * i) / rate) / harmonic
    data[i] = sample * env * 0.25
  }
  return data
}

function drum() {
  const data = new Float32Array(rate)
  const at = 12000
  for (let i = 0; i < 180; i++) data[at + i] += (1 - i / 180) * Math.sin((2 * Math.PI * 160 * i) / rate)
  for (let i = 0; i < 700; i++) {
    const noise = ((i * 47) % 100) / 50 - 1
    data[at + i] += noise * (1 - i / 700) * 0.35
  }
  return data
}

function sweep() {
  const data = new Float32Array(rate)
  let phase = 0
  for (let i = 0; i < data.length; i++) {
    const freq = 180 * (1600 / 180) ** (i / data.length)
    phase += (2 * Math.PI * freq) / rate
    data[i] = 0.5 * Math.sin(phase)
  }
  return data
}

function linearDown(input: Float32Array) {
  const out = new Float32Array(Math.floor(input.length / 2))
  for (let i = 0; i < out.length; i++) {
    const pos = i * 2
    const frac = 0
    out[i] = (input[pos] || 0) * (1 - frac) + (input[Math.min(input.length - 1, pos + 1)] || 0) * frac
  }
  return out
}

describe('render quality', () => {
  it('nulls an unstretched clip and keeps length exact', () => {
    const input = sine(440, 0.4)
    const output = renderStretch([input], rate, { ratio: 1, mode: 'pro' })
    expect(output[0].length).toBe(input.length)
    let max = 0
    for (let i = 0; i < input.length; i++) max = Math.max(max, Math.abs(output[0][i] - input[i]))
    expect(max).toBe(0)
  })

  it('keeps a stretched sine in tune with low distortion', () => {
    const input = sine(440, 0.55)
    const output = renderStretch([input], rate, { ratio: 1.5, mode: 'pro' })
    expect(Math.abs(output[0].length - Math.round(input.length * 1.5))).toBeLessThanOrEqual(1)
    expect(Math.abs(cents(hzOf(output[0], rate, 440), 440))).toBeLessThan(8)
    expect(thdn(output[0], 440, rate)).toBeLessThan(0.05)
  })

  it('rejects energy above the new Nyquist when resampling', () => {
    const high = sine(18000, 0.25, rate, 0.8)
    const kept = resampleSinc(high, Math.round(high.length / 2), 96)
    const aliased = linearDown(high)
    expect(rms(kept)).toBeLessThan(0.03)
    expect(rms(aliased)).toBeGreaterThan(0.2)
    const mid = sine(3000, 0.25, rate, 0.8)
    expect(rms(resampleSinc(mid, Math.round(mid.length / 2), 96))).toBeGreaterThan(0.35)
    const up = resampleSinc(sine(1000, 0.2), Math.round(0.2 * 96000), 64)
    const back = resampleSinc(up, Math.round(0.2 * rate), 64)
    expect(thdn(back, 1000, rate)).toBeLessThan(0.02)
  })

  it('holds transients, formants, and pitch on the four listening sources', () => {
    const hit = drum()
    const beats = timeStretch(hit, Math.round(hit.length * 1.4), 'beats', rate, 'hq')
    const tonal = timeStretch(hit, Math.round(hit.length * 1.4), 'tonal', rate, 'hq')
    expect(smear(beats, rate)).toBeLessThan(0.12)
    expect(smear(beats, rate)).toBeLessThan(smear(tonal, rate))

    const voice = vowel()
    const shifted = renderStretch([voice], rate, { ratio: 1, semitones: 5, mode: 'voice', formant: true })
    const bare = renderStretch([voice], rate, { ratio: 1, semitones: 5, mode: 'pro', formant: false })
    const target = 140 * pitchFactor(5)
    expect(Math.abs(cents(hzOf(shifted[0], rate, target), target))).toBeLessThan(20)
    const kept = tonePower(shifted[0], 700, rate) / Math.max(1e-8, tonePower(shifted[0], 700 * pitchFactor(5), rate))
    const moved = tonePower(bare[0], 700, rate) / Math.max(1e-8, tonePower(bare[0], 700 * pitchFactor(5), rate))
    expect(kept).toBeGreaterThan(moved)

    const keys = piano()
    const stretched = renderStretch([keys], rate, { ratio: 1.25, mode: 'tonal' })
    expect(Math.abs(cents(hzOf(stretched[0], rate, 261.63), 261.63))).toBeLessThan(15)
    expect(peakIndex(stretched[0])).toBeLessThan(rate * 0.03)

    const chirp = sweep()
    const slower = renderStretch([chirp], rate, { ratio: 1.5, mode: 'pro' })
    const span = 8192
    const sourceAt = Math.floor(chirp.length * 0.5)
    const outputAt = Math.floor(slower[0].length * 0.5)
    expect(Math.abs(crossings(slower[0], outputAt, span) - crossings(chirp, sourceAt, span))).toBeLessThanOrEqual(4)

    const dir = '/opt/cursor/artifacts/ab'
    mkdirSync(dir, { recursive: true })
    const clips: [string, Float32Array][] = [
      ['sine-source', inputTone()],
      ['sine-preview', renderStretch([inputTone()], rate, { ratio: 1.5, mode: 'pro', quality: 'preview' })[0]],
      ['sine-hq', renderStretch([inputTone()], rate, { ratio: 1.5, mode: 'pro', quality: 'hq' })[0]],
      ['drum-source', hit],
      ['drum-hq', beats],
      ['vocal-source', voice],
      ['vocal-hq-formant', shifted[0]],
      ['vocal-hq-shifted', bare[0]],
      ['piano-source', keys],
      ['piano-hq', stretched[0]],
    ]
    for (const [name, channel] of clips) writeFileSync(`${dir}/${name}.wav`, Buffer.from(encodeWav([channel], rate, { dither: 'tpdf' })))
    const report = {
      sineThd: thdn(clips[2][1], 440, rate),
      previewThd: thdn(clips[1][1], 440, rate),
      drumSmear: smear(beats, rate),
      tonalSmear: smear(tonal, rate),
      formantRatio: kept,
      bareRatio: moved,
    }
    writeFileSync(`${dir}/metrics.json`, JSON.stringify(report, null, 2))
    expect(report.sineThd).toBeLessThan(report.previewThd + 0.05)
  })

  it('replaces the preview with the committed render', async () => {
    const input = sine(330, 0.3)
    const key = `quality-${input.length}`
    scheduleStretchCommit(
      key,
      () => renderStretch([input], rate, { ratio: 1.2, mode: 'pro', quality: 'hq' }),
      () => renderStretch([input], rate, { ratio: 1.2, mode: 'pro', quality: 'preview' }),
    )
    expect(stretchSlot(key)?.quality).toBe('preview')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stretchSlot(key)?.quality).toBe('hq')
    expect(stretchSlot(key)?.channels?.[0].length).toBe(Math.round(input.length * 1.2))
  })

  it('matches peaking gain at the center and does not pin the Nyquist gain to the peak', () => {
    const filter = designBiquad('peaking', rate, 18000, 2, 6)
    expect(Math.abs(responseDb(filter, 18000, rate) - 6)).toBeLessThan(0.1)
    expect(responseDb(filter, 23500, rate)).toBeLessThan(4)
    const low = designBiquad('peaking', 96000, 1000, 1, -3)
    expect(Math.abs(responseDb(low, 1000, 96000) + 3)).toBeLessThan(0.1)
  })

  it('keeps saturation aliases under the raw waveshaper', () => {
    const input = sine(7000, 0.2, rate, 0.6)
    const processor = createSaturator(rate)
    const left = new Float32Array(input.length)
    const right = new Float32Array(input.length)
    processor.process([input, input], [left, right], { drive: 0.85, tone: 12000, mix: 1 }, {
      sampleRate: rate,
      tempo: 120,
      sampleTime: 0,
      sidechain: null,
      scaleRoot: 0,
      scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
      quality: 'full',
    })
    const shape = 1 + 0.85 * 8
    const raw = new Float32Array(input.length)
    for (let i = 0; i < input.length; i++) {
      const x = input[i]
      raw[i] = Math.tanh((x + 0.85 * x * x * 0.2) * shape) / Math.tanh(shape)
    }
    const alias = 48000 - 7000 * 5
    const shaped = tonePower(left.subarray(4000), alias, rate)
    const plain = tonePower(raw.subarray(4000), alias, rate)
    expect(shaped).toBeLessThan(plain)
    expect(Number.isFinite(left[1000])).toBe(true)
  })
})

function inputTone() {
  return sine(440, 0.55)
}

import { describe, expect, it } from 'vitest'
import { NOTE_PEAK, db, measurePeak, normalizePeak, panGains, safetyCurve } from '../audio/level'
import { MemoryBank } from '../audio/multisample/cache'
import { renderSampler } from '../audio/multisample/engine'
import { makeProgram, makeSample, makeZone } from '../audio/multisample/types'
import { renderGraph } from '../audio/renderGraph'
import { passthroughProcessor } from './output-path-support'
import { encodeWav, decodeWavPCM } from '../model/wav'
import { placeSound } from '../sounds/place'
import { createEmptyProject } from '../model/types'
import type { SoundEntry } from '../sounds/types'
import { instrumentFileUrl } from '../harbor/load'

const RATE = 48000

function sine(freq: number, seconds: number, rate = RATE, amp = 1) {
  const length = Math.round(seconds * rate)
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp
  return out
}

function fftPeak(channel: Float32Array, rate: number, from = 0) {
  const n = 8192
  const start = Math.min(channel.length - n, Math.max(0, from))
  let best = 0
  let bin = 0
  for (let k = 1; k < n / 2; k++) {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * k * i) / n
      const sample = channel[start + i] || 0
      re += sample * Math.cos(w)
      im -= sample * Math.sin(w)
    }
    const mag = re * re + im * im
    if (mag > best) {
      best = mag
      bin = k
    }
  }
  return (bin * rate) / n
}

function thd(channel: Float32Array, rate: number, fundamental: number) {
  const n = 8192
  const start = Math.floor(channel.length * 0.25)
  const binOf = (freq: number) => Math.max(1, Math.round((freq * n) / rate))
  const powerAt = (bin: number) => {
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      const w = (2 * Math.PI * bin * i) / n
      const sample = channel[start + i] || 0
      re += sample * Math.cos(w)
      im -= sample * Math.sin(w)
    }
    return re * re + im * im
  }
  const base = powerAt(binOf(fundamental))
  let harm = 0
  for (let h = 2; h <= 8; h++) harm += powerAt(binOf(fundamental * h))
  if (!(base > 0)) return 1
  return Math.sqrt(harm / base)
}

function zeroRun(channel: Float32Array, from: number, to: number) {
  let run = 0
  let worst = 0
  for (let i = from; i < to; i++) {
    if (channel[i] === 0) {
      run += 1
      if (run > worst) worst = run
    } else run = 0
  }
  return worst
}

function renderTrack(buffer: Float32Array[], pan: number, volume = 1) {
  const length = buffer[0]?.length ?? 0
  return renderGraph({
    tracks: [{
      id: 't',
      type: 'audio',
      input: 'none',
      buffer,
      volume,
      pan,
      mute: false,
      solo: false,
      plugins: [],
      sends: [],
      output: null,
      groupId: null,
    }],
    masterPlugins: [],
    masterVolume: 1,
    sampleRate: RATE,
    tempo: 120,
    length,
    scaleRoot: 0,
    scaleIntervals: [0, 2, 4, 5, 7, 9, 11],
    automation: [],
    offline: true,
    create: () => passthroughProcessor(),
  }).master
}

describe('shared output level and pan', () => {
  it('keeps a safety curve transparent below the ceiling', () => {
    const curve = safetyCurve()
    const mid = curve[Math.floor(curve.length / 2)]
    expect(Math.abs(mid)).toBeLessThan(1e-6)
    const quarter = curve[Math.floor(curve.length * 0.75)]
    expect(quarter).toBeGreaterThan(0.4)
    expect(quarter).toBeLessThan(0.6)
    const toneHz = (80 * RATE) / 8192
    const tone = sine(toneHz, 0.5, RATE, 0.25)
    const shaped = tone.map((sample) => {
      const position = ((sample + 1) / 2) * (curve.length - 1)
      const i0 = Math.floor(position)
      const i1 = Math.min(curve.length - 1, i0 + 1)
      const mix = position - i0
      return curve[i0] * (1 - mix) + curve[i1] * mix
    })
    expect(thd(shaped, RATE, toneHz)).toBeLessThan(0.001)
    const directPeak = measurePeak([tone])
    const shapedPeak = measurePeak([shaped])
    expect(Math.abs(db(shapedPeak) - db(directPeak))).toBeLessThan(0.5)
  })

  it('pans a mono sine and a stereo buffer with equal power', () => {
    const tone = sine(440, 0.2)
    for (const pan of [-1, 0, 1] as const) {
      const master = renderTrack([tone], pan)
      const left = measurePeak([master[0]])
      const right = measurePeak([master[1]])
      const gains = panGains(pan)
      if (gains.left > 0.01) expect(Math.abs(db(left) - db(gains.left)), `left ${pan}`).toBeLessThan(0.5)
      if (gains.right > 0.01) expect(Math.abs(db(right) - db(gains.right)), `right ${pan}`).toBeLessThan(0.5)
      if (pan === -1) expect(db(right) - db(left)).toBeLessThan(-40)
      if (pan === 1) expect(db(left) - db(right)).toBeLessThan(-40)
      if (pan === 0) expect(Math.abs(db(left) - db(right))).toBeLessThan(0.5)
    }
    const stereo = renderTrack([tone, tone], 0)
    expect(Math.abs(db(measurePeak([stereo[0]])) - db(measurePeak([stereo[1]])))).toBeLessThan(0.5)
    expect(Math.abs(db(measurePeak([stereo[0]])) - db(panGains(0).left))).toBeLessThan(0.5)
  })

  it('renders a normalized instrument note and a library loop without clipping or dropouts', () => {
    const a4 = sine(440, 0.4, RATE, 0.2)
    const program = makeProgram({
      id: 'piano',
      name: 'Piano',
      gainDb: 0,
      samples: [makeSample({ id: 'a4', sampleRate: RATE, channels: 1 })],
      zones: [makeZone({ id: 'z', sampleId: 'a4', root: 69, lokey: 0, hikey: 127, gainDb: 0 })],
    })
    const bank = new MemoryBank()
    bank.put('a4', { sampleRate: RATE, channels: [a4] })
    const [left, right] = renderSampler(program, [{ sample: 0, pitch: 69, vel: 1 }], RATE, a4.length, bank)
    const peak = Math.max(measurePeak([left]), measurePeak([right]))
    expect(peak).toBeGreaterThan(10 ** (-24 / 20))
    expect(peak).toBeLessThan(10 ** (-3 / 20))
    expect(peak).toBeLessThan(1)
    expect(Math.abs(fftPeak(left, RATE, 4000) - 440)).toBeLessThan(3)
    expect(zeroRun(left, 2000, left.length - 2000)).toBeLessThan(8)
    const panned = renderTrack([left, right], -1, 1)
    expect(db(measurePeak([panned[1]])) - db(measurePeak([panned[0]]))).toBeLessThan(-40)

    const loop = sine(220, 0.5, RATE, 0.9)
    const entry: SoundEntry = {
      id: 'loop',
      path: 'loops/test.wav',
      name: 'Loop',
      type: 'loop',
      tags: [],
      bpm: 120,
      key: 'A',
      durationSec: 0.5,
      sampleRate: RATE,
      license: 'CC0-1.0',
      source: '',
    }
    const project = createEmptyProject(RATE)
    const placed = placeSound({ entry, channels: [loop], fileRate: RATE, project, startSample: 0 })
    expect(placed).toBeTruthy()
    const clip = placed!.asset.channels[0]
    expect(Math.abs(clip.length / RATE - 0.5)).toBeLessThan(0.02)
    const mix = renderTrack(placed!.asset.channels, 0, 1)
    const mixPeak = Math.max(measurePeak([mix[0]]), measurePeak([mix[1]]))
    expect(mixPeak).toBeLessThan(1)
    expect(mixPeak).toBeGreaterThan(10 ** (-24 / 20))
    expect(mixPeak).toBeLessThan(10 ** (-3 / 20))
    expect(Math.abs(fftPeak(mix[0], RATE, 2000) - 220)).toBeLessThan(4)
    expect(zeroRun(mix[0], 1000, mix[0].length - 1000)).toBeLessThan(8)
    expect(Math.abs(db(measurePeak([placed!.asset.channels[0]])) - db(NOTE_PEAK))).toBeLessThan(0.2)
  })

  it('keeps the length of a decoded library wav', () => {
    const tone = sine(440, 0.25, 44100, 0.5)
    const bytes = encodeWav([tone], 44100, { bits: 24 })
    const decoded = decodeWavPCM(bytes)
    expect(decoded.sampleRate).toBe(44100)
    expect(decoded.channels[0].length).toBe(tone.length)
    expect(Math.abs(fftPeak(decoded.channels[0], 44100) - 440)).toBeLessThan(4)
    const shaped = normalizePeak(decoded.channels)
    expect(measurePeak(shaped)).toBeLessThan(1)
    expect(Math.abs(db(measurePeak(shaped)) - db(NOTE_PEAK))).toBeLessThan(0.2)
  })

  it('decodes a pinned Hugging Face loop when the network is up', async () => {
    const url = instrumentFileUrl('loops/collection-of-loops-vol01/090Fxgroove-01.wav')
    let response: Response
    try {
      response = await fetch(url)
    } catch {
      return
    }
    if (!response.ok) return
    const decoded = decodeWavPCM(await response.arrayBuffer())
    expect(decoded.channels[0].length).toBeGreaterThan(1000)
    expect(decoded.sampleRate).toBeGreaterThan(8000)
    const peak = measurePeak(normalizePeak(decoded.channels))
    expect(peak).toBeGreaterThan(10 ** (-24 / 20))
    expect(peak).toBeLessThan(1)
    expect(Number.isFinite(decoded.channels[0][100])).toBe(true)
  })
})

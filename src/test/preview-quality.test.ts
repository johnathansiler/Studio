import { describe, expect, it } from 'vitest'
import { MemoryBank } from '../audio/multisample/cache'
import { renderSampler } from '../audio/multisample/engine'
import { readFrame } from '../audio/multisample/read'
import { makeProgram, makeSample, makeZone, midiVelocity } from '../audio/multisample/types'
import { fadePlaybackEdges, fitPlaybackRate } from '../audio/quality/playback'
import { SamplePool } from '../audio/voices/engine'
import { decodeWavPCM, encodeWav } from '../model/wav'

/**
 * Before the band-limited conversion, a 30 kHz sine in a 96 kHz file played at
 * 48 kHz kept RMS 0.030 through the 8-tap reader (about -21 dB) and RMS 0.354
 * through the pad's linear reader (no rejection). A 440 Hz sine hid the problem
 * because it sits far below Nyquist. The alias is the crackle.
 */

function sine(freq: number, n: number, rate: number, amp = 0.5) {
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate)
  return data
}

function rms(buf: Float32Array, start = 0, end = buf.length) {
  let sum = 0
  const from = Math.max(0, start)
  const to = Math.min(buf.length, end)
  if (to <= from) return 0
  for (let i = from; i < to; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / (to - from))
}

function maxJump(buf: Float32Array, start = 1, end = buf.length) {
  let jump = 0
  for (let i = Math.max(1, start); i < Math.min(buf.length, end); i++) jump = Math.max(jump, Math.abs(buf[i] - buf[i - 1]))
  return jump
}

function thd(buf: Float32Array, freq: number, rate: number, start: number) {
  const n = Math.min(4096, buf.length - start - 8)
  if (n < 256) return 1
  const w = (2 * Math.PI * freq) / rate
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
    dd += buf[start + i] * s
    ee += buf[start + i] * c
  }
  const det = aa * cc - bb * bb
  if (Math.abs(det) < 1e-12) return 1
  const sineA = (dd * cc - bb * ee) / det
  const cosine = (aa * ee - bb * dd) / det
  let noise = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const err = buf[start + i] - (sineA * Math.sin(w * i) + cosine * Math.cos(w * i))
    noise += err * err
    total += buf[start + i] * buf[start + i]
  }
  return total < 1e-18 ? 1 : Math.sqrt(noise / total)
}

function playLibrary(channel: Float32Array, fileRate: number, outRate: number, pitch: number, root = 60) {
  const bank = new MemoryBank()
  bank.put('s', { sampleRate: fileRate, channels: [channel] })
  const program = makeProgram({
    name: 'preview',
    samples: [makeSample({ id: 's', sampleRate: fileRate })],
    zones: [makeZone({
      id: 'z',
      sampleId: 's',
      root,
      lokey: 0,
      hikey: 127,
      loopMode: 'one-shot',
      ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.02 },
    })],
    play: { tune: 0, attack: 0, decay: 0, sustain: 1, release: 0.02, tone: 20000 },
  })
  const frames = Math.round(outRate * 0.35)
  return renderSampler(program, [{ sample: 0, pitch, vel: midiVelocity(0.9) }], outRate, frames, bank)[0]
}

function playPad(channel: Float32Array, fileRate: number, outRate: number) {
  const pool = new SamplePool(outRate)
  pool.load(1, channel, fileRate)
  const pad = pool.pad(0)
  pad.setRegion(1, 0, channel.length)
  pad.setPitch(0, 0, 'vinyl')
  pad.setFade(0, 0)
  const frames = Math.round(outRate * 0.25)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  pool.note(0, 0, 0.9)
  for (let offset = 0; offset < frames; offset += 128) {
    const count = Math.min(128, frames - offset)
    pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
  }
  return left
}

describe('preview and loaded-instrument playback', () => {
  const fileRate = 96000
  const tone = sine(440, Math.round(fileRate * 0.5), fileRate, 0.55)
  const ultrasonic = sine(30000, fileRate, fileRate, 0.55)

  it('decodes 24-bit 96 kHz without adding noise, then rejects the octave above the device rate', () => {
    const bytes = encodeWav([tone], fileRate, { bits: 24 })
    const decoded = decodeWavPCM(bytes)
    let err = 0
    let energy = 0
    for (let i = 0; i < tone.length; i++) {
      const delta = decoded.channels[0][i] - tone[i]
      err += delta * delta
      energy += tone[i] * tone[i]
    }
    expect(Math.sqrt(err / energy)).toBeLessThan(1e-4)
    for (const device of [48000, 44100]) {
      const preview = fitPlaybackRate(decoded.channels, decoded.sampleRate, device).channels[0]
      expect(thd(preview, 440, device, Math.floor(device * 0.05))).toBeLessThan(0.02)
      expect(maxJump(preview, Math.floor(device * 0.05), preview.length - 64)).toBeLessThan(0.08)
      const leaked = fitPlaybackRate([ultrasonic], fileRate, device).channels[0]
      expect(rms(leaked, Math.floor(leaked.length * 0.2), Math.floor(leaked.length * 0.8))).toBeLessThan(0.008)
    }
  })

  it('fades a hot preview edge so the first sample is not a click', () => {
    const hot = new Float32Array(4800)
    hot.fill(0.8)
    const faded = fadePlaybackEdges([hot], 72)[0]
    expect(Math.abs(faded[0])).toBeLessThan(0.02)
    expect(Math.abs(faded[faded.length - 1])).toBeLessThan(0.02)
    expect(Math.abs(faded[400] - 0.8)).toBeLessThan(0.001)
    expect(maxJump(faded, 1, 80)).toBeLessThan(0.05)
  })

  it('renders a loaded 96 kHz sample at 48 kHz and 44.1 kHz without aliasing or jumps', () => {
    for (const device of [48000, 44100]) {
      for (const pitch of [60, 63, 67]) {
        const heard = playLibrary(tone, fileRate, device, pitch)
        const freq = 440 * 2 ** ((pitch - 60) / 12)
        expect(rms(heard, Math.floor(device * 0.05), Math.floor(device * 0.2))).toBeGreaterThan(0.2)
        expect(thd(heard, freq, device, Math.floor(device * 0.08))).toBeLessThan(0.03)
        expect(maxJump(heard, Math.floor(device * 0.05), Math.floor(device * 0.2))).toBeLessThan(0.12)
      }
      const leaked = playLibrary(ultrasonic, fileRate, device, 60)
      expect(rms(leaked, Math.floor(device * 0.05), Math.floor(device * 0.2))).toBeLessThan(0.01)
      const direct = new Float32Array(4000)
      let pos = 64
      for (let i = 0; i < direct.length; i++) {
        direct[i] = readFrame(ultrasonic, pos, fileRate / device, { loop: false, loopStart: 0, loopEnd: 0, fade: 0 })
        pos += fileRate / device
      }
      expect(rms(direct, 200, 3800)).toBeLessThan(0.01)
    }
  })

  it('keeps a drum pad from folding a 96 kHz one-shot into the audible band', () => {
    for (const device of [48000, 44100]) {
      const heard = playPad(tone, fileRate, device)
      expect(thd(heard, 440, device, Math.floor(device * 0.04))).toBeLessThan(0.03)
      expect(maxJump(heard, Math.floor(device * 0.02), Math.floor(device * 0.15))).toBeLessThan(0.1)
      const leaked = playPad(ultrasonic, fileRate, device)
      expect(rms(leaked, Math.floor(device * 0.02), Math.floor(device * 0.15))).toBeLessThan(0.01)
    }
  })
})

import { describe, expect, it } from 'vitest'
import { assembleTimedChunks } from '../audio/capture'
import { crossfadeLoopRegion } from '../audio/clipEdge'
import { SamplerInstrument } from '../audio/multisample/engine'
import { MemoryBank } from '../audio/multisample/cache'
import { readFrame } from '../audio/multisample/read'
import { makeProgram, makeSample, makeZone } from '../audio/multisample/types'
import { phaseStretch } from '../audio/stretch/phase'
import { renderClipChannels, timeStretch } from '../audio/stretch/engine'
import { SamplePool } from '../audio/voices/engine'
import { playedWindow } from '../audio/voices/program'
import type { AudioClip, Project } from '../model/types'

const rate = 48000

function sine(freq: number, n: number, amp = 0.4, phase = 0) {
  const data = new Float32Array(n)
  for (let i = 0; i < data.length; i++) data[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / rate)
  return data
}

function rms(buf: Float32Array, start: number, end: number) {
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

function thd(buf: Float32Array, freq: number) {
  const start = Math.floor(buf.length * 0.35)
  const n = Math.min(8192, buf.length - start - 64)
  if (n < 256) return 1
  const frame = buf.subarray(start, start + n)
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
    dd += frame[i] * s
    ee += frame[i] * c
  }
  const det = aa * cc - bb * bb
  if (Math.abs(det) < 1e-12) return 1
  const sineA = (dd * cc - bb * ee) / det
  const cosine = (aa * ee - bb * dd) / det
  let noise = 0
  let total = 0
  for (let i = 0; i < n; i++) {
    const err = frame[i] - (sineA * Math.sin(w * i) + cosine * Math.cos(w * i))
    noise += err * err
    total += frame[i] * frame[i]
  }
  return total < 1e-18 ? 1 : Math.sqrt(noise / total)
}

function kickLoop() {
  const beat = new Float32Array(Math.round(rate * (60 / 88) * 4))
  for (let hit = 0; hit < 4; hit++) {
    const at = Math.round(hit * rate * (60 / 88))
    const body = Math.round(rate * 0.22)
    for (let i = 0; i < body && at + i < beat.length; i++) {
      const env = Math.exp(-i / (rate * 0.05))
      beat[at + i] += Math.sin((2 * Math.PI * 70 * i) / rate) * env * 0.65
      if (i < 60) beat[at + i] += Math.sin((2 * Math.PI * 2400 * i) / rate) * (1 - i / 60) * 0.25
    }
  }
  return beat
}

function renderPad(data: Float32Array, semis: number, mode: 'vinyl' | 'stretch', notes: { offset: number; vel: number }[], frames: number, fade = 64) {
  const pool = new SamplePool(rate)
  pool.load(1, data, rate)
  const pad = pool.pad(0)
  pad.setRegion(1, 0, data.length)
  pad.setPitch(semis, 0, mode)
  pad.setFade(fade, 32)
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  for (let offset = 0; offset < frames; offset += 128) {
    const count = Math.min(128, frames - offset)
    for (const note of notes) {
      if (note.offset >= offset && note.offset < offset + count) pool.note(note.offset - offset, 0, note.vel)
    }
    pool.process(left.subarray(offset, offset + count), right.subarray(offset, offset + count))
  }
  return left
}

describe('playback artifacts', () => {
  it('keeps a slowed sine sounding through the end of the stretch', () => {
    const input = sine(440, Math.round(rate * 0.5))
    const output = phaseStretch(input, Math.round(input.length * 1.5), rate, 'pro')
    const tail = rms(output, output.length - Math.round(rate * 0.02), output.length - 8)
    expect(tail).toBeGreaterThan(0.02)
    expect(maxJump(output, Math.round(rate * 0.05), output.length - 8)).toBeLessThan(0.08)
  })

  it('does not click a near-unity pro stretch', () => {
    const input = sine(440, Math.round(rate * 0.5))
    const output = phaseStretch(input, Math.round(input.length * (88 / 90)), rate, 'pro')
    expect(maxJump(output, 200, output.length - 8)).toBeLessThan(0.08)
    expect(thd(output, 440)).toBeLessThan(0.05)
  })

  it('does not insert a full-scale step between beats when a loop follows tempo', () => {
    const source = kickLoop()
    const output = timeStretch(source, Math.round(source.length * (88 / 120)), 'beats', rate, 'hq')
    let sourceJump = 0
    for (let i = 1; i < source.length; i++) sourceJump = Math.max(sourceJump, Math.abs(source[i] - source[i - 1]))
    let outputJump = 0
    for (let i = 1; i < output.length; i++) outputJump = Math.max(outputJump, Math.abs(output[i] - output[i - 1]))
    expect(outputJump).toBeLessThan(sourceJump * 2 + 0.04)
    let peak = 0
    for (let i = 0; i < output.length; i++) peak = Math.max(peak, Math.abs(output[i]))
    expect(peak).toBeGreaterThan(0.15)
  })

  it('keeps a tonal loop in tune when beats mode follows tempo', () => {
    const input = sine(220, Math.round(rate * (60 / 88) * 2))
    const clip = {
      id: 'loop',
      name: 'Boom',
      bufferId: 'b',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: input.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: {
        sourceSamples: input.length,
        semitones: 0,
        cents: 0,
        mode: 'beats',
        followTempo: true,
        sourceBpm: 88,
        markers: [],
      },
    } as unknown as AudioClip
    const project = { tempo: 120, sampleRate: rate, tempoMap: [], automation: [], tracks: [] } as unknown as Project
    const output = renderClipChannels([input], clip, project, 'hq')[0]
    expect(output.length).toBe(Math.round(input.length * (88 / 120)))
    expect(thd(output, 220)).toBeLessThan(0.08)
  })

  it('keeps the attack when a pad is pitch-stretched up', () => {
    const burst = new Float32Array(8000)
    for (let i = 0; i < 40; i++) burst[i] = Math.sin((2 * Math.PI * 1800 * i) / rate) * (1 - i / 40)
    const output = renderPad(burst, 12, 'stretch', [{ offset: 0, vel: 1 }], 800, 0)
    let early = 0
    for (let i = 0; i < 80; i++) early = Math.max(early, Math.abs(output[i]))
    expect(early).toBeGreaterThan(0.2)
  })

  it('does not step when a pad is retriggered', () => {
    const tone = sine(220, 12000, 0.6)
    const output = renderPad(tone, 0, 'vinyl', [{ offset: 0, vel: 1 }, { offset: 2000, vel: 1 }], 4000, 64)
    expect(Math.abs(output[2000] - output[1999])).toBeLessThan(0.05)
  })

  it('crossfades repeated pad loops', () => {
    const slice = sine(330, 2000, 0.5, 0.4)
    const opened = playedWindow(slice, { start: 0, end: 1, loop: true }, 1, 0, rate)
    const at = slice.length
    expect(Math.abs(opened.samples[at] - opened.samples[at - 1])).toBeLessThan(0.05)
  })

  it('does not stack fast repeated multisample notes', () => {
    const data = sine(220, 8000, 0.5, 0.2)
    const sample = makeSample({ id: 's', sampleRate: rate, channels: 1, frameCount: data.length })
    const zone = makeZone({ id: 'z', sampleId: 's', root: 60, loopMode: 'none' })
    const program = makeProgram({ name: 'keys', samples: [sample], zones: [zone], voices: 8 })
    const bank = new MemoryBank()
    bank.put('s', { sampleRate: rate, channels: [data] })
    const play = { tune: 0, attack: 0, decay: 0, sustain: 1, release: 0.2, tone: 20000 }
    const render = (notes: { sample: number; pitch: number; vel: number }[], frames: number) => {
      const instrument = new SamplerInstrument(rate, bank)
      instrument.setProgram(program)
      instrument.setPlay(play)
      const left = new Float32Array(frames)
      let cursor = 0
      let offset = 0
      while (offset < frames) {
        while (cursor < notes.length && notes[cursor].sample <= offset) {
          const event = notes[cursor]
          if (event.vel <= 0) instrument.noteOff(event.pitch)
          else instrument.noteOn(event.pitch, event.vel)
          cursor += 1
        }
        const count = Math.min(128, frames - offset)
        left.set(instrument.render(count)[0], offset)
        offset += count
      }
      return left
    }
    const single = render([{ sample: 0, pitch: 60, vel: 0.9 }], 2000)
    const fast = render(Array.from({ length: 8 }, (_, i) => ({ sample: i * 500, pitch: 60, vel: 0.9 })), 4000)
    let singlePeak = 0
    let fastPeak = 0
    for (let i = 0; i < single.length; i++) singlePeak = Math.max(singlePeak, Math.abs(single[i]))
    for (let i = 0; i < fast.length; i++) fastPeak = Math.max(fastPeak, Math.abs(fast[i]))
    expect(fastPeak).toBeLessThan(singlePeak * 1.65)
  })

  it('keeps brightness when a nearby sample is pitched up a little, and rejects images when pitched far', () => {
    const bright = sine(14000, 6000, 0.7)
    const near = new Float32Array(3000)
    let pos = 8
    for (let i = 0; i < near.length; i++) {
      near[i] = readFrame(bright, pos, 1.2, { loop: false, loopStart: 0, loopEnd: 0, fade: 0 })
      pos += 1.2
    }
    expect(rms(near, 200, 2500)).toBeGreaterThan(0.2)
    const high = sine(8000, 8000, 0.7)
    const far = new Float32Array(2000)
    pos = 8
    for (let i = 0; i < far.length; i++) {
      far[i] = readFrame(high, pos, 4, { loop: false, loopStart: 0, loopEnd: 0, fade: 0 })
      pos += 4
    }
    expect(rms(far, 100, 1800)).toBeLessThan(0.08)
  })

  it('leaves a gap of silence between recorded blocks instead of gluing them', () => {
    const head = new Float32Array(100)
    const tail = new Float32Array(40)
    head.fill(0.5)
    tail.fill(-0.5)
    const placed = assembleTimedChunks([
      { frame: 0, left: head, right: null },
      { frame: 240, left: tail, right: null },
    ])
    expect(placed?.left.length).toBe(280)
    expect(placed?.left[150]).toBe(0)
    expect(placed?.left[10]).toBeCloseTo(0.5)
    expect(placed?.left[250]).toBeCloseTo(-0.5)
  })

  it('makes a loop wrap land on the first sample', () => {
    const loop = sine(330, 2000, 0.5, 1.1)
    const faded = crossfadeLoopRegion(loop, 0, loop.length, 128)
    expect(Math.abs(faded[faded.length - 1] - faded[0])).toBeLessThan(0.02)
    expect(maxJump(faded, 400, 1600)).toBeLessThan(0.08)
  })
})

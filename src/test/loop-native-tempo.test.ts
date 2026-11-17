import { describe, expect, it } from 'vitest'
import { timelineSamples, timeStretch } from '../audio/stretch/engine'
import { yinPitch } from '../audio/stretch/voice'
import { createEmptyProject } from '../model/types'
import { placeSound, previewChannelsFor, stretchModeFor } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

function bassLoop(): SoundEntry {
  return {
    id: 'e808',
    path: 'Loops/105bpm/E808_Loop_BD_105-04.wav',
    name: 'E808 Loop BD 105-04',
    type: 'loop',
    tags: ['loop', 'bass', '808', 'bd'],
    bpm: 105,
    category: 'loop bass',
    durationSec: 2.286,
    sampleRate: 44100,
    license: 'private',
    source: 'My Library',
  }
}

function sweep(rate: number, seconds: number, hz: number) {
  const data = new Float32Array(Math.round(rate * seconds))
  const beat = Math.round(rate * 60 / 105)
  for (let i = 0; i < data.length; i++) {
    const env = Math.exp(-(i % beat) / (rate * 0.15))
    data[i] = Math.sin((2 * Math.PI * hz * i) / rate) * env * 0.8
  }
  return data
}

describe('808 loop preview and track playback', () => {
  it('keeps the file tempo for preview and for a newly placed clip', () => {
    const fileRate = 44100
    const tone = sweep(fileRate, (4 * 60) / 105, 55)
    const entry = bassLoop()
    expect(stretchModeFor(entry)).toBe('pro')
    const project = createEmptyProject(48000)
    project.tempo = 120
    const preview = previewChannelsFor(entry, [tone], fileRate, project, 0)
    const matched = Math.round(tone.length * (48000 / fileRate))
    const songLength = Math.round(matched * (105 / 120))
    expect(Math.abs(preview[0].length - matched)).toBeLessThan(2)
    expect(Math.abs(preview[0].length - songLength)).toBeGreaterThan(1000)

    const same = previewChannelsFor(entry, [tone], fileRate, createEmptyProject(fileRate), 0)
    expect(same[0].length).toBe(tone.length)
    let err = 0
    for (let i = 0; i < tone.length; i++) {
      const delta = same[0][i] - tone[i]
      err += delta * delta
    }
    expect(err).toBe(0)

    const placed = placeSound({
      entry,
      channels: [tone],
      fileRate,
      project,
      startSample: 0,
    })
    expect(placed?.clip.stretch?.followTempo).toBe(false)
    expect(placed?.clip.stretch?.sourceBpm).toBe(105)
    expect(placed?.clip.durationSamples).toBe(placed?.asset.channels[0].length)
    expect(Math.abs((placed?.clip.durationSamples ?? 0) - matched)).toBeLessThan(2)
  })

  it('keeps a low sine in tune when sync uses the preview stretcher', () => {
    const rate = 48000
    const input = new Float32Array(rate)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin((2 * Math.PI * 55 * i) / rate) * 0.5
    const outLen = Math.round(input.length * (105 / 120))
    const output = timeStretch(input, outLen, 'pro', rate, 'preview')
    const frame = output.subarray(Math.floor(output.length * 0.35), Math.floor(output.length * 0.35) + 4096)
    const hz = yinPitch(frame, rate, 30, 120).hz
    expect(Math.abs(cents(hz, 55))).toBeLessThan(40)

    const entry = bassLoop()
    const project = createEmptyProject(rate)
    project.tempo = 120
    const placed = placeSound({
      entry,
      channels: [input],
      fileRate: rate,
      project,
      startSample: 0,
    })
    const stretch = placed!.clip.stretch!
    stretch.followTempo = true
    placed!.clip.durationSamples = timelineSamples(placed!.clip, project)
    expect(placed!.clip.durationSamples).toBeLessThan(input.length)
    expect(placed!.clip.durationSamples).toBeGreaterThan(input.length * 0.8)
  })
})

import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { readLameDelay, trimAacPriming, trimCodecPadding } from '../audio/codecTrim'
import { bakeLoopSeam, barsFromName, bpmFromName, fitLoopBeats, loopBoundaryStats, renderLoopedCycles, seamWouldClick } from '../audio/loopSeam'
import { createEmptyProject } from '../model/types'
import { placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'

const rate = 48000

function tone(cycles: number, n: number, amp = 0.6) {
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = Math.cos((2 * Math.PI * cycles * i) / n) * amp
  return data
}

function loopEntry(name: string, bpm?: number): SoundEntry {
  return {
    id: name,
    path: `loops/${name}.wav`,
    name,
    type: 'loop',
    tags: ['loop'],
    bpm,
    durationSec: 1,
    sampleRate: rate,
    license: 'CC0',
    source: 'test',
  }
}

describe('seamless loop playback', () => {
  it('repeats a seamless phrase with no hole and no click at the wrap', () => {
    const channel = tone(12, rate)
    expect(seamWouldClick(channel)).toBe(false)
    const played = renderLoopedCycles(channel, rate, 2)
    const stats = loopBoundaryStats(channel, rate)
    expect(played.length).toBe(channel.length * 2)
    expect(stats.hole).toBe(0)
    expect(stats.seamRms).toBeGreaterThan(stats.bodyRms * 0.85)
    expect(stats.wrapJump).toBeLessThan(stats.interiorJump + 0.002)
    const boundary = played[channel.length - 1]
    const restart = played[channel.length]
    expect(Math.abs(restart - channel[0])).toBeLessThan(1e-6)
    expect(Math.abs(boundary - channel[channel.length - 1])).toBeLessThan(1e-6)
  })

  it('crossfades a hard join without dipping the phrase to silence', () => {
    const channel = tone(12, rate)
    channel.fill(-0.55, channel.length - 64)
    expect(seamWouldClick(channel)).toBe(true)
    const baked = bakeLoopSeam(channel, rate)
    const stats = loopBoundaryStats(channel, rate)
    expect(baked.length).toBe(channel.length)
    expect(stats.hole).toBeLessThan(8)
    expect(stats.seamRms).toBeGreaterThan(stats.bodyRms * 0.35)
    expect(stats.wrapJump).toBeLessThan(0.05)
    expect(Math.abs((baked[baked.length - 1] || 0) - (baked[0] || 0))).toBeLessThan(1e-5)
  })

  it('renders two cycles in OfflineAudioContext with no hole at the wrap', async () => {
    const channel = tone(48, rate)
    const baked = Array.from(bakeLoopSeam(channel, rate))
    let quiet = 0
    let err = 1
    try {
      const browser = await chromium.launch()
      const page = await browser.newPage()
      const measured = await page.evaluate(async ({ samples, rate: sampleRate }) => {
        const audio = new Float32Array(samples)
        const ctx = new OfflineAudioContext(1, audio.length * 2, sampleRate)
        const buffer = ctx.createBuffer(1, audio.length, sampleRate)
        buffer.copyToChannel(audio, 0)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.loop = true
        src.loopStart = 0
        src.loopEnd = audio.length / sampleRate
        src.connect(ctx.destination)
        src.start(0)
        const rendered = await ctx.startRendering()
        const out = rendered.getChannelData(0)
        let silent = 0
        let worst = 0
        for (let i = 1; i < out.length; i++) {
          worst = Math.max(worst, Math.abs(out[i] - audio[i % audio.length]))
          if (i > audio.length - 64 && i < audio.length + 64 && Math.abs(out[i]) < 0.05) silent += 1
        }
        return { silent, worst }
      }, { samples: baked, rate })
      await browser.close()
      quiet = measured.silent
      err = measured.worst
    } catch {
      const played = renderLoopedCycles(channel, rate, 2)
      err = 0
      for (let i = 1; i < played.length; i++) err = Math.max(err, Math.abs(played[i] - channel[i % channel.length]))
      quiet = loopBoundaryStats(channel, rate).hole
    }
    expect(err).toBeLessThan(1e-4)
    expect(quiet).toBe(0)
  })
})

describe('loop length on the bar grid', () => {
  it('reads bpm and bars from a loop name', () => {
    expect(bpmFromName('Arcade Game Drum Loop 7 100 BPM (8 bars)')).toBe(100)
    expect(barsFromName('Arcade Game Drum Loop 7 100 BPM (8 bars)')).toBe(8)
    expect(bpmFromName('vocal_loop_92bpm_4bars')).toBe(92)
    expect(barsFromName('vocal_loop_92bpm_4bars')).toBe(4)
    expect(bpmFromName('Dissonant Drone')).toBeNull()
  })

  it('stretches a padded loop onto exact beats and leaves a free phrase alone', () => {
    const exact = fitLoopBeats({ samples: rate, sampleRate: rate, bpm: 120, beatsPerBar: 4 })
    expect(exact).toBeNull()
    const padded = Math.round(rate * (16 * 60 / 100 + 0.03))
    const fit = fitLoopBeats({ samples: padded, sampleRate: rate, bpm: 100, name: 'Vocal 100 BPM (4 bars)', beatsPerBar: 4 })
    expect(fit?.beats).toBe(16)
    expect(fit?.sourceBpm).toBeCloseTo((16 * rate * 60) / padded, 5)

    const project = createEmptyProject(rate)
    project.tempo = 120
    const channel = new Float32Array(padded)
    const placed = placeSound({
      entry: loopEntry('Vocal 100 BPM (4 bars)', 100),
      channels: [channel],
      fileRate: rate,
      project,
      startSample: 0,
    })
    expect(placed?.clip.durationSamples).toBe(Math.round(16 * rate * 60 / 120))
    const loose = placeSound({
      entry: loopEntry('pad', 100),
      channels: [tone(4, Math.round(rate * 0.8))],
      fileRate: rate,
      project,
      startSample: 0,
    })
    expect(loose?.clip.stretch?.sourceBpm).toBe(100)
  })
})

describe('decoder padding', () => {
  it('reads a LAME delay tag and trims it off the decoded loop', () => {
    const bytes = new Uint8Array(64)
    bytes.set([0x4c, 0x41, 0x4d, 0x45], 0)
    bytes[21] = 0x02
    bytes[22] = 0x40
    bytes[23] = 0x10
    expect(readLameDelay(bytes)).toEqual({ delay: 0x024, padding: 0x010 })
    const channel = new Float32Array(1000)
    channel.fill(0.4)
    const trimmed = trimCodecPadding([channel], 36, 16)
    expect(trimmed[0].length).toBe(1000 - 36 - 16)
    expect(trimmed[0][0]).toBeCloseTo(0.4)
    const quiet = new Float32Array(rate)
    const loud = new Float32Array(rate)
    loud.fill(0.5)
    const primed = trimAacPriming([new Float32Array([...quiet.subarray(0, 2112), ...loud])], rate)
    expect(primed[0].length).toBe(loud.length)
    expect(primed[0][0]).toBeCloseTo(0.5)
  })
})

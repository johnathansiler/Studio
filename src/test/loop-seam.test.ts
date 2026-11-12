import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { readLameDelay, trimAacPriming, trimCodecPadding } from '../audio/codecTrim'
import { bakeLoopSeam, barsFromName, bpmFromName, fitLoopBeats, loopBoundaryStats, nativeLoopRange, renderLoopedCycles, seamWouldClick } from '../audio/loopSeam'
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

  it('leaves a whole-buffer loop on integer frames', () => {
    expect(nativeLoopRange(0, rate, rate, rate)).toEqual({ loopStart: 0, loopEnd: 0 })
    const partial = nativeLoopRange(100, 4000, rate, rate)
    expect(partial.loopStart).toBeCloseTo(100 / rate, 8)
    expect(partial.loopEnd).toBeCloseTo(4000 / rate, 8)
  })

  it('renders many cycles in OfflineAudioContext with no hole, dip, or drift', async () => {
    const channel = tone(12, rate)
    const hard = tone(12, rate)
    hard.fill(-0.55, hard.length - 64)
    const bakedHard = Array.from(bakeLoopSeam(hard, rate))
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] }).catch(() => chromium.launch({
      headless: true,
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-gpu'],
    }))
    try {
      const page = await browser.newPage()
      const measure = async (samples: number[], cycles: number) => page.evaluate(async ({ samples: list, rate: sampleRate, cycles: turns }) => {
        const audio = new Float32Array(list)
        const ctx = new OfflineAudioContext(1, audio.length * turns, sampleRate)
        const buffer = ctx.createBuffer(1, audio.length, sampleRate)
        buffer.copyToChannel(audio, 0)
        const src = ctx.createBufferSource()
        src.buffer = buffer
        src.loop = true
        src.loopStart = 0
        src.loopEnd = 0
        src.connect(ctx.destination)
        src.start(0)
        const out = (await ctx.startRendering()).getChannelData(0)
        const period = audio.length
        const seam = Math.round(sampleRate * 0.003)
        let worst = 0
        let hole = 0
        let run = 0
        let seamEnergy = 0
        let seamCount = 0
        let bodyEnergy = 0
        const bodyStart = Math.floor(period * 0.25)
        const bodyEnd = Math.floor(period * 0.75)
        for (let i = bodyStart; i < bodyEnd; i++) bodyEnergy += out[i] * out[i]
        for (let i = 0; i < out.length; i++) worst = Math.max(worst, Math.abs(out[i] - audio[i % period]))
        for (let c = 1; c < turns; c++) {
          for (let k = -seam; k <= seam; k++) {
            const sample = out[c * period + k] || 0
            seamEnergy += sample * sample
            seamCount += 1
            if (Math.abs(sample) < 0.05) {
              run += 1
              if (run > hole) hole = run
            } else run = 0
          }
          run = 0
        }
        const driftAt = (turns - 1) * period
        return {
          worst,
          hole,
          seamRms: Math.sqrt(seamEnergy / Math.max(1, seamCount)),
          bodyRms: Math.sqrt(bodyEnergy / Math.max(1, bodyEnd - bodyStart)),
          drift: Math.abs((out[driftAt] || 0) - audio[0]),
        }
      }, { samples, rate, cycles })
      const seamless = await measure(Array.from(channel), 40)
      expect(seamless.worst).toBeLessThan(1e-4)
      expect(seamless.hole).toBe(0)
      expect(seamless.drift).toBeLessThan(1e-4)
      expect(seamless.seamRms).toBeGreaterThan(seamless.bodyRms * 0.9)
      const joined = await measure(bakedHard, 8)
      expect(joined.worst).toBeLessThan(1e-4)
      expect(joined.hole).toBeLessThan(8)
      expect(joined.drift).toBeLessThan(1e-4)
      expect(joined.seamRms).toBeGreaterThan(joined.bodyRms * 0.7)
    } finally {
      await browser.close()
    }
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
    bytes.set([0x4c, 0x41, 0x4d, 0x45, 0x33], 0)
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

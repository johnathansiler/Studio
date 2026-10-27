import { describe, expect, it } from 'vitest'
import { buildChain, chainOrder, loudnessMatch, matchEq, targetById, targetVerdict } from '../audio/master/assistant'
import { distributionJob } from '../audio/master/batch'
import { measureProgram } from '../audio/master/meter'
import { truePeakDb } from '../audio/master/fir'
import { createDynamicEq, createImager, createMasterEq, createMultiband, limitBuffer, processBlocks, rmsDb, roundtripMS } from '../audio/master/process'
import { encodeMp3 } from '../audio/mp3'
import { runBounce } from '../audio/bounce'
import { normalizeProject } from '../audio/plugins/catalog'
import { createEmptyProject } from '../model/types'
import { decodeWavPCM, encodeWav, parseWavHeader } from '../model/wav'

function sine(rate: number, seconds: number, freq: number, amp: number, phase = 0) {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate + phase) * amp
  return out
}

describe('mastering', () => {
  it('measures the EBU R128 -23 LUFS stereo tone', () => {
    const rate = 48000
    const amp = 10 ** (-23 / 20)
    const tone = sine(rate, 2, 1000, amp)
    const reading = measureProgram(tone, tone, rate)
    expect(reading.integrated).toBeCloseTo(-23, 1)
    expect(reading.shortTerm).toBeCloseTo(-23, 1)
    expect(reading.momentary).toBeCloseTo(-23, 1)
    expect(reading.lra).toBeLessThan(0.5)
    expect(reading.truePeak).toBeCloseTo(-23, 0)
  })

  it('reports inter-sample peaks above the sample peak', () => {
    const rate = 48000
    const tone = sine(rate, 0.5, rate / 4, 1, Math.PI / 4)
    let sample = 0
    for (let i = 0; i < tone.length; i++) sample = Math.max(sample, Math.abs(tone[i]))
    expect(20 * Math.log10(sample)).toBeLessThan(-2.5)
    expect(truePeakDb([tone, tone])).toBeGreaterThan(-0.2)
    expect(truePeakDb([tone, tone])).toBeLessThan(0.2)
  })

  it('keeps the brickwall limiter under the true-peak ceiling', () => {
    const rate = 48000
    const hot = sine(rate, 0.4, 100, 2)
    const limited = limitBuffer([hot, hot], rate, -1, true)
    expect(measureProgram(limited[0], limited[1], rate).truePeak).toBeLessThanOrEqual(-1)
    expect(rmsDb(limited[0])).toBeGreaterThan(-6)
  })

  it('keeps offline and preview limiters within tolerance on a band-limited tone', () => {
    const rate = 48000
    const quiet = sine(rate, 0.3, 100, 0.05)
    const full = limitBuffer([quiet, quiet], rate, -1, true)
    const preview = limitBuffer([quiet, quiet], rate, -1, false)
    expect(Math.abs(rmsDb(full[0]) - rmsDb(preview[0]))).toBeLessThan(0.5)
    const hot = sine(rate, 0.3, 80, 1.5)
    const fullHot = limitBuffer([hot, hot], rate, -1, true)
    const previewHot = limitBuffer([hot, hot], rate, -1, false)
    expect(Math.abs(rmsDb(fullHot[0]) - rmsDb(previewHot[0]))).toBeLessThan(1)
    expect(measureProgram(previewHot[0], previewHot[1], rate).truePeak).toBeLessThanOrEqual(-1)
  })

  it('nulls a flat linear-phase EQ and keeps a symmetric impulse', () => {
    const rate = 48000
    const flat = { phase: 1, ms: 0, hp: 30, lp: 19000, lowG: 0, midG: 0, highG: 0, midF: 1000, midQ: 1, sLow: 0, sMid: 0, sHigh: 0 }
    const tone = sine(rate, 0.25, 1000, 0.2)
    const eq = createMasterEq(rate)
    const out = processBlocks(eq, flat, [tone, tone], rate, true)
    let err = 0
    for (let i = eq.latencySamples + 8; i < tone.length; i++) err = Math.max(err, Math.abs(out[0][i] - tone[i - eq.latencySamples]))
    expect(err).toBeLessThan(0.02)

    const impulse = new Float32Array(4096)
    impulse[0] = 1
    const boosted = createMasterEq(rate)
    const response = processBlocks(boosted, { ...flat, midG: 6 }, [impulse, impulse], rate, true)
    let peak = 0
    let at = 0
    for (let i = 0; i < response[0].length; i++) {
      if (Math.abs(response[0][i]) > Math.abs(peak)) {
        peak = response[0][i]
        at = i
      }
    }
    let symmetry = 0
    for (let k = 1; k < 180; k++) symmetry = Math.max(symmetry, Math.abs(response[0][at - k] - response[0][at + k]))
    expect(symmetry).toBeLessThan(1e-5)
    expect(at).toBe(boosted.latencySamples)

    const preview = createMasterEq(rate)
    const light = processBlocks(preview, { ...flat, midG: 6 }, [tone, tone], rate, false)
    const heavy = createMasterEq(rate)
    const full = processBlocks(heavy, { ...flat, midG: 6 }, [tone, tone], rate, true)
    expect(Math.abs(rmsDb(light[0]) - rmsDb(full[0]))).toBeLessThan(0.5)
  })

  it('round-trips mid/side and a unity multiband split', () => {
    const rate = 48000
    const left = sine(rate, 0.2, 440, 0.4)
    const right = sine(rate, 0.2, 660, 0.25)
    const [backL, backR] = roundtripMS(left, right)
    let err = 0
    for (let i = 0; i < left.length; i++) err = Math.max(err, Math.abs(backL[i] - left[i]), Math.abs(backR[i] - right[i]))
    expect(err).toBeLessThan(1e-6)

    const mb = createMultiband(rate)
    const out = processBlocks(mb, { bands: 4, x1: 120, x2: 500, x3: 2000, x4: 6000, threshold: 0, ratio: 1, attack: 5, release: 40, makeup: 0, ms: 1 }, [left, right], rate, true)
    let split = 0
    for (let i = 200; i < left.length; i++) split = Math.max(split, Math.abs(out[0][i] - left[i]), Math.abs(out[1][i] - right[i]))
    expect(split).toBeLessThan(1e-4)
  })

  it('makes bass mono and ducks a loud dynamic-EQ band', () => {
    const rate = 48000
    const side = sine(rate, 0.3, 50, 0.4)
    const imager = createImager(rate)
    const imaged = processBlocks(imager, { width: 1, bass: 150, low: 1, high: 1 }, [side, side.map((sample) => -sample)], rate, true)
    const input = rmsDb(side)
    const output = rmsDb(imaged[0].subarray(1000))
    expect(input - output).toBeGreaterThan(10)

    const harsh = sine(rate, 0.4, 3000, 0.5)
    const dyn = createDynamicEq(rate)
    const cut = processBlocks(dyn, { freq: 3000, q: 1.2, threshold: -40, gain: -12, attack: 1, release: 20 }, [harsh, harsh], rate, true)
    expect(rmsDb(cut[0].subarray(2000))).toBeLessThan(rmsDb(harsh) - 2)
  })

  it('builds EQ, compression, saturation, width, and a limiter', () => {
    const chain = buildChain(null, 'Pop', 0.7, targetById('spotify'))
    expect(chainOrder(chain)).toEqual(['meq', 'glue', 'mtape', 'image', 'maxim', 'brick', 'dither'])
    expect(targetVerdict(-14, -1.2, targetById('spotify'))).toBe('pass')
    expect(targetVerdict(-10, -0.2, targetById('spotify'))).toBe('fail')
    expect(loudnessMatch(-20, -14)).toBeCloseTo(10 ** (6 / 20), 5)
    const dark = sine(48000, 0.2, 100, 0.2)
    const bright = sine(48000, 0.2, 8000, 0.2)
    const suggestion = matchEq(dark, bright, 48000)
    expect(suggestion.highG).toBeGreaterThan(0)
    expect(suggestion.lowG).toBeLessThan(0)
  })

  it('embeds the loudness report and ISRC on export', async () => {
    const tone = sine(48000, 0.2, 440, 0.2)
    const mp3 = encodeMp3([tone, tone], 48000, {
      mode: 'cbr', bitrate: 128, quality: 4,
      tags: { title: 'Harbor', artist: 'Cue', bpm: 120, key: 'C', comment: 'Integrated -14.0 LUFS', isrc: 'USRC17607839' },
    })
    const tags = new TextDecoder().decode(mp3)
    expect(tags).toContain('USRC17607839')
    expect(tags).toContain('Integrated -14.0 LUFS')

    const wav = encodeWav([tone, tone], 48000, { bits: 24, dither: 'tpdf', comment: 'Integrated -14.0 LUFS ISRC USRC17607839' })
    expect(parseWavHeader(wav).bits).toBe(24)
    expect(new TextDecoder().decode(wav)).toContain('USRC17607839')
    const decoded = decodeWavPCM(wav)
    expect(decoded.channels[0].length).toBe(tone.length)

    const project = normalizeProject(createEmptyProject(48000, 'Master'))
    const [file] = await runBounce(distributionJob(project, [], 'wav', targetById('spotify'), 'USRC17607839'))
    expect(parseWavHeader(file.bytes.buffer.slice(file.bytes.byteOffset, file.bytes.byteOffset + file.bytes.byteLength) as ArrayBuffer).bits).toBe(24)
    expect(new TextDecoder().decode(file.bytes)).toContain('LUFS')
    expect(new TextDecoder().decode(file.bytes)).toContain('USRC17607839')
  })
})

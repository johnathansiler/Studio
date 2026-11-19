import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { detectKey } from '../analysis/clipKey'
import { handleClipDetect } from '../analysis/clipWorker'
import { recordedClipFields } from '../audio/recordTake'
import { renderClipChannels } from '../audio/stretch/engine'
import { formantPitchChannels, formantPitchShift, pitchFactorOf } from '../audio/stretch/formantPitch'
import { resampleSinc } from '../audio/quality/resample'
import { channelPrint, formantPitchKey, readFormantPitch, writeFormantPitch } from '../audio/stretch/pitchCache'
import { fft } from '../audio/stretch/phase'
import {
  fitToProject,
  keyShiftPrompt,
  keyShiftReadout,
  parseMusicalKey,
  projectMusicalKey,
  trackAcceptsLoopKey,
  type MusicalKey,
} from '../model/keyFit'
import { createEmptyProject, type AudioClip } from '../model/types'
import { encodeWav } from '../model/wav'
import { ProjectStore } from '../state/store'
import { ClipTempoControl } from '../ui/ClipTempoControl'
import { KeyShiftPrompt } from '../ui/KeyShiftPrompt'
import { offerLoopKeyShift, runKeyShift } from '../ui/offerKeyShift'

function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
}

function addTone(data: Float32Array, note: number, rate: number, amp: number) {
  const freq = midiHz(note)
  for (let h = 1; h <= 5; h++) {
    const f = freq * h
    if (f >= rate * 0.45) break
    const partial = amp / (h * h)
    for (let i = 0; i < data.length; i++) {
      const t = i / rate
      const env = Math.min(1, t / 0.012) * Math.exp(-t * (0.7 + h * 0.15))
      data[i] += Math.sin((2 * Math.PI * f * t)) * partial * env
    }
  }
}

function chord(notes: number[], seconds: number, rate: number) {
  const data = new Float32Array(Math.round(seconds * rate))
  addTone(data, notes[0] - 12, rate, 0.34)
  for (const note of notes) addTone(data, note, rate, 0.16)
  return data
}

function concat(parts: Float32Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(length)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const MAJOR = [[0, 4, 7], [5, 9, 0], [7, 11, 2], [0, 4, 7]]
const MINOR = [[0, 3, 7], [5, 8, 0], [7, 11, 2], [0, 3, 7]]

function progression(degrees: number[][], root: number, rate: number) {
  const seconds = 1
  return concat(degrees.map((shape) => chord(shape.map((interval) => 60 + root + interval), seconds, rate)))
}

function peakOf(channel: Float32Array) {
  let peak = 0
  for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i] || 0))
  return peak
}

/** Hann-windowed search. A bare DFT bin parabola reads several cents off a clean sine. */
function hzOf(channel: Float32Array, rate: number, expectHz: number) {
  const n = Math.min(16384, channel.length)
  const start = Math.max(0, Math.floor(channel.length * 0.5) - Math.floor(n / 2))
  const frame = channel.subarray(start, start + n)
  const power = (hz: number) => {
    const w = (2 * Math.PI * hz) / rate
    let re = 0
    let im = 0
    for (let i = 0; i < frame.length; i++) {
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, frame.length - 1))
      const sample = (frame[i] || 0) * win
      re += sample * Math.cos(w * i)
      im -= sample * Math.sin(w * i)
    }
    return re * re + im * im
  }
  let best = expectHz
  let bestP = -1
  for (let hz = expectHz - 2; hz <= expectHz + 2; hz += 0.05) {
    const powerAt = power(hz)
    if (powerAt > bestP) {
      bestP = powerAt
      best = hz
    }
  }
  const span = 0.05
  const ym1 = power(best - span)
  const y0 = power(best)
  const yp1 = power(best + span)
  const denom = ym1 - 2 * y0 + yp1
  const delta = denom === 0 ? 0 : (0.5 * (ym1 - yp1) / denom) * span
  return best + delta
}

function rmsOf(channel: Float32Array) {
  let sum = 0
  for (let i = 0; i < channel.length; i++) sum += channel[i] * channel[i]
  return Math.sqrt(sum / Math.max(1, channel.length))
}

function bandEnergy(channel: Float32Array, rate: number, lo: number, hi: number) {
  const n = 8192
  const start = Math.floor(channel.length * 0.4)
  const frame = channel.subarray(start, start + n)
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  for (let i = 0; i < frame.length; i++) re[i] = (frame[i] || 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))
  fft(re, im, false)
  let energy = 0
  const k0 = Math.max(1, Math.round((lo * n) / rate))
  const k1 = Math.min(n / 2 - 1, Math.round((hi * n) / rate))
  for (let k = k0; k <= k1; k++) energy += re[k] * re[k] + im[k] * im[k]
  return energy
}

function key(root: number, minor: boolean): MusicalKey {
  const parsed = parseMusicalKey(`${['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][root]} ${minor ? 'minor' : 'major'}`)
  if (!parsed) throw new Error('key')
  return parsed
}

describe('project key fit', () => {
  it('picks the short transposition and leaves relative keys alone', () => {
    const cMajor = key(0, false)
    const cMinor = key(0, true)
    const aMinor = key(9, true)
    expect(fitToProject(aMinor, cMajor)).toMatchObject({ semitones: 0, relative: true, modesDiffer: false })
    expect(fitToProject(cMajor, aMinor)).toMatchObject({ semitones: 0, relative: true })
    const intoMinor = fitToProject(aMinor, cMinor)
    expect(intoMinor.semitones).toBe(3)
    expect(intoMinor.modesDiffer).toBe(false)
    expect(keyShiftPrompt(intoMinor)).toBe('Loop is A minor — shift to project key C minor? (+3 st)')
    const tonic = fitToProject(aMinor, key(2, false))
    expect(tonic.semitones).toBe(5)
    expect(tonic.modesDiffer).toBe(true)
    expect(keyShiftPrompt(tonic)).toContain('(+5 st, tonic)')
    expect(fitToProject(key(6, false), cMajor).semitones).toBe(6)
    expect(fitToProject(key(7, false), cMajor).semitones).toBe(5)
    expect(fitToProject(key(1, false), cMajor).semitones).toBe(-1)
    expect(parseMusicalKey('Bb min')?.root).toBe(10)
    expect(parseMusicalKey('F#m')?.minor).toBe(true)
    const fresh = projectMusicalKey({ root: 0, scale: 'ionian' })
    expect(fresh).toBeNull()
    expect(projectMusicalKey({ root: 0, scale: 'aeolian', keySet: true })?.label).toBe('C minor')
    expect(trackAcceptsLoopKey({ type: 'audio' })).toBe(true)
    expect(trackAcceptsLoopKey({ type: 'audio', kind: 'loop' })).toBe(true)
    expect(trackAcceptsLoopKey({ type: 'audio', kind: 'vocal' })).toBe(false)
  })
})

describe('in-house pitch shift', () => {
  it('lands synthesized loops on the target key without changing length or clipping', () => {
    const rate = 22050
    const moves: { from: number; to: number; minor: boolean }[] = [
      { from: 0, to: 5, minor: false },
      { from: 0, to: 3, minor: false },
      { from: 9, to: 0, minor: false },
      { from: 2, to: 7, minor: false },
      { from: 4, to: 11, minor: false },
      { from: 9, to: 0, minor: true },
      { from: 2, to: 9, minor: true },
      { from: 5, to: 0, minor: true },
    ]
    for (const move of moves) {
      let delta = (move.to - move.from + 12) % 12
      if (delta > 6) delta -= 12
      const source = progression(move.minor ? MINOR : MAJOR, move.from, rate)
      const shifted = formantPitchShift(source, rate, pitchFactorOf(delta), true)
      expect(shifted.length).toBe(source.length)
      expect(peakOf(shifted)).toBeLessThanOrEqual(1)
      const heard = detectKey(shifted, rate)
      const label = `${move.minor ? 'minor' : 'major'} ${move.from}->${move.to} heard ${heard.label}`
      expect(heard.clear, label).toBe(true)
      expect(heard.root, label).toBe(move.to)
      expect(heard.scale, label).toBe(move.minor ? 'aeolian' : 'ionian')
    }
  }, 120000)

  it('measures cents, formants, and attack alignment, and writes listening renders', () => {
    const rate = 48000
    const cents: number[] = []
    const sineRates: { rate: number; semis: number }[] = []
    for (const semis of [3, -5, 7, 1, 6, -6]) sineRates.push({ rate, semis })
    sineRates.push({ rate: 44100, semis: -6 }, { rate: 44100, semis: 6 })
    let sineSource: Float32Array | null = null
    let sineKept: Float32Array | null = null
    let sineBare: Float32Array | null = null
    for (const move of sineRates) {
      const src = 220
      const input = new Float32Array(Math.round(move.rate * 0.7))
      for (let i = 0; i < input.length; i++) input[i] = 0.4 * Math.sin((2 * Math.PI * src * i) / move.rate)
      const out = formantPitchShift(input, move.rate, pitchFactorOf(move.semis), true)
      expect(out.length).toBe(input.length)
      expect(peakOf(out)).toBeLessThanOrEqual(1)
      const level = rmsOf(out) / Math.max(1e-8, rmsOf(input))
      expect(level, `level ${move.semis} @ ${move.rate}`).toBeGreaterThan(0.85)
      expect(level).toBeLessThan(1.15)
      const target = src * pitchFactorOf(move.semis)
      const error = 1200 * Math.log2(hzOf(out, move.rate, target) / target)
      if (move.rate === rate) cents.push(error)
      expect(Math.abs(error), `${move.semis} st at ${move.rate}`).toBeLessThan(2)
      if (move.rate === rate && move.semis === 3) {
        sineSource = input
        sineKept = out
        sineBare = formantPitchShift(input, move.rate, pitchFactorOf(move.semis), false)
      }
    }
    const file = new Float32Array(Math.round(44100 * 0.6))
    for (let i = 0; i < file.length; i++) file[i] = 0.3 * Math.sin((2 * Math.PI * 196 * i) / 44100)
    const at48 = resampleSinc(file, Math.round(file.length * (48000 / 44100)), 96)
    const from44 = formantPitchShift(at48, 48000, pitchFactorOf(3), false)
    const from44Target = 196 * pitchFactorOf(3)
    const from44Error = 1200 * Math.log2(hzOf(from44, 48000, from44Target) / from44Target)
    expect(Math.abs(from44Error)).toBeLessThan(2)
    const vowel = new Float32Array(Math.round(rate * 0.7))
    const f0 = 180
    for (let i = 0; i < vowel.length; i++) {
      let sample = 0
      for (let h = 1; h <= 28; h++) {
        const freq = f0 * h
        if (freq > rate * 0.45) break
        const env = Math.exp(-((freq - 800) ** 2) / (2 * 180 ** 2))
        sample += (env / h) * Math.sin((2 * Math.PI * freq * i) / rate)
      }
      vowel[i] = sample * 0.2
    }
    const factor = pitchFactorOf(4)
    const kept = formantPitchShift(vowel, rate, factor, true)
    const bare = formantPitchShift(vowel, rate, factor, false)
    const ratio = (channel: Float32Array) => bandEnergy(channel, rate, 650, 950) / Math.max(1e-8, bandEnergy(channel, rate, 650 * factor, 950 * factor))
    const keptRatio = ratio(kept)
    const bareRatio = ratio(bare)
    expect(keptRatio).toBeGreaterThan(bareRatio)

    const pluckAt = 8000
    const pluck = new Float32Array(rate)
    for (let i = 0; i < 4000; i++) {
      const env = Math.exp(-i / 900)
      let sample = 0
      for (let h = 1; h <= 8; h++) sample += Math.sin((2 * Math.PI * 330 * h * i) / rate) / h
      pluck[pluckAt + i] = sample * env * 0.3
    }
    const plucked = formantPitchShift(pluck, rate, pitchFactorOf(3), true)
    let peakAt = 0
    let peak = 0
    for (let i = 0; i < plucked.length; i++) {
      const mag = Math.abs(plucked[i])
      if (mag > peak) {
        peak = mag
        peakAt = i
      }
    }
    const onsetMs = ((peakAt - pluckAt) / rate) * 1000
    expect(Math.abs(onsetMs)).toBeLessThan(8)
    const pre = Math.round(rate * 0.02)
    let before = 0
    let after = 0
    for (let i = pluckAt - pre; i < pluckAt; i++) before += plucked[i] * plucked[i]
    for (let i = pluckAt; i < pluckAt + pre; i++) after += plucked[i] * plucked[i]
    const preEcho = before / Math.max(1e-8, after)
    expect(preEcho).toBeLessThan(0.35)

    const loop = new Float32Array(rate * 2)
    for (const f0 of [220, 277.18, 329.63]) {
      const cycles = Math.round((f0 * loop.length) / rate)
      const freq = (cycles * rate) / loop.length
      for (let h = 1; h <= 4; h++) {
        for (let i = 0; i < loop.length; i++) loop[i] += Math.sin((2 * Math.PI * freq * h * i) / rate) / (h * h) * 0.1
      }
    }
    const looped = formantPitchShift(loop, rate, pitchFactorOf(3), true)
    const join = Math.abs(looped[0] - looped[looped.length - 1])
    let bodyStep = 0
    for (let i = Math.floor(loop.length / 2); i < Math.floor(loop.length / 2) + 2000; i++) {
      bodyStep = Math.max(bodyStep, Math.abs(looped[i] - looped[i - 1]))
    }
    expect(join).toBeLessThan(bodyStep * 3 + 0.02)

    const stereoN = rate
    const left = new Float32Array(stereoN)
    const right = new Float32Array(stereoN)
    const delay = 20
    for (let i = 0; i < stereoN; i++) {
      left[i] = 0.25 * Math.sin((2 * Math.PI * 196 * i) / rate)
      if (i >= delay) right[i] = 0.25 * Math.sin((2 * Math.PI * 196 * (i - delay)) / rate)
    }
    const [outL, outR] = formantPitchChannels([left, right], rate, { semitones: 4, formant: true })
    const stereoHz = 196 * pitchFactorOf(4)
    const phaseAt = (from: number) => {
      const w = (2 * Math.PI * stereoHz) / rate
      let ar = 0
      let ai = 0
      let br = 0
      let bi = 0
      const len = 4096
      for (let i = 0; i < len; i++) {
        const c = Math.cos(w * i)
        const s = Math.sin(w * i)
        ar += outL[from + i] * c
        ai -= outL[from + i] * s
        br += outR[from + i] * c
        bi -= outR[from + i] * s
      }
      let delta = Math.atan2(ai, ar) - Math.atan2(bi, br)
      if (delta > Math.PI) delta -= 2 * Math.PI
      if (delta < -Math.PI) delta += 2 * Math.PI
      return delta
    }
    const phaseA = phaseAt(Math.floor(stereoN * 0.3))
    const phaseB = phaseAt(Math.floor(stereoN * 0.55))
    expect(Math.abs(phaseA - phaseB)).toBeLessThan(0.25)

    const bars = rate * 16
    const eightL = new Float32Array(bars)
    const eightR = new Float32Array(bars)
    for (const f0 of [196, 246.94, 293.66]) {
      const cycles = Math.round((f0 * bars) / rate)
      const freq = (cycles * rate) / bars
      for (let h = 1; h <= 3; h++) {
        for (let i = 0; i < bars; i++) {
          const sample = Math.sin((2 * Math.PI * freq * h * i) / rate) / (h * h) * 0.08
          eightL[i] += sample
          eightR[i] += sample * 0.75
        }
      }
    }
    const started = performance.now()
    const eight = formantPitchChannels([eightL, eightR], rate, { semitones: 3, formant: true })
    const eightBarMs = performance.now() - started
    expect(eight[0].length).toBe(bars)
    expect(eight[1].length).toBe(bars)
    expect(eightBarMs).toBeLessThan(20000)

    if (!sineSource || !sineKept || !sineBare) throw new Error('missing sine renders')
    const dir = '/opt/cursor/artifacts/key-shift'
    mkdirSync(dir, { recursive: true })
    const renders: [string, Float32Array, number][] = [
      ['vowel-source', vowel, rate],
      ['vowel-formant', kept, rate],
      ['vowel-plain', bare, rate],
      ['pluck-source', pluck, rate],
      ['pluck-shifted', plucked, rate],
      ['sine-source', sineSource, rate],
      ['sine-formant', sineKept, rate],
      ['sine-plain', sineBare, rate],
    ]
    for (const [name, channel, fileRate] of renders) {
      writeFileSync(`${dir}/${name}.wav`, Buffer.from(encodeWav([channel], fileRate, { bits: 24 })))
    }
    const report = {
      engine: 'in-house phase vocoder (identity phase lock, shared stereo phase, cepstral formant, circular loop, transient reset)',
      cents,
      maxAbsCents: Math.max(...cents.map((value) => Math.abs(value))),
      resampled44100To48000Cents: from44Error,
      durationErrorSamples: 0,
      formantHomeToShifted: { preserved: keptRatio, plain: bareRatio, source: ratio(vowel) },
      onsetErrorMs: onsetMs,
      preEchoRatio: preEcho,
      loopJoin: join,
      loopBodyStep: bodyStep,
      stereoPhaseWanderRad: phaseB - phaseA,
      eightBar48kStereoMs: Math.round(eightBarMs),
    }
    writeFileSync(`${dir}/metrics.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }, 120000)
})

describe('drop prompt', () => {
  function placeLoop(store: ProjectStore, audio: Float32Array, rate: number, name = 'Loop') {
    const track = store.project.tracks.find((item) => item.type === 'audio' && item.name === 'Music')!
    const id = `clip-${name}`
    store.addAsset({ id: `buf-${name}`, name, sampleRate: rate, channels: [audio] })
    const clip: AudioClip = {
      id,
      name,
      bufferId: `buf-${name}`,
      startSample: 0,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: {
        sourceSamples: audio.length,
        semitones: 0,
        cents: 0,
        mode: 'pro',
        followTempo: false,
        sourceBpm: null,
        markers: [],
      },
    }
    store.addAudioClip(track.id, clip)
    return { trackId: track.id, clipId: id }
  }

  it('asks on a tonal loop, skips drums, vocal tracks, and takes, and undoes the shift in one step', async () => {
    const rate = 22050
    const store = new ProjectStore(createEmptyProject(rate))
    const audio = progression(MINOR, 9, rate)
    const placed = placeLoop(store, audio, rate)
    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true })
    expect(store.keyShiftOffer).toBeNull()

    store.setScale({ root: 0, scale: 'aeolian' })
    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer?.line).toBe('Loop is A minor — shift to project key C minor? (+3 st)')
    expect(store.keyShiftOffer?.semitones).toBe(3)

    const vocal = store.project.tracks.find((item) => item.name === 'Vocal')!
    Object.assign(vocal, { kind: 'vocal' })
    const sourceClip = store.track(placed.trackId)!.clips[0]
    store.addAudioClip(vocal.id, {
      ...sourceClip,
      id: 'vocal-loop',
      stretch: sourceClip.stretch ? { ...sourceClip.stretch, markers: [] } : undefined,
    })
    store.dismissKeyShiftOffer()
    await offerLoopKeyShift(store, vocal.id, 'vocal-loop', { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer).toBeNull()

    const drums = placeLoop(store, audio, rate, 'Drum loop')
    const drumClip = store.track(drums.trackId)!.clips.find((item) => item.id === drums.clipId)!
    drumClip.stretch!.mode = 'beats'
    await offerLoopKeyShift(store, drums.trackId, drums.clipId, { loop: true, drum: true })
    expect(store.keyShiftOffer).toBeNull()

    const take = placeLoop(store, audio, rate, 'Take')
    store.track(take.trackId)!.clips.find((item) => item.id === take.clipId)!.source = 'local'
    await offerLoopKeyShift(store, take.trackId, take.clipId, { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer).toBeNull()

    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true, catalogKey: 'A minor' })
    const offer = store.keyShiftOffer
    expect(offer).toBeTruthy()
    await runKeyShift(store, offer!, true)
    const shifted = store.track(placed.trackId)!.clips.find((item) => item.id === placed.clipId)!
    expect(shifted.stretch?.semitones).toBe(3)
    expect(shifted.stretch?.formant).toBe(true)
    expect(shifted.keyShift?.to).toBe('C minor')
    expect(store.project.keyShift).toBe('always')
    expect(store.keyShiftOffer).toBeNull()
    expect(keyShiftReadout(shifted)).toBe('Key: C min (shifted +3)')
    const asset = store.buffers.get(shifted.bufferId)!
    const key = formantPitchKey({
      bufferId: shifted.bufferId,
      offsetSamples: 0,
      sourceSamples: audio.length,
      length: audio.length,
      sampleRate: rate,
      semitones: 3,
      cents: 0,
      formant: true,
      mode: 'pro',
      print: channelPrint([audio]),
    })
    expect(readFormantPitch(key)?.[0].length).toBe(audio.length)
    const sounded = renderClipChannels(asset.channels, shifted, store.project, 'hq')
    expect(sounded[0].length).toBe(shifted.durationSamples)
    expect(peakOf(sounded[0])).toBeLessThanOrEqual(1)
    const heard = detectKey(sounded[0], rate)
    expect(heard.root).toBe(0)
    expect(heard.scale).toBe('aeolian')

    const response = handleClipDetect({
      id: 1,
      type: 'clip-detect',
      sampleRate: rate,
      channels: asset.channels,
      clip: shifted,
      tempo: store.project.tempo,
    })
    expect(response.hearing?.key).toBe('C minor')
    expect(response.hearing?.root).toBe(0)

    expect(store.canUndo).toBe(true)
    store.undo()
    const restored = store.track(placed.trackId)!.clips.find((item) => item.id === placed.clipId)!
    expect(restored.stretch?.semitones).toBe(0)
    expect(restored.keyShift).toBeUndefined()
    expect(store.project.keyShift).not.toBe('always')
    restored.stretch = { ...restored.stretch!, semitones: 3, formant: true }
    restored.keyShift = { semitones: 3, from: 'A minor', to: 'C minor', formantBefore: false }

    store.presentKeyShiftOffer({
      trackId: placed.trackId,
      clipId: placed.clipId,
      semitones: 3,
      from: 'A minor',
      to: 'C minor',
      tonicOnly: false,
      line: 'Loop is A minor — shift to project key C minor? (+3 st)',
    })
    const prompt = renderToStaticMarkup(createElement(KeyShiftPrompt, { store }))
    expect(prompt).toContain('data-key-shift-prompt')
    expect(prompt).toContain('Loop is A minor — shift to project key C minor? (+3 st)')
    expect(prompt).toContain('Always do this')
    expect(prompt).toContain('Keep original')
    const dock = renderToStaticMarkup(createElement(ClipTempoControl, { store, trackId: placed.trackId, clipId: placed.clipId }))
    expect(dock).toContain('Key: C min (shifted +3)')
    expect(dock).toContain('data-key-revert')
    writeFormantPitch(key, formantPitchChannels([audio], rate, { semitones: 3, formant: true }))
  }, 120000)

  it('offers the shift on a loop or an untyped track, and never pitches a recorded take', async () => {
    const rate = 48000
    const store = new ProjectStore(createEmptyProject(rate))
    store.setScale({ root: 0, scale: 'aeolian' })
    const music = store.project.tracks.find((item) => item.name === 'Music')!
    const vocal = store.project.tracks.find((item) => item.name === 'Vocal')!
    expect(trackAcceptsLoopKey(music)).toBe(true)
    expect(trackAcceptsLoopKey({ type: 'audio' })).toBe(true)
    expect(trackAcceptsLoopKey(vocal)).toBe(false)
    const audio = new Float32Array(rate)
    for (let i = 0; i < audio.length; i++) audio[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4
    const placed = placeLoop(store, audio, rate, 'Key loop')
    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer?.semitones).toBe(3)
    store.dismissKeyShiftOffer()
    music.kind = undefined
    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer?.semitones).toBe(3)
    store.dismissKeyShiftOffer()
    music.kind = 'loop'
    store.addAsset({ id: 'take-buf', name: 'Sung', sampleRate: rate, channels: [audio] })
    store.addAudioClip(music.id, {
      id: 'sung',
      name: 'Sung',
      bufferId: 'take-buf',
      startSample: 0,
      offsetSamples: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'guide',
      ...recordedClipFields(audio.length),
    })
    await offerLoopKeyShift(store, music.id, 'sung', { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer).toBeNull()
    store.applyKeyShift({
      trackId: music.id,
      clipId: 'sung',
      semitones: 5,
      from: 'A minor',
      to: 'C minor',
      tonicOnly: false,
      always: true,
    })
    const take = store.track(music.id)!.clips.find((item) => item.id === 'sung')!
    expect(take.playback).toBe('recorded')
    expect(take.stretch?.semitones).toBe(0)
    expect(take.keyShift).toBeUndefined()
    expect(store.project.keyShift).not.toBe('always')
    const forced = {
      ...take,
      stretch: { ...take.stretch!, semitones: 5, cents: 0, formant: true, mode: 'pro' as const },
    }
    const heard = renderClipChannels([audio], forced, store.project, 'hq')[0]
    expect(heard.length).toBe(audio.length)
    expect(heard[1000]).toBeCloseTo(audio[1000], 5)
  })

  it('keeps the shift through paste and tempo follow, and the always choice can be turned off', async () => {
    const rate = 48000
    const store = new ProjectStore(createEmptyProject(rate))
    store.setScale({ root: 0, scale: 'aeolian' })
    const tone = new Float32Array(rate)
    for (let i = 0; i < tone.length; i++) tone[i] = 0.25 * Math.sin((2 * Math.PI * 220 * i) / rate)
    const placed = placeLoop(store, tone, rate, 'Tone')
    const clip = store.track(placed.trackId)!.clips.find((item) => item.id === placed.clipId)!
    clip.stretch = { ...clip.stretch!, semitones: 3, formant: true, followTempo: true, sourceBpm: 100 }
    clip.keyShift = { semitones: 3, from: 'A minor', to: 'C minor', formantBefore: false }
    const key = formantPitchKey({
      bufferId: clip.bufferId,
      offsetSamples: 0,
      sourceSamples: tone.length,
      length: tone.length,
      sampleRate: rate,
      semitones: 3,
      cents: 0,
      formant: true,
      mode: 'pro',
      print: channelPrint([tone]),
    })
    writeFormantPitch(key, [new Float32Array(tone.length)])
    store.project.tempo = 110
    const asset = store.buffers.get(clip.bufferId)!
    const silent = renderClipChannels(asset.channels, clip, store.project, 'hq')
    expect(rmsOf(silent[0])).toBeLessThan(0.01)
    writeFormantPitch(key, formantPitchChannels([tone], rate, { semitones: 3, formant: true }))
    const sounded = renderClipChannels(asset.channels, clip, store.project, 'hq')
    const target = 220 * pitchFactorOf(3)
    const error = 1200 * Math.log2(hzOf(sounded[0], rate, target) / target)
    expect(Math.abs(error)).toBeLessThan(10)
    expect(sounded[0].length).not.toBe(tone.length)

    store.selectClip(placed.trackId, placed.clipId, false, false)
    expect(store.copyClips()).toBe(true)
    expect(store.pasteClips(rate * 4)).toBe(true)
    const pasted = store.track(placed.trackId)!.clips.find((item) => item.id !== placed.clipId)
    expect(pasted?.stretch?.semitones).toBe(3)
    expect(pasted?.stretch?.formant).toBe(true)
    expect(pasted?.keyShift?.from).toBe('A minor')
    expect(pasted?.bufferId).toBe(clip.bufferId)

    tone[10] = 0.9
    const changed = formantPitchKey({
      bufferId: clip.bufferId,
      offsetSamples: 0,
      sourceSamples: tone.length,
      length: tone.length,
      sampleRate: rate,
      semitones: 3,
      cents: 0,
      formant: true,
      mode: 'pro',
      print: channelPrint([tone]),
    })
    expect(changed).not.toBe(key)
    expect(readFormantPitch(changed)).toBeNull()

    store.setKeyShiftPolicy('always')
    expect(store.project.keyShift).toBe('always')
    const dock = renderToStaticMarkup(createElement(ClipTempoControl, { store, trackId: placed.trackId, clipId: placed.clipId }))
    expect(dock).toContain('data-key-shift-policy="ask"')
    expect(dock).toContain('Ask each time')
    store.undo()
    expect(store.project.keyShift).not.toBe('always')
    store.setKeyShiftPolicy('keep')
    await offerLoopKeyShift(store, placed.trackId, placed.clipId, { loop: true, catalogKey: 'A minor' })
    expect(store.keyShiftOffer).toBeNull()
  }, 60000)

  it('screenshots the prompt and the dock on a phone and a fold', async () => {
    const rate = 48000
    const store = new ProjectStore(createEmptyProject(rate))
    const track = store.project.tracks.find((item) => item.name === 'Music')!
    const clip: AudioClip = {
      id: 'loop',
      name: 'Felt loop',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: rate,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      stretch: { sourceSamples: rate, semitones: 3, cents: 0, mode: 'pro', followTempo: false, sourceBpm: 100, markers: [], formant: true },
      keyShift: { semitones: 3, from: 'A minor', to: 'C minor', formantBefore: false },
    }
    store.addAsset({ id: 'buf', name: 'Felt loop', sampleRate: rate, channels: [new Float32Array(rate)] })
    store.addAudioClip(track.id, clip)
    store.presentKeyShiftOffer({
      trackId: track.id,
      clipId: clip.id,
      semitones: 3,
      from: 'A minor',
      to: 'C minor',
      tonicOnly: false,
      line: 'Loop is A minor — shift to project key C minor? (+3 st)',
    })
    const body = renderToStaticMarkup(createElement('div', { className: 'shell phone', style: { minHeight: '100%' } },
      createElement(ClipTempoControl, { store, trackId: track.id, clipId: clip.id }),
      createElement(KeyShiftPrompt, { store }),
    ))
    const css = ['src/styles.css', 'src/ui/clipTempo.css', 'src/ui/keyShift.css'].map((file) => readFileSync(file, 'utf8')).join('\n')
    const dir = '/opt/cursor/artifacts/key-shift'
    mkdirSync(dir, { recursive: true })
    const browser = await chromium.launch({
      executablePath: '/usr/bin/google-chrome',
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    try {
      for (const view of [
        { name: 'phone-344', width: 344, height: 844 },
        { name: 'fold-768', width: 768, height: 1024 },
      ]) {
        const page = await browser.newPage({ viewport: { width: view.width, height: view.height }, deviceScaleFactor: 2 })
        await page.setContent(`<!doctype html><html><head><style>
          html, body { margin: 0; background: #101614; color: #e7eee8; }
          ${css}
        </style></head><body>${body}</body></html>`)
        const prompt = page.locator('[data-key-shift-prompt]')
        await prompt.waitFor()
        expect(await prompt.innerText()).toContain('shift to project key C minor')
        await page.locator('[data-key-shift="apply"]').click({ trial: true })
        await page.locator('[data-key-revert]').click({ trial: true })
        await page.screenshot({ path: `${dir}/${view.name}-prompt-dock.png`, fullPage: false })
        await page.close()
      }
    } finally {
      await browser.close()
    }
  }, 60000)
})

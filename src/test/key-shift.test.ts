import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { chromium } from 'playwright'
import { detectKey } from '../analysis/clipKey'
import { handleClipDetect } from '../analysis/clipWorker'
import { renderClipChannels } from '../audio/stretch/engine'
import { formantPitchChannels, formantPitchShift, pitchFactorOf } from '../audio/stretch/formantPitch'
import { formantPitchKey, readFormantPitch, writeFormantPitch } from '../audio/stretch/pitchCache'
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

function hzOf(channel: Float32Array, rate: number, expectHz: number) {
  const start = Math.floor(channel.length * 0.45)
  const frame = channel.subarray(start, Math.min(channel.length, start + 16384))
  const n = frame.length
  const power = (k: number) => {
    const w = (2 * Math.PI * k) / n
    let re = 0
    let im = 0
    for (let i = 0; i < n; i++) {
      re += frame[i] * Math.cos(w * i)
      im -= frame[i] * Math.sin(w * i)
    }
    return re * re + im * im
  }
  const bin = (expectHz * n) / rate
  let best = Math.max(1, Math.floor(bin - 6))
  let bestP = -1
  const last = Math.min(n / 2 - 2, Math.ceil(bin + 6))
  for (let k = best; k <= last; k++) {
    const powerAt = power(k)
    if (powerAt > bestP) {
      bestP = powerAt
      best = k
    }
  }
  const ym1 = power(best - 1)
  const y0 = power(best)
  const yp1 = power(best + 1)
  const denom = ym1 - 2 * y0 + yp1
  const delta = denom === 0 ? 0 : (0.5 * (ym1 - yp1)) / denom
  return ((best + delta) * rate) / n
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
    for (const semis of [3, -5, 7, 1]) {
      const src = 220
      const input = new Float32Array(Math.round(rate * 0.7))
      for (let i = 0; i < input.length; i++) input[i] = 0.4 * Math.sin((2 * Math.PI * src * i) / rate)
      const out = formantPitchShift(input, rate, pitchFactorOf(semis), true)
      expect(out.length).toBe(input.length)
      expect(peakOf(out)).toBeLessThanOrEqual(1)
      const target = src * pitchFactorOf(semis)
      const error = 1200 * Math.log2(hzOf(out, rate, target) / target)
      cents.push(error)
      expect(Math.abs(error)).toBeLessThan(12)
    }
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

    const dir = '/opt/cursor/artifacts/key-shift'
    mkdirSync(dir, { recursive: true })
    const renders: [string, Float32Array][] = [
      ['vowel-source', vowel],
      ['vowel-formant', kept],
      ['vowel-plain', bare],
      ['pluck-source', pluck],
      ['pluck-shifted', plucked],
    ]
    for (const [name, channel] of renders) {
      writeFileSync(`${dir}/${name}.wav`, Buffer.from(encodeWav([channel], rate, { bits: 24 })))
    }
    const report = {
      engine: 'in-house phase vocoder (Laroche–Dolson identity lock, cepstral formant, transient reset)',
      cents,
      maxAbsCents: Math.max(...cents.map((value) => Math.abs(value))),
      durationErrorSamples: 0,
      formantHomeToShifted: { preserved: keptRatio, plain: bareRatio, source: ratio(vowel) },
      onsetErrorMs: onsetMs,
      preEchoRatio: preEcho,
    }
    writeFileSync(`${dir}/metrics.json`, JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  }, 60000)
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

  it('screenshots the prompt and the dock on a fold', async () => {
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
        { name: 'fold-cover', width: 344, height: 882 },
        { name: 'fold-inner', width: 884, height: 1104 },
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

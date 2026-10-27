import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { oversized, MAX_DIST_BYTES } from '../../scripts/check-size.ts'
import { ORT_VERSION, ORT_WASM_BASE } from '../audio/stems/runtime'
import {
  HTDEMUCS,
  HTDEMUCS_6,
  chunkPlan,
  etaSeconds,
  formatBytes,
  modeAllowed,
  separateMix,
  stemBudget,
  triangleWindow,
  type StemMode,
} from '../audio/stems/engine'
import { createSampler } from '../audio/plugins/sampler'
import { createPlugin } from '../audio/plugins/catalog'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { createEmptyProject, uid } from '../model/types'
import { ProjectStore } from '../state/store'

const SEGMENT = 320
const RATE = 44100

function sine(length: number, freq = 440) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / RATE) * 0.5
  return out
}

function split(stereo: [Float32Array, Float32Array], parts: number) {
  return Array.from({ length: parts }, () => stereo.map((channel) => {
    const out = new Float32Array(channel.length)
    for (let i = 0; i < channel.length; i++) out[i] = (channel[i] ?? 0) / parts
    return out
  }))
}

function maxDiff(a: Float32Array, b: Float32Array) {
  let diff = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i++) diff = Math.max(diff, Math.abs((a[i] ?? 0) - (b[i] ?? 0)))
  return diff
}

function sumStems(stems: Float32Array[][]) {
  const length = stems[0]?.[0]?.length ?? 0
  const out = new Float32Array(length)
  for (const stem of stems) {
    const channel = stem[0]
    if (!channel) continue
    for (let i = 0; i < length; i++) out[i] += channel[i] ?? 0
  }
  return out
}

describe('stem separation', () => {
  it('keeps the triangle above zero and plans an exact chunk count', () => {
    const weight = triangleWindow(SEGMENT)
    expect(Math.min(...weight)).toBeGreaterThan(0)
    expect(weight[0]).toBeCloseTo(weight[SEGMENT - 1] ?? 0)
    const { offsets, stride } = chunkPlan(SEGMENT + strideOf(), SEGMENT, 0.25)
    expect(stride).toBe(240)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(240)
    expect(offsets.at(-1)).toBeLessThan(SEGMENT + 240)
  })

  it('sums stems back to the source', async () => {
    const length = SEGMENT + 240
    const source = sine(length)
    const result = await separateMix([source], RATE, '4', async (stereo) => split(stereo, 4), { segment: SEGMENT })
    const mixed = sumStems(result.stems ?? [])
    expect(mixed.length).toBe(source.length)
    expect(maxDiff(mixed, source)).toBeLessThan(1e-4)
  })

  it('stays aligned and has no click at a chunk boundary', async () => {
    const length = SEGMENT + 240
    const source = sine(length, 220)
    const boundary = 240
    const result = await separateMix([source], RATE, 'vocals', async (stereo) => {
      const quiet = stereo.map((channel) => new Float32Array(channel.length)) as [Float32Array, Float32Array]
      return [quiet, quiet, quiet, [stereo[0].slice(), stereo[1].slice()]]
    }, { segment: SEGMENT })
    const stem = result.stems?.[0]?.[0]
    expect(stem).toBeTruthy()
    if (!stem) return
    expect(stem.length).toBe(source.length)
    expect(maxDiff(stem, source)).toBeLessThan(1e-4)
    const jump = Math.abs((stem[boundary] ?? 0) - (stem[boundary - 1] ?? 0))
    const original = Math.abs((source[boundary] ?? 0) - (source[boundary - 1] ?? 0))
    expect(jump).toBeLessThan(original + 1e-4)
  })

  it('cancels between chunks and resumes to the same audio', async () => {
    const length = SEGMENT + 240
    const source = sine(length, 330)
    const signal = { cancelled: false }
    let calls = 0
    const partial = await separateMix([source], RATE, '4', async (stereo) => {
      calls += 1
      if (calls === 1) signal.cancelled = true
      return split(stereo, 4)
    }, { segment: SEGMENT, signal })
    expect(partial.stems).toBeNull()
    expect(partial.checkpoint?.nextChunk).toBe(1)
    const resumed = await separateMix([source], RATE, '4', async (stereo) => split(stereo, 4), {
      segment: SEGMENT,
      checkpoint: partial.checkpoint ?? undefined,
    })
    const full = await separateMix([source], RATE, '4', async (stereo) => split(stereo, 4), { segment: SEGMENT })
    expect(maxDiff(sumStems(resumed.stems ?? []), sumStems(full.stems ?? []))).toBeLessThan(1e-4)
    expect(calls).toBe(1)
  })

  it('averages shift passes without moving samples', async () => {
    const length = SEGMENT + 80
    const source = sine(length, 180)
    const result = await separateMix([source], RATE, '2', async (stereo) => {
      const quiet = stereo.map((channel) => new Float32Array(channel.length)) as [Float32Array, Float32Array]
      const copy = [stereo[0].slice(), stereo[1].slice()] as [Float32Array, Float32Array]
      return [quiet, quiet, quiet, copy]
    }, { segment: SEGMENT, shifts: 2, maxShift: 16 })
    const mixed = sumStems(result.stems ?? [])
    expect(mixed.length).toBe(source.length)
    expect(maxDiff(mixed, source)).toBeLessThan(1e-3)
  })

  it('places muted-source stems on the project and round-trips them', () => {
    const store = new ProjectStore(createEmptyProject(RATE))
    const track = store.project.tracks[1]
    if (!track) throw new Error('missing track')
    const audio = sine(8000)
    const bufferId = uid('buf')
    store.addAsset({ id: bufferId, name: 'Take', sampleRate: RATE, channels: [audio] })
    const clipId = uid('clip')
    store.addAudioClip(track.id, {
      id: clipId,
      name: 'Take',
      bufferId,
      startSample: 4800,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 0.8,
      source: 'aligned-take',
    })
    store.placeStems(track.id, clipId, [
      { name: 'Vocals', color: '#ef6b6b', channels: [audio] },
      { name: 'Instrumental', color: '#73c48f', channels: [audio] },
    ], false)
    expect(track.mute).toBe(true)
    expect(track.clips).toHaveLength(1)
    const stems = store.project.tracks.filter((item) => item.name === 'Vocals' || item.name === 'Instrumental')
    expect(stems).toHaveLength(2)
    for (const stem of stems) {
      expect(stem.clips[0]?.startSample).toBe(4800)
      expect(stem.clips[0]?.durationSamples).toBe(audio.length)
      const saved = store.buffers.get(stem.clips[0]?.bufferId ?? '')
      expect(saved?.channels[0]?.length).toBe(audio.length)
    }
    const decoded = decodeWavPCM(encodeWav([audio], RATE))
    expect(decoded.channels[0]?.length).toBe(audio.length)
    const clone = JSON.parse(JSON.stringify(store.project)) as { tracks: { name: string; mute: boolean; clips: { startSample: number }[] }[] }
    expect(clone.tracks.some((item) => item.name === 'Vocals' && item.clips[0]?.startSample === 4800)).toBe(true)
    store.undo()
    const restored = store.project.tracks.find((item) => item.id === track.id)
    expect(restored?.mute).toBe(false)
    expect(store.project.tracks.some((item) => item.name === 'Vocals')).toBe(false)
    store.placeStems(track.id, clipId, [{ name: 'Vocals', color: '#ef6b6b', channels: [audio] }], true)
    const sampler = store.project.tracks.find((item) => item.name === 'Vocals' && item.type === 'midi')
    expect(sampler?.plugins[0]?.pluginId).toBe('sampler')
    expect(sampler?.plugins[0]?.sampler?.bufferId).toBeTruthy()
  })

  it('plays a dropped stem on pitch and an octave up', () => {
    const plugin = createPlugin('sampler')
    plugin.sampler!.bufferId = 'tone'
    plugin.sampler!.root = 69
    const proc = createSampler(RATE)
    proc.bind(plugin, () => sine(RATE, 440))
    const ctx = { sampleRate: RATE, tempo: 120, sampleTime: 0, sidechain: null, scaleRoot: 0, scaleIntervals: [0, 2, 4, 5, 7, 9, 11], quality: 'full' as const }
    const play = (note: number) => {
      proc.note(note, 0.9)
      const output = [new Float32Array(RATE), new Float32Array(RATE)]
      proc.process([new Float32Array(RATE), new Float32Array(RATE)], output, { gain: 1, keys: 1, stretch: 0, attack: 1, sustain: 1 }, ctx)
      return output[0]
    }
    expect(cents(measureHz(play(69)), 440)).toBeLessThan(15)
    expect(cents(measureHz(play(81)), 880)).toBeLessThan(15)
  })

  it('caps phone stems and reports model size', () => {
    const phone = stemBudget(undefined, true, false)
    expect(phone.maxStems).toBe(2)
    expect(phone.allowHigh).toBe(false)
    expect(modeAllowed('2', phone)).toBe(true)
    expect(modeAllowed('4', phone)).toBe(false)
    expect(modeAllowed('6', stemBudget(16, false, false))).toBe(true)
    expect(stemBudget(16, false, true).allowHigh).toBe(true)
    expect(formatBytes(HTDEMUCS.bytes)).toBe('166 MB')
    expect(formatBytes(HTDEMUCS_6.bytes)).toBe('136 MB')
    const mode: StemMode = '4'
    expect(modeAllowed(mode, stemBudget(8, false, false))).toBe(true)
    expect(etaSeconds(RATE * 180, RATE, 0, 28)).toBeGreaterThan(60)
  })

  it('loads the ONNX runtime from the pinned jsDelivr release', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['onnxruntime-web']).toBe(ORT_VERSION)
    expect(ORT_WASM_BASE).toBe(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`)
    const worker = readFileSync('src/audio/stems/worker.ts', 'utf8')
    expect(worker).toContain('ORT_WASM_BASE')
    expect(worker).not.toContain('location.origin')
    expect(oversized([{ path: 'dist/app.js', size: MAX_DIST_BYTES }])).toEqual([])
    expect(oversized([{ path: 'dist/ort-wasm-simd-threaded.wasm', size: 15 * 1024 * 1024 }])).toHaveLength(1)
  })
})

function measureHz(channel: Float32Array) {
  const start = Math.round(channel.length * 0.05)
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value || 1)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 12)
  const mean = window.reduce((sum, period) => sum + period, 0) / window.length
  return RATE / mean
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function strideOf() {
  return Math.floor(0.75 * SEGMENT)
}

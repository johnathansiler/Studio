import { describe, expect, it } from 'vitest'
import { peakIndex, renderClipChannels, timelineSamples } from '../audio/stretch/engine'
import { followClockToken, onStretchCommit, queueClipStretch, stretchCacheKey, stretchSlot } from '../audio/stretch/commit'
import { yinPitch } from '../audio/stretch/voice'
import { createEmptyProject, type AudioClip } from '../model/types'
import { ProjectStore } from '../state/store'
import { placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'

const rate = 48000

function loop(id: string, bpm: number, bars: number, tags: string[]): SoundEntry {
  return {
    id,
    path: `loops/${id}.wav`,
    name: id,
    type: 'loop',
    tags,
    bpm,
    durationSec: (bars * 4 * 60) / bpm,
    sampleRate: rate,
    license: 'CC0',
    source: 'test',
  }
}

function clicks(bpm: number, bars: number) {
  const beats = bars * 4
  const data = new Float32Array(Math.round(beats * rate * 60 / bpm))
  for (let beat = 0; beat < beats; beat++) data[Math.round(beat * rate * 60 / bpm)] = 1
  return data
}

function sine(freq: number, seconds: number) {
  const data = new Float32Array(Math.round(seconds * rate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return data
}

function beats(samples: number, tempo: number) {
  return (samples / rate) * (tempo / 60)
}

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

function place(entry: SoundEntry, channel: Float32Array, tempo: number) {
  const project = createEmptyProject(rate)
  project.tempo = tempo
  const placed = placeSound({ entry, channels: [channel], fileRate: rate, project, startSample: 0, clipId: entry.id })
  if (!placed) throw new Error('missing clip')
  const store = new ProjectStore(project)
  const track = store.project.tracks.find((item) => item.type === 'audio')!
  store.addAsset(placed.asset)
  store.placeClipAtPlayhead(track.id, placed.clip, 0)
  const clip = track.clips.find((item) => item.id === placed.clip.id) ?? track.clips[0]
  return { store, track, clip, asset: placed.asset }
}

function hitAt(channel: Float32Array, beat: number, tempo: number) {
  const center = Math.round(beat * rate * 60 / tempo)
  let best = 0
  let at = center
  const radius = Math.round(rate * 0.03)
  for (let i = Math.max(0, center - radius); i <= Math.min(channel.length - 1, center + radius); i++) {
    const mag = Math.abs(channel[i] || 0)
    if (mag > best) {
      best = mag
      at = i
    }
  }
  return { at, best }
}

describe('loaded loop tempo follow', () => {
  it('keeps an 88 BPM loop on the bar grid and stretches later tempos without shifting pitch', () => {
    const channel = clicks(88, 2)
    const { store, clip, asset } = place(loop('boom', 88, 2, ['drum', 'loop']), channel, 120)
    expect(clip.stretch?.followTempo).toBe(true)
    expect(clip.stretch?.sourceBpm).toBe(88)
    expect(beats(clip.durationSamples, 120)).toBeCloseTo(8, 1)
    expect(asset.channels[0].length).toBe(channel.length)

    const rendered: number[] = []
    for (const tempo of [90, 140, 120]) {
      store.setTempo(tempo)
      expect(beats(clip.durationSamples, tempo)).toBeCloseTo(8, 1)
      const out = renderClipChannels(asset.channels, clip, store.project, 'preview')
      expect(Math.abs(out[0].length - clip.durationSamples)).toBeLessThan(rate * 0.02)
      for (const beat of [1, 3, 7]) {
        const hit = hitAt(out[0], beat, tempo)
        expect(hit.best).toBeGreaterThan(0.2)
        expect(Math.abs(hit.at - Math.round(beat * rate * 60 / tempo))).toBeLessThan(rate * 0.02)
      }
      rendered.push(out[0].length)
    }
    expect(rendered[0]).toBeGreaterThan(rendered[1])
    expect(rendered[2]).toBeGreaterThan(rendered[1])
    expect(rendered[2]).toBeLessThan(rendered[0])

    const tone = sine(440, 0.8)
    const tonal = place(loop('pad', 100, 1, ['pad']), tone, 120)
    store.setTempo(80)
    const low = renderClipChannels(tonal.asset.channels, tonal.clip, { ...tonal.store.project, tempo: 80 }, 'hq')
    const start = Math.floor(low[0].length * 0.3)
    const hz = yinPitch(low[0].subarray(start, start + 4096), rate, 200, 800).hz
    expect(Math.abs(cents(hz, 440))).toBeLessThan(25)
    expect(low[0].length).toBeGreaterThan(tone.length)
  })

  it('stretches a second catalog tempo and leaves one-shots and free audio alone', () => {
    const bossa = clicks(132, 2)
    const { store, clip } = place(loop('bossa', 132, 2, ['drum', 'loop']), bossa, 120)
    expect(beats(clip.durationSamples, 120)).toBeCloseTo(8, 1)
    store.setTempo(100)
    expect(beats(clip.durationSamples, 100)).toBeCloseTo(8, 1)
    const shot = place(loop('hat', 0, 1, ['hat']), clicks(120, 1), 120)
    shot.clip.stretch && (shot.clip.stretch.followTempo = false)
    const before = shot.clip.durationSamples
    shot.store.setTempo(90)
    expect(shot.clip.durationSamples).toBe(before)

    const one = placeSound({
      entry: { ...loop('kick', 120, 1, ['kick']), type: 'one-shot', bpm: undefined },
      channels: [clicks(120, 1)],
      fileRate: rate,
      project: store.project,
      startSample: 0,
    })
    expect(one?.clip.stretch?.followTempo).toBe(false)
    const held = one!.clip.durationSamples
    store.addAsset(one!.asset)
    store.addAudioClip(store.project.tracks.find((item) => item.type === 'audio')!.id, one!.clip)
    store.setTempo(70)
    expect(one!.clip.durationSamples).toBe(held)
    expect(followClockToken(store.project)).not.toBe(followClockToken({ ...store.project, tempo: store.project.tempo + 1 }))
  })

  it('trims inside the source, then still follows tempo', () => {
    const channel = clicks(88, 2)
    const { store, track, clip, asset } = place(loop('trim', 88, 2, ['drum', 'loop']), channel, 120)
    const full = asset.channels[0].length
    store.project.snap = false
    store.trimClip(track.id, clip.id, 'start', Math.round(rate * 60 / 120), true)
    expect(clip.stretch?.followTempo).toBe(true)
    expect(clip.offsetSamples).toBeGreaterThan(0)
    expect(clip.stretch?.sourceSamples).toBeLessThan(full)
    expect(clip.offsetSamples + (clip.stretch?.sourceSamples ?? 0)).toBeLessThanOrEqual(full)
    expect(asset.channels[0].length).toBe(full)
    expect(asset.channels[0][0]).toBe(1)
    const beatsLeft = beats(clip.durationSamples, 120)
    expect(beatsLeft).toBeGreaterThan(6)
    expect(beatsLeft).toBeLessThan(8)
    store.setTempo(140)
    expect(beats(clip.durationSamples, 140)).toBeCloseTo(beatsLeft, 1)
    const out = renderClipChannels(asset.channels, clip, store.project, 'preview')
    expect(Math.abs(out[0].length - timelineSamples(clip, store.project))).toBeLessThan(rate * 0.02)
    expect(peakIndex(out[0])).toBeLessThan(rate * 0.05)
  })

  it('undo, redo, and reload keep follow-tempo', () => {
    const { store, clip } = place(loop('save', 88, 2, ['drum', 'loop']), clicks(88, 2), 120)
    const at120 = clip.durationSamples
    store.setTempo(90)
    const at90 = clip.durationSamples
    expect(at90).toBeGreaterThan(at120)
    store.undo()
    const undone = store.project.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id)!
    expect(store.project.tempo).toBe(120)
    expect(undone.durationSamples).toBe(at120)
    expect(undone.stretch?.followTempo).toBe(true)
    store.redo()
    const redone = store.project.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id)!
    expect(store.project.tempo).toBe(90)
    expect(redone.durationSamples).toBe(at90)

    const copy = JSON.parse(JSON.stringify(store.project)) as typeof store.project
    const buffers = new Map(store.buffers)
    const next = new ProjectStore()
    next.loadProject(copy, buffers)
    const loaded = next.project.tracks.flatMap((track) => track.clips).find((item) => item.id === clip.id) as AudioClip
    expect(loaded.stretch?.followTempo).toBe(true)
    expect(loaded.stretch?.sourceBpm).toBe(88)
    expect(loaded.durationSamples).toBe(at90)
    next.setTempo(140)
    expect(beats(loaded.durationSamples, 140)).toBeCloseTo(8, 1)
    expect(store.smartTempo?.bpm).toBe(88)
    store.dismissSmartTempo()
    expect(clip.stretch?.followTempo).toBe(true)
  })

  it('drops a stale stretch instead of playing it at the newest tempo', async () => {
    const { store, clip, asset } = place(loop('race', 88, 1, ['pad']), sine(330, 0.5), 120)
    const heard: string[] = []
    const stop = onStretchCommit((key) => heard.push(key))
    const key120 = queueClipStretch(clip, asset.channels, store.project)
    store.project.tempo = 90
    const key90 = queueClipStretch(clip, asset.channels, store.project)
    store.project.tempo = 140
    const key140 = queueClipStretch(clip, asset.channels, store.project)
    store.project.tempo = 120
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop()
    const lengthAt = (tempo: number) => {
      const clock = { ...store.project, tempo }
      return timelineSamples(clip, clock)
    }
    expect(Math.abs((stretchSlot(key120)?.channels?.[0].length ?? 0) - lengthAt(120))).toBeLessThan(rate * 0.02)
    expect(Math.abs((stretchSlot(key90)?.channels?.[0].length ?? 0) - lengthAt(90))).toBeLessThan(rate * 0.02)
    expect(Math.abs((stretchSlot(key140)?.channels?.[0].length ?? 0) - lengthAt(140))).toBeLessThan(rate * 0.02)
    expect(heard.filter((key) => key === key90 || key === key120 || key === key140)).toEqual([key140])
    expect(stretchCacheKey(clip, { ...store.project, tempo: 120 })).toBe(key120)
  })
})

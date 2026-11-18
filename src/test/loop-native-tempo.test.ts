import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readStretch, stretchCacheKey, stretchSlot } from '../audio/stretch/commit'
import { renderClipChannels, timelineSamples, timeStretch } from '../audio/stretch/engine'
import { yinPitch } from '../audio/stretch/voice'
import { clipTempoMode } from '../model/clipTempo'
import { createEmptyProject, type AudioClip } from '../model/types'
import { placeSound, previewChannelsFor, stretchModeFor } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
import { ProjectStore } from '../state/store'
import { ClipSheet } from '../ui/ClipSheet'
import { SmartTempoBar } from '../ui/SongMap'

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

function bassLoop(patch: Partial<SoundEntry> = {}): SoundEntry {
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
    ...patch,
  }
}

function sine(rate: number, seconds: number, hz: number) {
  const data = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * hz * i) / rate) * 0.5
  return data
}

function pitchError(channel: Float32Array, rate: number, hz: number) {
  const frame = channel.subarray(Math.floor(channel.length * 0.35), Math.floor(channel.length * 0.35) + 4096)
  const heard = yinPitch(frame, rate, 30, 120).hz
  return { hz: heard, cents: Math.abs(cents(heard, hz)) }
}

describe('808 loop preview and track playback', () => {
  it('previews the file tempo and places the loop in Follow', () => {
    const fileRate = 44100
    const tone = sine(fileRate, (4 * 60) / 105, 55)
    const entry = bassLoop()
    expect(stretchModeFor(entry)).toBe('pro')
    expect(stretchModeFor(bassLoop({
      name: 'E808 Loop BD 105-04',
      tags: ['loop', 'beat', 'drum', 'kick', '808', 'bd', 'bass'],
      category: 'drums',
    }))).toBe('pro')
    expect(stretchModeFor(bassLoop({
      name: '808 Hat Loop',
      path: 'Loops/808-hat.wav',
      tags: ['hat', '808'],
      category: 'hat',
      bpm: 105,
    }))).toBe('beats')

    const project = createEmptyProject(48000)
    project.tempo = 120
    const preview = previewChannelsFor(entry, [tone], fileRate, project, 0)
    const matched = Math.round(tone.length * (48000 / fileRate))
    const songLength = Math.round(matched * (105 / 120))
    expect(Math.abs(preview[0].length - matched)).toBeLessThan(2)
    expect(Math.abs(preview[0].length - songLength)).toBeGreaterThan(1000)

    const same = previewChannelsFor(entry, [tone], fileRate, createEmptyProject(fileRate), 0)
    expect(same[0].length).toBe(tone.length)

    const placed = placeSound({
      entry,
      channels: [tone],
      fileRate,
      project,
      startSample: 0,
    })
    expect(placed?.clip.stretch?.followTempo).toBe(true)
    expect(placed?.clip.stretch?.tempoMode).toBe('follow')
    expect(clipTempoMode(placed?.clip.stretch)).toBe('follow')
    expect(placed?.clip.stretch?.sourceBpm).toBe(105)
    expect(placed?.clip.stretch?.mode).toBe('pro')
    expect(placed?.clip.durationSamples).toBe(timelineSamples(placed!.clip, project))
    expect(Math.abs((placed?.clip.durationSamples ?? 0) - songLength)).toBeLessThan(8)
  })

  it('plays the first buffer with the committed phase vocoder and holds the pitch', () => {
    const rate = 48000
    const input = sine(rate, 1, 55)
    const entry = bassLoop({ tags: ['loop', 'beat', 'drum', 'kick', '808', 'bass', 'bd'] })
    const project = createEmptyProject(rate)
    project.tempo = 120
    const placed = placeSound({
      entry,
      channels: [input],
      fileRate: rate,
      project,
      startSample: 0,
    })
    expect(placed?.clip.stretch?.mode).toBe('pro')
    const clip = placed!.clip
    const asset = placed!.asset
    const songLength = Math.round(input.length * (105 / 120))
    expect(Math.abs(clip.durationSamples - songLength)).toBeLessThan(4)

    const played = readStretch(stretchCacheKey(clip, project), asset.channels, clip, project)[0]
    const committed = renderClipChannels(asset.channels, clip, project, 'hq')[0]
    expect(stretchSlot(stretchCacheKey(clip, project))?.quality).toBe('hq')
    expect(played.length).toBe(committed.length)
    expect(played.length).toBe(clip.durationSamples)
    let diff = 0
    for (let i = 0; i < played.length; i++) diff = Math.max(diff, Math.abs((played[i] || 0) - (committed[i] || 0)))
    expect(diff).toBe(0)

    const heard = pitchError(played, rate, 55)
    expect(heard.cents).toBeLessThan(8)

    const direct = timeStretch(input, songLength, 'pro', rate, 'preview')
    const previewPitch = pitchError(direct, rate, 55)
    expect(previewPitch.cents).toBeLessThan(8)
  })

  it('retimes with the song, and half, double, and lock still change the length', () => {
    const rate = 48000
    const input = sine(rate, 1, 55)
    const project = createEmptyProject(rate)
    project.tempo = 120
    const placed = placeSound({
      entry: bassLoop(),
      channels: [input],
      fileRate: rate,
      project,
      startSample: 0,
    })!
    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.addAsset(placed.asset)
    store.placeClipAtPlayhead(track.id, placed.clip, 0)
    const clip = track.clips[0]
    const atFollow = clip.durationSamples
    store.setTempo(100)
    expect(clip.durationSamples).toBeGreaterThan(atFollow)
    expect(clip.stretch?.tempoMode).toBe('follow')
    store.setTempo(120)

    store.setClipStretch(track.id, clip.id, { tempoMode: 'half' })
    expect(clip.stretch?.tempoMode).toBe('half')
    expect(clip.stretch?.followTempo).toBe(true)
    const halfAt120 = clip.durationSamples
    expect(halfAt120).toBeGreaterThan(atFollow * 1.8)
    store.setTempo(90)
    expect(clip.durationSamples).toBeGreaterThan(halfAt120)
    store.setTempo(120)
    expect(clip.durationSamples).toBe(halfAt120)

    store.setClipStretch(track.id, clip.id, { tempoMode: 'double' })
    expect(clip.stretch?.tempoMode).toBe('double')
    expect(clip.stretch?.followTempo).toBe(true)
    expect(clip.durationSamples).toBeLessThan(atFollow * 0.6)
    const atDouble = clip.durationSamples
    store.setTempo(140)
    expect(clip.durationSamples).toBeLessThan(atDouble)
    store.setTempo(120)

    store.setClipStretch(track.id, clip.id, { tempoMode: 'lock', lockBpm: 105 })
    expect(clip.stretch?.tempoMode).toBe('lock')
    expect(clip.stretch?.followTempo).toBe(false)
    expect(clip.stretch?.lockBpm).toBe(105)
    const locked = clip.durationSamples
    expect(Math.abs(locked - input.length)).toBeLessThan(4)
    store.setTempo(90)
    expect(clip.durationSamples).toBe(locked)
    store.setTempo(120)
    expect(clip.durationSamples).toBe(locked)
  })

  it('keeps Follow through undo, redo, and load, and does not offer to stretch a clip that already follows', () => {
    const rate = 48000
    const input = sine(rate, 1, 55)
    const project = createEmptyProject(rate)
    project.tempo = 120
    const placed = placeSound({
      entry: bassLoop(),
      channels: [input],
      fileRate: rate,
      project,
      startSample: 0,
    })!
    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.addAsset(placed.asset)
    store.placeClipAtPlayhead(track.id, placed.clip, 0)
    const clip = track.clips[0]
    const at120 = clip.durationSamples
    expect(store.smartTempo?.bpm).toBe(105)
    const offer = renderToStaticMarkup(createElement(SmartTempoBar, { store }))
    expect(offer).toContain('already following the song')
    expect(offer).toContain('Use for song')
    expect(offer).not.toContain('Fit to song')
    expect(offer).not.toContain('Stretch this clip')
    const sheet = renderToStaticMarkup(createElement(ClipSheet, {
      store,
      trackId: track.id,
      clip,
      onClose: () => undefined,
    }))
    expect(sheet).toContain('Use for song')
    expect(sheet).not.toContain('Fit to song')
    expect(sheet).not.toContain('Stretch this clip')
    expect(sheet).toContain('Follow')

    store.setTempo(100)
    const at100 = clip.durationSamples
    expect(at100).toBeGreaterThan(at120)
    store.undo()
    const undone = store.project.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id) as AudioClip
    expect(store.project.tempo).toBe(120)
    expect(undone.durationSamples).toBe(at120)
    expect(undone.stretch?.followTempo).toBe(true)
    expect(undone.stretch?.tempoMode).toBe('follow')
    store.redo()
    const redone = store.project.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id) as AudioClip
    expect(store.project.tempo).toBe(100)
    expect(redone.durationSamples).toBe(at100)
    expect(redone.stretch?.tempoMode).toBe('follow')

    const copy = JSON.parse(JSON.stringify(store.project)) as typeof store.project
    const next = new ProjectStore()
    next.loadProject(copy, new Map(store.buffers))
    const loaded = next.project.tracks.flatMap((item) => item.clips).find((item) => item.id === clip.id) as AudioClip
    expect(loaded.stretch?.followTempo).toBe(true)
    expect(loaded.stretch?.tempoMode).toBe('follow')
    expect(loaded.stretch?.sourceBpm).toBe(105)
    expect(loaded.durationSamples).toBe(at100)
    next.setTempo(140)
    expect(loaded.durationSamples).toBeLessThan(at100)
    expect(loaded.stretch?.tempoMode).toBe('follow')
  })
})

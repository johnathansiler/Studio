import { describe, expect, it } from 'vitest'
import { clipNeedsStretch, renderClipChannels, timelineSamples } from '../audio/stretch/engine'
import { clipPlaybackRate, fitRecordedChannels, inputGainLinear, measureInputLevel, recordedClipFields, recordedStretch } from '../audio/recordTake'
import { channelConstraints } from '../model/comp'
import { migrateAudioKinds } from '../model/audioKind'
import { tempoFollowsProject } from '../model/clipTempo'
import { planAudioRoutes } from '../model/midiTools'
import { createEmptyProject, makeTrack, type AudioClip } from '../model/types'
import { placeSound } from '../sounds/place'
import { ProjectStore } from '../state/store'

function sine(freq: number, seconds: number, rate: number) {
  const length = Math.round(seconds * rate)
  const channel = new Float32Array(length)
  for (let i = 0; i < length; i++) channel[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return channel
}

/** Rising zero crossings. A clean sine reports its own frequency. */
function frequency(channel: Float32Array, rate: number) {
  const start = Math.floor(channel.length * 0.15)
  const end = Math.floor(channel.length * 0.85)
  let crosses = 0
  for (let i = start + 1; i < end; i++) {
    if (channel[i - 1] <= 0 && channel[i] > 0) crosses += 1
  }
  return crosses / ((end - start) / rate)
}

function takeClip(channel: Float32Array, rate: number, tempo: number): { clip: AudioClip; project: ReturnType<typeof createEmptyProject> } {
  const project = createEmptyProject(rate)
  project.tempo = tempo
  const fields = recordedClipFields(channel.length)
  const clip: AudioClip = {
    id: 'take',
    name: 'Vocal',
    bufferId: 'buf',
    startSample: 0,
    offsetSamples: 0,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'local',
    takeId: 'take-1',
    ...fields,
  }
  return { clip, project }
}

describe('recorded takes stay at the performance', () => {
  it('keeps a 440 Hz sine at the same frequency and length, and ignores tempo', () => {
    const rate = 48000
    const input = sine(440, 1, rate)
    const { clip, project } = takeClip(input, rate, 120)
    expect(clip.playback).toBe('recorded')
    expect(clip.stretch?.followTempo).toBe(false)
    expect(clip.stretch?.markers).toEqual([])
    expect(clip.stretch?.semitones).toBe(0)
    expect(clip.stretch?.cents).toBe(0)
    expect(tempoFollowsProject(clip.stretch)).toBe(false)
    expect(clipNeedsStretch(clip, project)).toBe(false)
    expect(clipPlaybackRate(clip)).toBe(1)
    expect(clip.durationSamples).toBe(input.length)

    const heard = renderClipChannels([input], clip, project, 'hq')[0]
    expect(heard.length).toBe(input.length)
    expect(Math.abs(frequency(heard, rate) - 440)).toBeLessThan(2)

    project.tempo = 80
    expect(timelineSamples(clip, project)).toBe(input.length)
    expect(clipNeedsStretch(clip, project)).toBe(false)
    const slower = renderClipChannels([input], clip, project, 'hq')[0]
    expect(slower.length).toBe(input.length)
    expect(Math.abs(frequency(slower, rate) - 440)).toBeLessThan(2)

    project.tempo = 160
    const faster = renderClipChannels([input], clip, project, 'hq')[0]
    expect(faster.length).toBe(input.length)
    expect(Math.abs(frequency(faster, rate) - 440)).toBeLessThan(2)
  })

  it('converts a 44.1 kHz take onto 48 kHz without changing pitch or duration', () => {
    const input = sine(440, 1, 44100)
    const fitted = fitRecordedChannels([input], 44100, 48000)
    expect(fitted[0].length / 48000).toBeCloseTo(1, 2)
    expect(Math.abs(frequency(fitted[0], 48000) - 440)).toBeLessThan(3)
    const same = fitRecordedChannels([input], 48000, 48000)
    expect(same[0].length).toBe(input.length)
    expect(same[0][100]).toBeCloseTo(input[100], 5)
  })

  it('does not let a recorded clip follow tempo, and still lets a loop follow', () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const vocal = store.project.tracks.find((track) => track.kind === 'vocal')!
    const input = sine(440, 0.5, 48000)
    store.addAsset({ id: 'buf', name: 'Take', sampleRate: 48000, channels: [input] })
    const fields = recordedClipFields(input.length)
    store.addAudioClip(vocal.id, {
      id: 'take',
      name: 'Vocal',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'local',
      takeId: 't',
      ...fields,
    })
    store.setClipStretch(vocal.id, 'take', { tempoMode: 'follow', sourceBpm: 90, followTempo: true })
    store.setTempo(90)
    const clip = vocal.clips[0]
    expect(clip.playback).toBe('recorded')
    expect(tempoFollowsProject(clip.stretch)).toBe(false)
    expect(clip.durationSamples).toBe(input.length)
    expect(store.smartTempo).toBeNull()

    const loop = placeSound({
      entry: { id: 'dust', path: 'dust.wav', name: 'Dust', type: 'loop', tags: ['drum'], bpm: 100, durationSec: 1, sampleRate: 48000, license: 'CC0', source: 'test' },
      channels: [sine(100, 1, 48000)],
      fileRate: 48000,
      project: store.project,
      startSample: 0,
    })
    expect(loop?.clip.stretch?.followTempo).toBe(true)
    const landed = store.placeClipAtPlayhead(vocal.id, loop!.clip, 0)
    expect(landed?.trackId).not.toBe(vocal.id)
    const host = store.project.tracks.find((track) => track.id === landed?.trackId)
    expect(host?.kind).toBe('loop')
  })

  it('migrates takes to Vocal and other audio to Loop, and only Vocal can arm', () => {
    const project = createEmptyProject()
    const taken = makeTrack({ name: 'Vox', type: 'audio', armed: false, input: 'mic' })
    taken.clips = [{
      id: 'c', name: 'Vox', bufferId: 'b', startSample: 0, offsetSamples: 0, durationSamples: 48000,
      fadeInSamples: 0, fadeOutSamples: 0, gain: 1, source: 'local', takeId: 'take',
      stretch: { ...recordedStretch(48000), followTempo: true, tempoMode: 'follow', sourceBpm: 90, markers: [{ id: 'm', source: 100, target: 2 }] },
    }]
    const bed = makeTrack({ name: 'Bed', type: 'audio', armed: true, input: 'none' })
    bed.kind = undefined
    const music = makeTrack({ name: 'Bed 2', type: 'audio', armed: false, input: 'none' })
    project.tracks = [taken, music]
    migrateAudioKinds(project)
    expect(taken.kind).toBe('vocal')
    expect(taken.clips[0].playback).toBe('recorded')
    expect(taken.clips[0].stretch?.followTempo).toBe(false)
    expect(taken.clips[0].stretch?.markers).toEqual([])
    expect(tempoFollowsProject(taken.clips[0].stretch)).toBe(false)
    expect(music.kind).toBe('loop')
    expect(music.armed).toBe(false)
    bed.armed = true
    migrateAudioKinds({ ...project, tracks: [bed] })
    expect(bed.kind).toBe('vocal')

    const loop = makeTrack({ name: 'Loop', type: 'audio', kind: 'loop', armed: true })
    expect(planAudioRoutes([taken, loop, music]).map((route) => route.trackId)).toEqual([])
    taken.armed = true
    expect(planAudioRoutes([taken, loop]).map((route) => route.trackId)).toEqual([taken.id])
    const store = new ProjectStore(createEmptyProject())
    const loopTrack = store.project.tracks.find((track) => track.kind === 'loop')!
    store.updateTrack(loopTrack.id, { armed: true })
    expect(loopTrack.armed).toBe(false)
  })

  it('records with processing off, at the context rate, and trims before the take', () => {
    const audio = channelConstraints(1, 48000)
    expect(audio.echoCancellation).toBe(false)
    expect(audio.noiseSuppression).toBe(false)
    expect(audio.autoGainControl).toBe(false)
    expect(audio.sampleRate).toEqual({ ideal: 48000 })
    expect(inputGainLinear(0)).toBe(1)
    expect(inputGainLinear(6)).toBeCloseTo(10 ** (6 / 20), 5)
    expect(inputGainLinear(80)).toBeCloseTo(inputGainLinear(24), 5)
    const hot = measureInputLevel(Float32Array.from([0.6]), 6)
    expect(hot.clip).toBe(true)
    const tame = measureInputLevel(Float32Array.from([0.2]), 0)
    expect(tame.clip).toBe(false)
    expect(tame.peak).toBeCloseTo(0.2, 5)
  })
})

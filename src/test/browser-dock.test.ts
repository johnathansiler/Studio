import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { AudioEngine } from '../audio/engine'
import { loopBarCount, previewHeadRatio, waveformPeaks } from '../model/playheadPlace'
import { projectSampleBeat } from '../model/tempoMap'
import { createEmptyProject, type AudioClip, type MidiClip } from '../model/types'
import { ProjectStore } from '../state/store'

function audioClip(name: string): AudioClip {
  return {
    id: `clip-${name}`,
    name,
    bufferId: 'buf',
    startSample: 0,
    offsetSamples: 0,
    durationSamples: 48000,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'local',
  }
}

describe('preview playhead', () => {
  it('wraps a loop and finishes a one-shot', () => {
    expect(previewHeadRatio(0, 0, 4, true)).toEqual({ ratio: 0, done: false })
    expect(previewHeadRatio(1, 0, 4, true).ratio).toBeCloseTo(0.25)
    expect(previewHeadRatio(5, 0, 4, true)).toEqual({ ratio: 0.25, done: false })
    expect(previewHeadRatio(4, 0, 4, false).done).toBe(true)
    expect(previewHeadRatio(2, 0, 4, false)).toEqual({ ratio: 0.5, done: false })
    expect(loopBarCount(8, 120, 4)).toBe(4)
    const peaks = waveformPeaks(Float32Array.from([0, 1, 0, -0.5]), 2)
    expect(peaks[0]).toBe(1)
    expect(peaks[1]).toBe(0.5)
  })
})

describe('browser load at the playhead', () => {
  it('makes a new audio track when the selection is not audio, in one undo', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const before = store.project.tracks.length
    const sample = Math.round(1.3 * store.project.sampleRate * (60 / store.project.tempo))
    store.placeClipAtPlayhead(null, audioClip('Clarinet'), sample)
    expect(store.project.tracks.length).toBe(before + 1)
    const track = store.project.tracks.find((item) => item.id === store.selectedTrackId)!
    expect(track.type).toBe('audio')
    expect(track.name).toBe('Clarinet')
    expect(track.clips).toHaveLength(1)
    expect(track.clips[0].startSample).toBe(sample)
    expect(projectSampleBeat(store.project, track.clips[0].startSample)).toBeCloseTo(1.3)
    expect(store.selectedClipId).toBe(track.clips[0].id)
    store.undo()
    expect(store.project.tracks.length).toBe(before)
    expect(store.project.tracks.some((item) => item.clips.some((clip) => clip.name === 'Clarinet'))).toBe(false)
  })

  it('uses the selected audio track and keeps a MIDI clip on the selected instrument', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const [audioId] = store.addTracks({ kind: 'audio', count: 1, instrument: 'none', input: 'mic', channels: 1, armed: false })
    store.selectTrack(audioId)
    const sample = Math.round(2.25 * store.project.sampleRate * (60 / store.project.tempo))
    store.placeClipAtPlayhead(null, audioClip('Loop'), sample)
    const audio = store.track(audioId)!
    expect(audio.clips).toHaveLength(1)
    expect(audio.clips[0].startSample).toBe(sample)
    expect(store.project.tracks.filter((track) => track.type === 'audio')).toHaveLength(3)

    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const midi: MidiClip = { id: 'midi-1', name: 'Pattern', startBeat: 0, durationBeats: 4, notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }] }
    store.placeClipAtPlayhead(keys.id, midi, sample)
    const clip = store.track(keys.id)!.midiClips.find((item) => item.id === 'midi-1')!
    expect(clip.startBeat).toBeCloseTo(projectSampleBeat(store.project, sample))
    expect(clip.notes[0].startBeat).toBe(0)
  })

  it('puts a pattern on Arrange at the playhead without snapping it', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    store.placePattern(6.2)
    expect(store.project.patternClips![0].startBeat).toBe(6.2)
    const sent = store.sendPatternToArrange(4.4)
    const clip = store.project.tracks.flatMap((track) => track.midiClips).find((item) => item.id === sent!.clipId)!
    expect(clip.startBeat).toBe(4.4)
  })
})

describe('preview audition', () => {
  it('starts on the speaker, loops a loop, and the next preview stops the first', async () => {
    const started: { loop: boolean; gain: number }[] = []
    const stopped: number[] = []
    const ctx = {
      sampleRate: 48000,
      currentTime: 3,
      state: 'suspended' as AudioContextState,
      destination: {},
      async resume() { ctx.state = 'running' },
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({ duration: length / sampleRate, copyToChannel() {} }),
      createBufferSource() {
        const src = {
          buffer: null as { duration: number } | null,
          loop: false,
          connect() {},
          start() { started.push({ loop: src.loop, gain: gain.gain.value }) },
          stop() { stopped.push(1) },
          disconnect() {},
          onended: null as null | (() => void),
        }
        return src
      },
      createGain() {
        return gain
      },
    }
    const gain = { gain: { value: 1 }, connect() {}, disconnect() {} }
    const engine = new AudioEngine()
    const live = engine as unknown as { ctx: typeof ctx; speakerGain: object }
    live.ctx = ctx
    live.speakerGain = { connect() {} }
    const tone = [new Float32Array(48000)]
    engine.previewPcm(tone, 48000, true)
    await Promise.resolve()
    await Promise.resolve()
    expect(started).toEqual([{ loop: true, gain: 0.8 }])
    expect(engine.previewHead(3)?.ratio).toBe(0)
    expect(engine.previewHead(5)?.ratio).toBe(0)
    ctx.currentTime = 3.25
    expect(engine.previewHead()?.ratio).toBeCloseTo(0.25)
    engine.previewPcm(tone, 48000, false)
    await Promise.resolve()
    expect(stopped.length).toBe(1)
    expect(started[1].loop).toBe(false)
    engine.stopPreview()
    expect(engine.previewHead()).toBeNull()
  })
})

describe('filter menu stacking', () => {
  it('paints the filter above the docked browser and below the view tabs', () => {
    const css = readFileSync(new URL('../ui/sound-browser.css', import.meta.url), 'utf8')
    expect(css).toContain('.anchored-menu.sound-filter-menu')
    expect(css).toContain('z-index: calc(var(--view-tabs-z, 480) - 20)')
    const browser = readFileSync(new URL('../ui/SoundBrowser.tsx', import.meta.url), 'utf8')
    expect(browser).toContain('className="sound-filter-menu"')
    expect(browser).not.toContain('sound-filter-menu" fill')
  })
})

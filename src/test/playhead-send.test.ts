import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emptyLooper } from '../audio/sample/engine'
import { applyFreeze } from '../audio/bounce'
import type { GeneratedPart } from '../generators/types'
import { projectSampleBeat } from '../model/tempoMap'
import { createEmptyProject, type MidiClip } from '../model/types'
import { ProjectStore } from '../state/store'
import type { SongDraft } from '../unstuck/draft'

function midiClip(name: string): MidiClip {
  return {
    id: `midi-${name}`,
    name,
    startBeat: 0,
    durationBeats: 1,
    notes: [{ id: 'n', pitch: 60, startBeat: 0, durationBeats: 0.5, velocity: 0.8 }],
  }
}

function beatSample(store: ProjectStore, beat: number) {
  const seconds = beat * (60 / store.project.tempo)
  return Math.round(seconds * store.project.sampleRate)
}

describe('send to Arrange at the playhead', () => {
  it('puts a MIDI clip on the selected instrument, or makes one, in one undo', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const before = store.project.tracks.length
    store.placeMidiClipAtPlayhead(null, midiClip('Chord'), 4.4)
    const clip = store.track(keys.id)!.midiClips.find((item) => item.name === 'Chord')!
    expect(clip.startBeat).toBe(4.4)
    expect(clip.notes[0].startBeat).toBe(0)
    expect(store.project.tracks).toHaveLength(before)
    store.undo()
    expect(store.track(keys.id)!.midiClips.some((item) => item.name === 'Chord')).toBe(false)

    store.selectTrack(store.project.tracks.find((track) => track.type === 'audio')!.id)
    store.placeMidiClipAtPlayhead(null, midiClip('Lead'), 1.3)
    const made = store.project.tracks.find((track) => track.id === store.selectedTrackId)!
    expect(made.type).toBe('midi')
    expect(made.name).toBe('Lead')
    expect(made.midiClips[0].startBeat).toBe(1.3)
    store.undo()
    expect(store.project.tracks.some((track) => track.name === 'Lead')).toBe(false)
  })

  it('writes Scaler and slice MIDI at the exact beat on a compatible track', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(store.project.tracks[0].id)
    store.writeScalerClip(keys.id, [{ pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 }], 2.25, 'C')
    const chord = store.track(keys.id)!.midiClips.find((clip) => clip.name === 'C')!
    expect(chord.startBeat).toBe(2.25)
    store.undo()
    expect(store.track(keys.id)!.midiClips.some((clip) => clip.name === 'C')).toBe(false)

    store.addPlugin(store.project.tracks[0].id, 'sampler')
    const sampler = store.track(store.project.tracks[0].id)!.plugins.find((plugin) => plugin.pluginId === 'sampler')!
    store.addAsset({ id: 'tone', name: 'Tone', sampleRate: 48000, channels: [new Float32Array(8000).fill(0.2)] })
    store.setSampleBuffer(store.project.tracks[0].id, sampler.id, 'tone')
    store.chopSample(store.project.tracks[0].id, sampler.id, 'grid')
    store.selectTrack(keys.id)
    store.exportSlices(store.project.tracks[0].id, sampler.id, 4.4)
    const slices = store.track(keys.id)!.midiClips.find((clip) => clip.name === 'Slices')!
    expect(slices.startBeat).toBe(4.4)
    expect(slices.notes.length).toBeGreaterThan(0)
  })

  it('bounces the looper onto the selected audio track at the playhead sample', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const vocal = store.project.tracks[0]
    const music = store.project.tracks[1]
    store.addPlugin(vocal.id, 'sampler')
    const plugin = store.track(vocal.id)!.plugins.find((item) => item.pluginId === 'sampler')!
    store.addAsset({ id: 'loop-buf', name: 'Loop', sampleRate: store.project.sampleRate, channels: [new Float32Array(128).fill(0.25)] })
    plugin.looper = { ...emptyLooper(), layers: [{ id: 'a', bufferId: 'loop-buf', gain: 1, mute: false, reverse: false, speed: 1 }], lengthSamples: 128, sourceRate: store.project.sampleRate }
    store.selectTrack(music.id)
    const sample = beatSample(store, 1.3)
    const before = store.project.tracks.length
    store.bounceLooper(vocal.id, plugin.id, sample)
    expect(store.project.tracks).toHaveLength(before)
    expect(store.track(music.id)!.clips).toHaveLength(1)
    expect(store.track(music.id)!.clips[0].startSample).toBe(sample)
    expect(projectSampleBeat(store.project, store.track(music.id)!.clips[0].startSample)).toBeCloseTo(1.3, 1)
    store.undo()
    expect(store.track(music.id)!.clips).toHaveLength(0)

    store.selectTrack(store.project.tracks.find((track) => track.type === 'midi')!.id)
    store.bounceLooper(vocal.id, plugin.id, sample)
    const made = store.project.tracks.find((track) => track.id === store.selectedTrackId)!
    expect(made.type).toBe('audio')
    expect(made.clips[0].startSample).toBe(sample)
    store.undo()
    expect(store.project.tracks.some((track) => track.clips.some((clip) => clip.name === 'Loop'))).toBe(false)
  })

  it('freezes onto another audio track at the playhead, in one undo', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks[0]
    const music = store.project.tracks[1]
    store.selectTrack(music.id)
    const sample = beatSample(store, 2.2)
    const audio = new Float32Array(200)
    store.receiveFreeze(vocal.id, { sampleRate: 48000, channels: [audio, audio] }, sample)
    expect(store.track(vocal.id)!.mute).toBe(true)
    expect(store.track(music.id)!.clips[0].startSample).toBe(sample)
    expect(store.project.tracks.some((track) => track.name.endsWith(' bounce'))).toBe(false)
    store.undo()
    expect(store.track(vocal.id)!.mute).toBe(false)
    expect(store.track(music.id)!.clips).toHaveLength(0)

    store.selectTrack(vocal.id)
    const frozen = applyFreeze(store.project, store.buffers, vocal.id, { sampleRate: 48000, channels: [audio, audio] }, sample)
    const bounce = frozen.project.tracks.find((track) => track.name.endsWith(' bounce'))!
    expect(bounce.clips[0].startSample).toBe(sample)
    expect(frozen.project.tracks[0].mute).toBe(true)
  })

  it('sends patterns to the selected MIDI track at an unsnapped beat', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    store.setSnapDivision('1/4')
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const arranged = store.sendPatternToArrange(4.4)
    expect(arranged?.trackId).toBe(keys.id)
    const clip = store.track(keys.id)!.midiClips.find((item) => item.id === arranged!.clipId)!
    expect(clip.startBeat).toBe(4.4)
    store.undo()
    expect(store.track(keys.id)!.midiClips.some((item) => item.id === arranged!.clipId)).toBe(false)

    const song = store.sendPatternToSong('midi', null, 2.2)
    expect(song?.trackId).toBe(keys.id)
    expect(store.track(keys.id)!.midiClips.find((item) => item.id === song!.clipId)!.startBeat).toBe(2.2)
    store.undo()

    store.placePattern(6.2, keys.id)
    const pattern = store.project.patternClips![0]
    expect(pattern.startBeat).toBe(6.2)
    expect(pattern.trackId).toBe(keys.id)
    const mirrored = store.mirrorPatternClip(pattern.id)
    expect(mirrored?.trackId).toBe(keys.id)
    expect(store.track(keys.id)!.midiClips.find((item) => item.id === mirrored!.clipId)!.startBeat).toBe(6.2)
    store.undo()
    expect(store.project.patternClips!.find((item) => item.id === pattern.id)?.suppressed).toBeFalsy()
  })

  it('starts a generated part and an Unstuck clip at the given beat', () => {
    const store = new ProjectStore(createEmptyProject())
    store.project.snap = true
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    store.selectTrack(keys.id)
    const part: GeneratedPart = {
      kind: 'bass',
      name: 'Bass line',
      trackName: 'Bass',
      instrument: 'synth',
      notes: [{ pitch: 40, startBeat: 0, durationBeats: 1, velocity: 0.8 }],
      chords: [],
      label: '',
      bars: 1,
      seed: 1,
      variation: 0,
    }
    store.insertGenerated(part, 'part', 3.3)
    expect(store.track(keys.id)!.midiClips.at(-1)!.startBeat).toBe(3.3)
    store.undo()

    const draft: SongDraft = {
      summary: 'Bass',
      seed: 1,
      sections: [],
      sectionMode: 'none',
      tracks: [{
        role: 'bass',
        name: 'Bass',
        color: '#79b8d4',
        instrument: 'synth',
        pluginId: 'synth',
        volume: 0.8,
        pan: 0,
        seed: 1,
        clips: [{ name: 'Unstuck Bass', startBeat: 2.5, durationBeats: 4, notes: [{ pitch: 40, startBeat: 0, durationBeats: 1, velocity: 0.8 }] }],
      }],
    }
    store.writeUnstuck(draft)
    const bass = store.project.tracks.find((track) => track.name === 'Bass')!
    const placed = bass.midiClips.find((clip) => clip.name === 'Unstuck Bass')!
    expect(placed.startBeat).toBe(2.5)
    expect(bass.type).toBe('midi')
    store.undo()
    expect(store.project.tracks.some((track) => track.name === 'Bass')).toBe(false)
  })
})

describe('step sequencer selected controls', () => {
  it('paints Pattern and 16 as selected and keeps Close off the preset row', () => {
    const overlay = readFileSync(new URL('../ui/screenOverlay.css', import.meta.url), 'utf8')
    const premium = readFileSync(new URL('../ui/premium.css', import.meta.url), 'utf8')
    expect(overlay).toContain('.shell .step-sequencer .rack-mode button[aria-pressed=\'true\']')
    expect(overlay).toContain('background-color: var(--accent, #73c48f)')
    expect(premium).toContain('.shell .rack-lengths button[aria-pressed=\'true\']')
    expect(overlay).toContain('.step-sequencer-bar > button.step-close.overlay-close')
    expect(overlay).toContain('margin: 0')
    expect(overlay).toContain('margin-bottom: 8px')
    expect(overlay).toContain('min-height: 40px')
  })
})

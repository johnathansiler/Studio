import { describe, expect, it } from 'vitest'
import { renderClipChannels } from '../audio/stretch/engine'
import {
  applyHarmonizeToProject,
  defaultHarmonizeKey,
  fitHarmonize,
  harmonizeMoves,
  harmonizeSemitones,
  majorMinorKey,
  nothingToHarmonizeMessage,
  planRows,
  scopeClip,
  shiftableCount,
  type HarmonizeInput,
} from '../model/harmonize'
import { fitToProject, projectMusicalKey } from '../model/keyFit'
import { createEmptyProject, type AudioClip, type MidiClip } from '../model/types'
import { ProjectStore } from '../state/store'

function input(partial: Partial<HarmonizeInput> & Pick<HarmonizeInput, 'name' | 'kind'>): HarmonizeInput {
  return {
    trackId: 'track',
    clipId: partial.name,
    trackName: 'Music',
    ...partial,
  }
}

function audio(partial: Partial<AudioClip> & Pick<AudioClip, 'id' | 'name'>): AudioClip {
  return {
    bufferId: partial.id,
    startSample: 0,
    offsetSamples: 0,
    durationSamples: 4800,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
    stretch: { sourceSamples: 4800, semitones: 0, cents: 0, mode: 'pro', followTempo: true, sourceBpm: 120, markers: [] },
    ...partial,
  }
}

describe('harmonize scope', () => {
  it('shifts harmonic loops, instrument clips, MIDI, and pitched one-shots', () => {
    const loop = scopeClip(input({ name: 'Keys loop', kind: 'audio', soundType: 'loop', soundCategory: 'keys', soundKey: 'A minor' }))
    const stab = scopeClip(input({ name: 'Chord stab', kind: 'audio', soundType: 'one-shot', soundCategory: 'chord', soundKey: 'F# minor' }))
    const bass = scopeClip(input({ name: '808 Bass', kind: 'audio', soundType: 'one-shot', soundCategory: 'bass', soundKey: 'E minor', soundTags: ['808', 'bass'] }))
    const instrument = scopeClip(input({ name: 'Piano note', kind: 'audio', soundType: 'instrument', soundCategory: 'piano', soundKey: 'C major' }))
    const midi = scopeClip(input({
      name: 'Chords',
      kind: 'midi',
      trackName: 'Keys',
      instrument: 'synth',
      notes: [60, 64, 67, 72].map((pitch) => ({ pitch, durationBeats: 1 })),
    }))
    expect(loop).toMatchObject({ disposition: 'harmonic', reason: 'Harmonic loop', key: { root: 9, minor: true } })
    expect(stab).toMatchObject({ disposition: 'harmonic', reason: 'Harmonic one-shot', key: { root: 6, minor: true } })
    expect(bass).toMatchObject({ disposition: 'harmonic', reason: 'Harmonic one-shot' })
    expect(instrument).toMatchObject({ disposition: 'harmonic', reason: 'Instrument' })
    expect(midi).toMatchObject({ disposition: 'harmonic', reason: 'MIDI', key: { root: 0, minor: false } })
  })

  it('skips drums, drum one-shots, percussion, effects, and beat machines', () => {
    const kick = scopeClip(input({ name: 'Kick', kind: 'audio', soundType: 'one-shot', soundCategory: 'kick' }))
    const hat = scopeClip(input({ name: 'Hat', kind: 'audio', soundType: 'one-shot', soundRole: 'drum_one_shot', soundKey: 'C major' }))
    const drums = scopeClip(input({ name: 'Drum loop', kind: 'audio', soundType: 'loop', soundCategory: 'drums' }))
    const perc = scopeClip(input({ name: 'Shaker loop', kind: 'audio', soundType: 'loop', soundCategory: 'percussion' }))
    const noise = scopeClip(input({ name: 'Riser', kind: 'audio', soundType: 'sfx', soundCategory: 'fx' }))
    const pads = scopeClip(input({
      name: 'Beat',
      kind: 'midi',
      instrument: 'pads',
      notes: [{ pitch: 36, durationBeats: 0.25 }],
    }))
    const kit = scopeClip(input({
      name: 'Kit',
      kind: 'midi',
      instrument: 'drum-machine',
      notes: [{ pitch: 38, durationBeats: 0.25 }],
    }))
    const steps = scopeClip(input({
      name: 'Steps',
      kind: 'midi',
      pluginIds: ['steps'],
      notes: [{ pitch: 60, durationBeats: 1 }],
    }))
    const unnamed = scopeClip(input({ name: 'Hit', kind: 'audio', soundType: 'one-shot', hearingClear: false }))
    expect(kick.reason).toBe('Drum one-shot')
    expect(hat.reason).toBe('Drum one-shot')
    expect(drums.reason).toBe('Drum loop')
    expect(perc.reason).toBe('Percussion')
    expect(noise.reason).toBe('Effect')
    expect(pads.reason).toBe('Beat Machine')
    expect(kit.reason).toBe('Drum kit')
    expect(steps.reason).toBe('Drum pattern')
    expect(unnamed.reason).toBe('No clear key')
    for (const clip of [kick, hat, drums, perc, noise, pads, kit, steps, unnamed]) {
      expect(clip.disposition).toBe('skip')
    }
  })

  it('leaves vocal tracks out unless Include vocals is on', () => {
    const vocal = scopeClip(input({
      name: 'Lead vocal',
      kind: 'audio',
      trackName: 'Vocal',
      trackKind: 'vocal',
      soundType: 'loop',
      loopKey: 'A minor',
    }))
    expect(vocal.disposition).toBe('vocal')
    const target = majorMinorKey(0, false)
    const held = planRows([vocal], target, false)
    const moved = planRows([vocal], target, true)
    expect(held[0]).toMatchObject({ action: 'skip', reason: 'Vocal track. Sung as recorded.' })
    expect(moved[0]).toMatchObject({ action: 'shift', semitones: 0, from: 'A minor', to: 'C major' })
  })
})

describe('harmonize interval', () => {
  it('uses the short move in −6..+5 and keeps relative keys still', () => {
    const cMajor = majorMinorKey(0, false)
    const aMinor = majorMinorKey(9, true)
    const fSharp = majorMinorKey(6, false)
    expect(fitToProject(fSharp, cMajor).semitones).toBe(6)
    expect(fitHarmonize(aMinor, cMajor)).toMatchObject({ semitones: 0, relative: true })
    expect(fitHarmonize(cMajor, aMinor)).toMatchObject({ semitones: 0, relative: true })
    expect(fitHarmonize(fSharp, cMajor).semitones).toBe(-6)
    expect(harmonizeSemitones(6, 0)).toBe(-6)
    expect(harmonizeSemitones(7, 0)).toBe(5)
    expect(harmonizeSemitones(1, 0)).toBe(-1)
    expect(fitHarmonize(aMinor, majorMinorKey(0, true)).semitones).toBe(3)
    const rows = planRows([
      scopeClip(input({ name: 'Far', kind: 'audio', soundType: 'loop', soundKey: 'F# major' })),
      scopeClip(input({ name: 'Near', kind: 'audio', soundType: 'loop', soundKey: 'A minor' })),
    ], cMajor, false)
    expect(rows.map((row) => row.semitones)).toEqual([-6, 0])
  })

  it('defaults to the song key, or the key most harmonic clips already share', () => {
    const aMinor = scopeClip(input({ name: 'A', kind: 'audio', soundType: 'loop', soundKey: 'A minor' }))
    const another = scopeClip(input({ name: 'B', kind: 'audio', soundType: 'loop', soundKey: 'A minor' }))
    const cMajor = scopeClip(input({ name: 'C', kind: 'audio', soundType: 'loop', soundKey: 'C major' }))
    const kick = scopeClip(input({ name: 'Kick', kind: 'audio', soundType: 'one-shot', soundCategory: 'kick', soundKey: 'C major' }))
    expect(defaultHarmonizeKey(null, [aMinor, another, cMajor, kick])?.label).toBe('A minor')
    expect(defaultHarmonizeKey(majorMinorKey(2, false), [aMinor])?.label).toBe('D major')
    expect(projectMusicalKey({ root: 0, scale: 'ionian' })).toBeNull()
  })
})

describe('harmonize apply', () => {
  it('shifts the ticked clips and the song key in one undo, and skips vocals by default', () => {
    const store = new ProjectStore(createEmptyProject())
    const vocal = store.project.tracks.find((track) => track.kind === 'vocal')!
    const music = store.project.tracks.find((track) => track.kind === 'loop')!
    const keys = store.project.tracks.find((track) => track.type === 'midi')!
    const loop = audio({ id: 'loop', name: 'Keys loop', soundType: 'loop', soundCategory: 'keys', soundKey: 'A minor', loopKey: 'A minor' })
    const pad = audio({ id: 'pad', name: 'Pad', soundType: 'loop', soundCategory: 'pad', soundKey: 'C major' })
    const kick = audio({ id: 'kick', name: 'Kick', soundType: 'one-shot', soundCategory: 'kick', soundRole: 'drum_one_shot' })
    const take = audio({
      id: 'take',
      name: 'Lead vocal',
      playback: 'recorded',
      source: 'local',
      loopKey: 'G major',
      stretch: { sourceSamples: 4800, semitones: 0, cents: 0, mode: 'pro', followTempo: false, sourceBpm: null, markers: [] },
    })
    music.clips.push(loop, pad, kick)
    vocal.clips.push(take)
    const midi: MidiClip = {
      id: 'chords',
      name: 'Chords',
      startBeat: 0,
      durationBeats: 4,
      notes: [60, 62, 64, 65, 67, 69, 71, 72].map((pitch, index) => ({ id: `n${index}`, pitch, startBeat: index * 0.5, durationBeats: 0.5, velocity: 0.8 })),
    }
    keys.midiClips.push(midi)
    store.renameProject('Session')

    const scoped = [
      scopeClip(input({ ...loopFacts(loop), trackId: music.id, trackKind: 'loop' })),
      scopeClip(input({ ...loopFacts(pad), trackId: music.id, trackKind: 'loop' })),
      scopeClip(input({ ...loopFacts(kick), trackId: music.id, trackKind: 'loop' })),
      scopeClip(input({ ...loopFacts(take), trackId: vocal.id, trackName: 'Vocal', trackKind: 'vocal' })),
      scopeClip(input({
        name: 'Chords',
        clipId: midi.id,
        kind: 'midi',
        trackId: keys.id,
        trackName: 'Keys',
        instrument: 'synth',
        notes: midi.notes.map((note) => ({ pitch: note.pitch, durationBeats: note.durationBeats })),
      })),
    ]
    const target = majorMinorKey(2, false)
    const rows = planRows(scoped, target, false)
    expect(rows.find((row) => row.name === 'Kick')?.action).toBe('skip')
    expect(rows.find((row) => row.name === 'Lead vocal')?.action).toBe('skip')
    expect(rows.find((row) => row.name === 'Keys loop')).toMatchObject({ action: 'shift', semitones: 5 })
    const moves = harmonizeMoves(rows, new Set(['pad']))
    expect(moves.map((move) => move.clipId).sort()).toEqual(['chords', 'loop'])
    const beforeUndo = store.canUndo
    expect(beforeUndo).toBe(true)

    store.applyHarmonize({ root: target.root, minor: target.minor, moves })
    expect(store.project.scale?.keySet).toBe(true)
    expect(store.project.scale?.root).toBe(2)
    expect(store.project.scale?.scale).toBe('ionian')
    expect(loop.stretch?.semitones).toBe(5)
    expect(loop.keyShift?.to).toBe('D major')
    expect(loop.durationSamples).toBe(4800)
    expect(pad.stretch?.semitones).toBe(0)
    expect(kick.stretch?.semitones).toBe(0)
    expect(take.stretch?.semitones).toBe(0)
    expect(midi.notes.map((note) => note.pitch)).toEqual([62, 64, 66, 67, 69, 71, 73, 74])
    expect(midi.keyShift?.semitones).toBe(2)

    store.undo()
    const restoredLoop = store.project.tracks.flatMap((track) => track.clips).find((clip) => clip.id === 'loop')
    const restoredMidi = store.project.tracks.flatMap((track) => track.midiClips).find((clip) => clip.id === 'chords')
    expect(store.project.name).toBe('Session')
    expect(store.project.scale?.keySet).not.toBe(true)
    expect(restoredLoop?.stretch?.semitones).toBe(0)
    expect(restoredLoop?.keyShift).toBeUndefined()
    expect(restoredMidi?.notes.map((note) => note.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72])
    expect(restoredMidi?.keyShift).toBeUndefined()
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.project.name).not.toBe('Session')
    expect(store.canUndo).toBe(false)
  })

  it('pitches an included vocal without changing its length, and one revert puts it back', () => {
    const project = createEmptyProject()
    const vocal = project.tracks.find((track) => track.kind === 'vocal')!
    const rate = project.sampleRate
    const take = audio({
      id: 'take',
      name: 'Lead vocal',
      playback: 'recorded',
      source: 'local',
      loopKey: 'C major',
      durationSamples: rate,
      stretch: { sourceSamples: rate, semitones: 0, cents: 0, mode: 'pro', followTempo: false, sourceBpm: null, markers: [] },
    })
    vocal.clips.push(take)
    const scoped = [scopeClip(input({ ...loopFacts(take), trackId: vocal.id, trackKind: 'vocal' }))]
    const skipped = planRows(scoped, majorMinorKey(2, false), false)
    expect(skipped[0].action).toBe('skip')
    expect(nothingToHarmonizeMessage(skipped)).toMatch(/Vocal/)
    const moves = harmonizeMoves(planRows(scoped, majorMinorKey(2, false), true))
    expect(moves).toHaveLength(1)
    expect(shiftableCount(planRows(scoped, majorMinorKey(2, false), true))).toBe(1)
    applyHarmonizeToProject(project, { root: 2, minor: false, moves })
    expect(project.scale?.keySet).toBe(true)
    expect(take.stretch?.semitones).toBe(2)
    expect(take.playback).toBeUndefined()
    expect(take.durationSamples).toBe(rate)
    const inputSamples = sine(440, rate)
    const heard = renderClipChannels([inputSamples], take, project, 'hq')
    expect(heard[0].length).toBe(inputSamples.length)
    expect(different(heard[0], inputSamples)).toBe(true)

    const store = new ProjectStore(project)
    store.revertKeyShift(vocal.id, take.id)
    expect(take.stretch?.semitones).toBe(0)
    expect(take.playback).toBe('recorded')
    expect(take.keyShift).toBeUndefined()
    expect(take.durationSamples).toBe(rate)
  })
})

function loopFacts(clip: AudioClip): HarmonizeInput {
  return {
    trackId: 'track',
    clipId: clip.id,
    name: clip.name,
    kind: 'audio',
    trackName: 'Music',
    soundType: clip.soundType,
    soundCategory: clip.soundCategory,
    soundRole: clip.soundRole,
    soundKey: clip.soundKey,
    loopKey: clip.loopKey,
    existingSemitones: clip.stretch?.semitones ?? 0,
  }
}

function sine(hz: number, length: number) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / 48000) * 0.4
  return out
}

function different(left: Float32Array, right: Float32Array) {
  let sum = 0
  const step = Math.max(1, Math.floor(left.length / 200))
  for (let i = 0; i < left.length && i < right.length; i += step) sum += Math.abs((left[i] || 0) - (right[i] || 0))
  return sum > 1
}

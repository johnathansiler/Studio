import { describe, expect, it } from 'vitest'
import { detectKey } from '../analysis/clipKey'
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

  it('treats a file key as the source and does not add a shift that Detect already heard', () => {
    const file = scopeClip(input({
      name: 'Keys loop',
      kind: 'audio',
      soundType: 'loop',
      soundKey: 'C major',
      hearingKey: 'D major',
      hearingClear: true,
      existingSemitones: 2,
    }))
    const sounded = scopeClip(input({
      name: 'Heard loop',
      kind: 'audio',
      soundType: 'loop',
      hearingKey: 'D major',
      hearingClear: true,
      existingSemitones: 2,
    }))
    const fresh = scopeClip(input({
      name: 'Fresh loop',
      kind: 'audio',
      soundType: 'loop',
      hearingKey: 'A minor',
      hearingClear: true,
    }))
    expect(planRows([file], majorMinorKey(2, false), false)[0].semitones).toBe(0)
    expect(sounded.needsDetect).toBe(true)
    expect(sounded.key).toBeNull()
    expect(fresh).toMatchObject({ needsDetect: false, key: { root: 9, minor: true } })
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

  it('renders the shifted audio in the target key, at the same length, without a loop click', () => {
    const rate = 48000
    const project = createEmptyProject(rate)
    const music = project.tracks.find((track) => track.kind === 'loop')!
    const vocal = project.tracks.find((track) => track.kind === 'vocal')!
    const far = progression([[0, 4, 7], [5, 9, 0], [7, 11, 2], [0, 4, 7]], 6, rate)
    const near = progression([[0, 3, 7], [5, 8, 0], [7, 10, 2], [0, 3, 7]], 9, rate)
    const drums = hatLoop(rate)
    const loop = periodicChord(rate, [220, 277.18, 329.63])
    const brass = loopClip('brass', 'Brass loop', far, { soundType: 'loop', soundCategory: 'brass', soundKey: 'F# major' })
    const guitar = loopClip('guitar', 'Guitar loop', near, { soundType: 'loop', soundCategory: 'guitar', soundKey: 'A minor' })
    const beat = loopClip('drums', 'Drum loop', drums, { soundType: 'loop', soundCategory: 'drums', soundRole: 'drum_one_shot' })
    beat.stretch!.mode = 'beats'
    const tone = loopClip('tone', 'A chord', loop, { soundType: 'loop', soundCategory: 'keys', soundKey: 'A major' })
    music.clips.push(brass, guitar, beat, tone)
    const scoped = [brass, guitar, beat, tone].map((clip) => scopeClip(input({
      ...loopFacts(clip),
      trackId: music.id,
      trackKind: 'loop',
    })))
    const vocalTake = loopClip('vocal', 'Lead vocal', periodicChord(rate, [293.66]), { soundType: 'loop', loopKey: 'D major' })
    vocalTake.playback = 'recorded'
    vocalTake.source = 'local'
    vocalTake.stretch!.followTempo = false
    vocal.clips.push(vocalTake)
    scoped.push(scopeClip(input({ ...loopFacts(vocalTake), trackId: vocal.id, trackKind: 'vocal' })))
    const rows = planRows(scoped, majorMinorKey(0, false), false)
    expect(rows.find((row) => row.name === 'Drum loop')?.action).toBe('skip')
    expect(rows.find((row) => row.name === 'Lead vocal')?.action).toBe('skip')
    expect(rows.find((row) => row.name === 'Guitar loop')?.semitones).toBe(0)
    expect(rows.find((row) => row.name === 'Brass loop')?.semitones).toBe(-6)
    applyHarmonizeToProject(project, { root: 0, minor: false, moves: harmonizeMoves(rows) })
    expect(project.scale?.keySet).toBe(true)
    expect(brass.durationSamples).toBe(far.length)
    expect(guitar.stretch?.followTempo).toBe(true)
    expect(beat.stretch?.semitones).toBe(0)
    expect(vocalTake.stretch?.semitones).toBe(0)
    expect(vocalTake.playback).toBe('recorded')

    const brassOut = renderClipChannels([far], brass, project, 'hq')[0]
    const guitarOut = renderClipChannels([near], guitar, project, 'hq')[0]
    const drumOut = renderClipChannels([drums], beat, project, 'hq')[0]
    const toneOut = renderClipChannels([loop], tone, project, 'hq')[0]
    expect(brassOut.length).toBe(far.length)
    expect(guitarOut.length).toBe(near.length)
    expect(drumOut.length).toBe(drums.length)
    expect(toneOut.length).toBe(loop.length)
    expect(same(drumOut, drums)).toBe(true)
    const brassKey = detectKey(brassOut, rate)
    const guitarKey = detectKey(guitarOut, rate)
    expect(brassKey.clear).toBe(true)
    expect(brassKey.root).toBe(0)
    expect(brassKey.scale).toBe('ionian')
    expect(guitarKey.clear).toBe(true)
    expect(guitarKey.root).toBe(9)
    expect(guitarKey.scale).toBe('aeolian')
    const join = Math.abs(toneOut[0] - toneOut[toneOut.length - 1])
    let bodyStep = 0
    for (let i = Math.floor(loop.length / 2); i < Math.floor(loop.length / 2) + 2000; i++) {
      bodyStep = Math.max(bodyStep, Math.abs(toneOut[i] - toneOut[i - 1]))
    }
    expect(join).toBeLessThan(bodyStep * 3 + 0.02)
    let silent = 0
    for (let i = Math.floor(toneOut.length * 0.1); i < toneOut.length * 0.9; i++) {
      if (Math.abs(toneOut[i]) < 1e-4) silent += 1
      else silent = 0
      expect(silent).toBeLessThan(rate * 0.01)
    }
  }, 60000)
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
      data[i] += Math.sin(2 * Math.PI * f * t) * partial * env
    }
  }
}

function progression(degrees: number[][], root: number, rate: number) {
  const seconds = 0.7
  const parts = degrees.map((shape) => {
    const data = new Float32Array(Math.round(seconds * rate))
    const notes = shape.map((interval) => 60 + root + interval)
    addTone(data, notes[0] - 12, rate, 0.34)
    for (const note of notes) addTone(data, note, rate, 0.16)
    return data
  })
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function periodicChord(rate: number, frequencies: number[]) {
  const data = new Float32Array(rate * 2)
  for (const f0 of frequencies) {
    const cycles = Math.round((f0 * data.length) / rate)
    const freq = (cycles * rate) / data.length
    for (let h = 1; h <= 4; h++) {
      for (let i = 0; i < data.length; i++) data[i] += Math.sin((2 * Math.PI * freq * h * i) / rate) / (h * h) * 0.1
    }
  }
  return data
}

function hatLoop(rate: number) {
  const data = new Float32Array(rate)
  for (let hit = 0; hit < 8; hit++) {
    const at = Math.round(hit * rate / 8)
    for (let i = 0; i < 180 && at + i < data.length; i++) {
      data[at + i] += (Math.random() * 2 - 1) * Math.exp(-i / 28) * 0.7
    }
  }
  return data
}

function loopClip(id: string, name: string, buffer: Float32Array, fields: Partial<AudioClip>): AudioClip {
  return audio({
    id,
    name,
    durationSamples: buffer.length,
    stretch: { sourceSamples: buffer.length, semitones: 0, cents: 0, mode: 'pro', followTempo: true, sourceBpm: 120, markers: [] },
    ...fields,
  })
}

function same(left: Float32Array, right: Float32Array) {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 11) if (Math.abs(left[i] - right[i]) > 1e-5) return false
  return true
}

function different(left: Float32Array, right: Float32Array) {
  let sum = 0
  const step = Math.max(1, Math.floor(left.length / 200))
  for (let i = 0; i < left.length && i < right.length; i += step) sum += Math.abs((left[i] || 0) - (right[i] || 0))
  return sum > 1
}

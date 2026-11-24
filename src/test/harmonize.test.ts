import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { clipNeedsStretch, renderClipChannels } from '../audio/stretch/engine'
import { HarmonizeDialog } from '../ui/HarmonizeSheet'
import { askHarmonize, runHarmonizeSong } from '../ui/harmonizeSong'
import {
  defaultHarmonizeKey,
  formatHarmonizeSemitones,
  harmonizeGate,
  harmonizeMove,
  harmonizeRows,
  musicalKey,
  retargetHarmonize,
  type HarmonizeMeta,
  type HeardKey,
} from '../model/harmonize'
import { createEmptyProject, makeTrack, type AudioClip, type MidiClip, type Project } from '../model/types'
import { ProjectStore } from '../state/store'

function tone(length: number) {
  const data = new Float32Array(length)
  for (let i = 0; i < length; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.2
  return data
}

function audio(id: string, name: string, bufferId: string, patch: Partial<AudioClip> = {}): AudioClip {
  return {
    id,
    name,
    bufferId,
    startSample: 0,
    offsetSamples: 0,
    durationSamples: 128,
    fadeInSamples: 0,
    fadeOutSamples: 0,
    gain: 1,
    source: 'import',
    stretch: {
      sourceSamples: 128,
      semitones: 0,
      cents: 0,
      mode: 'pro',
      followTempo: false,
      sourceBpm: null,
      markers: [],
    },
    ...patch,
  }
}

function midi(id: string, name: string, pitches: number[], patch: Partial<MidiClip> = {}): MidiClip {
  return {
    id,
    name,
    startBeat: 0,
    durationBeats: pitches.length,
    notes: pitches.map((pitch, index) => ({
      id: `${id}-n${index}`,
      pitch,
      startBeat: index,
      durationBeats: 1,
      velocity: 0.8,
    })),
    ...patch,
  }
}

function row(project: Project, meta: Record<string, HarmonizeMeta | null>, heard: Record<string, HeardKey | null>, includeVocals: boolean) {
  const heardMap = new Map(Object.entries(heard))
  return harmonizeRows(project, (bufferId) => meta[bufferId] ?? null, heardMap, { includeVocals })
}

describe('harmonize scope and semitones', () => {
  it('keeps the short move inside −6..+5 and leaves relative keys alone', () => {
    const cMajor = musicalKey(0, false)
    const aMinor = musicalKey(9, true)
    expect(harmonizeMove(aMinor, cMajor)).toMatchObject({ semitones: 0, relative: true, modesDiffer: false })
    expect(harmonizeMove(cMajor, aMinor)).toMatchObject({ semitones: 0, relative: true })
    expect(harmonizeMove(musicalKey(6, false), cMajor).semitones).toBe(-6)
    expect(harmonizeMove(cMajor, musicalKey(6, false)).semitones).toBe(-6)
    expect(harmonizeMove(musicalKey(7, false), cMajor).semitones).toBe(5)
    expect(harmonizeMove(musicalKey(1, false), cMajor).semitones).toBe(-1)
    for (let from = 0; from < 12; from++) {
      for (let to = 0; to < 12; to++) {
        for (const minor of [false, true]) {
          const semitones = harmonizeMove(musicalKey(from, minor), musicalKey(to, !minor && from !== to ? false : minor)).semitones
          expect(semitones).toBeGreaterThanOrEqual(-6)
          expect(semitones).toBeLessThanOrEqual(5)
        }
      }
    }
    expect(formatHarmonizeSemitones(-6)).toBe('-6')
    expect(formatHarmonizeSemitones(5)).toBe('+5')
    expect(formatHarmonizeSemitones(0)).toBe('0')
  })

  it('shifts melodic loops and MIDI, and skips drums, one-shots, SFX, and vocals by default', () => {
    const project = createEmptyProject()
    const vocal = project.tracks.find((track) => track.name === 'Vocal')!
    const music = project.tracks.find((track) => track.name === 'Music')!
    const keys = project.tracks.find((track) => track.name === 'Keys')!
    const kit = makeTrack({ name: 'Kit', type: 'midi', instrument: 'drum-machine' })
    const pads = makeTrack({ name: 'Pads', type: 'midi', instrument: 'pads' })
    const eight = makeTrack({ name: '808', type: 'midi', instrument: '808' })
    project.tracks.push(kit, pads, eight)
    music.clips.push(
      audio('guitar', 'Dusty guitar', 'guitar', { loopKey: 'D major' }),
      audio('perc', 'Shaker loop', 'perc'),
      audio('shot', 'Coin', 'shot'),
      audio('sfx', 'Riser', 'sfx'),
      audio('kick', 'Kick loop', 'kick', { stretch: { sourceSamples: 128, semitones: 0, cents: 0, mode: 'beats', followTempo: false, sourceBpm: 100, markers: [] } }),
      audio('noise', 'Room tone', 'noise'),
      audio('mystery', 'Untitled loop', 'mystery'),
    )
    vocal.clips.push(audio('vox', 'Lead vocal', 'vox', { loopKey: 'G major', source: 'local', playback: 'recorded' }))
    keys.midiClips.push(midi('keys', 'Chords', [60, 62, 64, 65, 67, 69, 71, 72]))
    kit.midiClips.push(midi('kit', 'Beat', [36, 38, 42]))
    pads.midiClips.push(midi('pads', 'Finger beat', [36, 38]))
    eight.midiClips.push(midi('sub', '808', [36, 36, 36]))
    keys.midiClips.push(midi('empty', 'Empty', []), midi('pat', 'Pattern', [60, 64, 67], { patternId: 'beat-1' }))

    const meta: Record<string, HarmonizeMeta> = {
      guitar: { type: 'loop', category: 'guitar', musicalKey: 'D major' },
      perc: { type: 'loop', category: 'percussion' },
      shot: { type: 'one-shot', category: 'foley' },
      sfx: { type: 'sfx', category: 'fx' },
      kick: { type: 'loop', category: 'kick' },
    }
    const heard: Record<string, HeardKey | null> = {
      noise: { clear: false, root: null, minor: false, label: 'No clear key' },
      mystery: { clear: true, root: 9, minor: true, label: 'A minor' },
    }
    const skipped = row(project, meta, heard, false)
    const byId = Object.fromEntries(skipped.map((item) => [item.clipId, item]))
    expect(byId.guitar).toMatchObject({ action: 'shift', from: 'D major' })
    expect(byId.mystery).toMatchObject({ action: 'shift', from: 'A minor' })
    expect(byId.keys).toMatchObject({ action: 'shift', from: 'C major' })
    expect(byId.perc).toMatchObject({ action: 'skip', reason: 'Percussion' })
    expect(byId.shot).toMatchObject({ action: 'skip', reason: 'One-shot' })
    expect(byId.sfx).toMatchObject({ action: 'skip', reason: 'SFX' })
    expect(byId.kick).toMatchObject({ action: 'skip', reason: 'Drum loop' })
    expect(byId.noise).toMatchObject({ action: 'skip', reason: 'No clear key' })
    expect(byId.vox).toMatchObject({ action: 'skip', reason: 'Vocal track' })
    expect(byId.kit).toMatchObject({ action: 'skip', reason: 'Drum kit' })
    expect(byId.pads).toMatchObject({ action: 'skip', reason: 'Beat Machine' })
    expect(byId.sub).toMatchObject({ action: 'skip', reason: 'Drum kit' })
    expect(byId.empty).toMatchObject({ action: 'skip', reason: 'No notes' })
    expect(byId.pat).toMatchObject({ action: 'skip', reason: 'Beat pattern' })

    const withVocals = row(project, meta, heard, true)
    expect(withVocals.find((item) => item.clipId === 'vox')).toMatchObject({ action: 'shift', from: 'G major' })
    expect(harmonizeGate(skipped).open).toBe(true)
    expect(harmonizeGate(skipped.filter((item) => item.clipId === 'kick' || item.clipId === 'shot')).open).toBe(false)
    expect(harmonizeGate([]).toast).toMatch(/Nothing to harmonize yet/)

    const shifts = skipped.filter((item) => item.action === 'shift')
    expect(defaultHarmonizeKey({ root: 2, scale: 'ionian', keySet: true }, shifts).label).toBe('D major')
    expect(defaultHarmonizeKey({ root: 0, scale: 'ionian' }, [
      { fromRoot: 9, fromMinor: true },
      { fromRoot: 9, fromMinor: true },
      { fromRoot: 0, fromMinor: false },
    ]).label).toBe('A minor')
    const aimed = retargetHarmonize(skipped, musicalKey(0, false))
    expect(aimed.find((item) => item.clipId === 'mystery' && item.action === 'shift')).toMatchObject({ semitones: 0, to: 'C major' })
    expect(aimed.find((item) => item.clipId === 'guitar' && item.action === 'shift')).toMatchObject({ semitones: -2, to: 'C major' })
  })
})

describe('harmonize apply', () => {
  it('moves every chosen clip in one undo and leaves vocals out unless asked', async () => {
    const store = new ProjectStore(createEmptyProject(48000))
    const music = store.project.tracks.find((track) => track.name === 'Music')!
    const vocal = store.project.tracks.find((track) => track.name === 'Vocal')!
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const samples = tone(640)
    store.addAsset({ id: 'g-buf', name: 'Dusty guitar', sampleRate: 48000, channels: [samples] })
    store.addAsset({ id: 'v-buf', name: 'Lead vocal', sampleRate: 48000, channels: [samples] })
    music.clips.push(audio('guitar', 'Dusty guitar', 'g-buf', { loopKey: 'D major', durationSamples: samples.length, stretch: { sourceSamples: samples.length, semitones: 0, cents: 0, mode: 'pro', followTempo: false, sourceBpm: 90, markers: [] } }))
    vocal.clips.push(audio('vox', 'Lead vocal', 'v-buf', { loopKey: 'A minor', source: 'local', playback: 'recorded', durationSamples: samples.length }))
    keys.midiClips.push(midi('chords', 'Chords', [60, 62, 64, 65, 67, 69, 71, 72]))
    const beforePitches = keys.midiClips[0].notes.map((note) => note.pitch)
    const beforeDuration = music.clips[0].durationSamples

    const meta = () => ({ type: 'loop', category: 'guitar', musicalKey: 'D major' })
    const plan = harmonizeRows(store.project, (id) => (id === 'g-buf' ? meta() : null), new Map(), { includeVocals: false })
    expect(plan.find((item) => item.clipId === 'vox')).toMatchObject({ action: 'skip', reason: 'Vocal track' })
    const target = musicalKey(7, false)
    expect(store.canUndo).toBe(false)
    const ok = await runHarmonizeSong(store, plan, target)
    expect(ok).toBe(true)
    const guitar = music.clips[0]
    expect(guitar.stretch?.semitones).toBe(5)
    expect(guitar.keyShift).toMatchObject({ from: 'D major', to: 'G major', semitones: 5 })
    expect(guitar.durationSamples).toBe(beforeDuration)
    expect(guitar.stretch?.followTempo).toBe(false)
    expect(guitar.stretch?.sourceBpm).toBe(90)
    expect(vocal.clips[0].stretch?.semitones ?? 0).toBe(0)
    expect(vocal.clips[0].keyShift).toBeUndefined()
    expect(keys.midiClips[0].notes.map((note) => note.pitch)).toEqual(beforePitches.map((pitch) => pitch - 5))
    expect(store.scaleState().keySet).toBe(true)
    expect(store.scaleState().root).toBe(7)
    expect(store.scaleState().scale).toBe('ionian')

    store.undo()
    expect(music.clips[0].stretch?.semitones).toBe(0)
    expect(music.clips[0].keyShift).toBeUndefined()
    expect(music.clips[0].durationSamples).toBe(beforeDuration)
    expect(vocal.clips[0].keyShift).toBeUndefined()
    expect(keys.midiClips[0].notes.map((note) => note.pitch)).toEqual(beforePitches)
    expect(store.scaleState().keySet).toBe(false)
    expect(store.canUndo).toBe(false)

    store.redo()
    expect(music.clips[0].stretch?.semitones).toBe(5)
    expect(keys.midiClips[0].notes[0].pitch).toBe(beforePitches[0] - 5)
    expect(store.scaleState().keySet).toBe(true)
    store.undo()
  }, 30000)

  it('pitches an included vocal without changing its length', () => {
    const project = createEmptyProject(48000)
    const samples = tone(256)
    const clip = audio('vox', 'Lead vocal', 'v', {
      source: 'local',
      playback: 'recorded',
      durationSamples: samples.length,
      stretch: { sourceSamples: samples.length, semitones: 3, cents: 0, mode: 'pro', followTempo: false, sourceBpm: null, markers: [] },
      keyShift: { semitones: 3, from: 'A minor', to: 'C minor', formantBefore: false },
    })
    expect(clipNeedsStretch(clip, project)).toBe(true)
    const heard = renderClipChannels([samples], clip, project, 'hq')[0]
    expect(heard.length).toBe(samples.length)
    const plain = audio('take', 'Take', 't', { playback: 'recorded', durationSamples: samples.length })
    expect(clipNeedsStretch(plain, project)).toBe(false)
    expect(renderClipChannels([samples], plain, project, 'hq')[0].length).toBe(samples.length)
  })
})

describe('harmonize button', () => {
  it('opens the picker for a vocal take and toasts when the song has nothing melodic', () => {
    const empty = new ProjectStore(createEmptyProject())
    expect(askHarmonize(empty)).toBe(false)
    expect(empty.harmonizeOpen).toBe(false)
    expect(empty.toasts.some((toast) => toast.text.includes('Nothing to harmonize yet'))).toBe(true)

    const drums = new ProjectStore(createEmptyProject())
    const music = drums.project.tracks.find((track) => track.name === 'Music')!
    music.clips.push(audio('kick', 'Kick loop', 'kick', {
      stretch: { sourceSamples: 128, semitones: 0, cents: 0, mode: 'beats', followTempo: false, sourceBpm: null, markers: [] },
    }))
    expect(askHarmonize(drums)).toBe(false)
    expect(drums.toasts.at(-1)?.text).toMatch(/Drums, one-shots, and SFX/)

    const sung = new ProjectStore(createEmptyProject())
    const vocal = sung.project.tracks.find((track) => track.name === 'Vocal')!
    vocal.clips.push(audio('vox', 'Lead vocal', 'v', { loopKey: 'A minor', playback: 'recorded' }))
    expect(askHarmonize(sung)).toBe(true)
    expect(sung.harmonizeOpen).toBe(true)
  })
})

describe('harmonize dialog', () => {
  it('lists the moves, the skips, and the vocal opt-in', () => {
    const rows = retargetHarmonize([
      { action: 'shift', trackId: 't', clipId: 'g', name: 'Dusty guitar', kind: 'audio', fromRoot: 9, fromMinor: true, from: 'A minor', to: 'A minor', semitones: 0, tonicOnly: false },
      { action: 'skip', trackId: 'v', clipId: 'vox', name: 'Lead vocal', kind: 'audio', reason: 'Vocal track' },
      { action: 'skip', trackId: 'd', clipId: 'kick', name: 'Kick loop', kind: 'audio', reason: 'Drum loop' },
    ], musicalKey(0, false))
    const html = renderToStaticMarkup(createElement(HarmonizeDialog, {
      rows,
      target: musicalKey(0, false),
      includeVocals: false,
      phase: 'ready',
      progress: null,
      onNote: () => undefined,
      onMode: () => undefined,
      onVocals: () => undefined,
      onApply: () => undefined,
      onClose: () => undefined,
    }))
    expect(html).toContain('Harmonize song')
    expect(html).toContain('Include vocals')
    expect(html).toContain('data-include-vocals')
    expect(html).toContain('Dusty guitar')
    expect(html).toContain('A minor → C major')
    expect(html).toContain('>0<')
    expect(html).toContain('Lead vocal')
    expect(html).toContain('Vocal track')
    expect(html).toContain('Kick loop')
    expect(html).toContain('Drum loop')
    expect(html).toContain('Harmonize to C major')
    expect(html).not.toContain('disabled')
  })
})

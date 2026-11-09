import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { analyzeAudio } from '../analysis/audio'
import { analysisReadout, forgetAnalyses, rememberTrackAnalysis } from '../analysis/cache'
import { analyzeProject } from '../analysis/project'
import { handleAnalysisMessage } from '../analysis/worker'
import { createEmptyProject, uid, type MidiNote, type Project } from '../model/types'
import { decodeWavPCM } from '../model/wav'
import { SOUND_DATASET_BASE } from '../sounds/contract'
import { placeSound } from '../sounds/place'
import type { SoundEntry } from '../sounds/types'
import { AnalysisSheet } from '../ui/AnalysisSheet'
import { ProjectStore } from '../state/store'

afterEach(() => forgetAnalyses())

function midiHz(note: number) {
  return 440 * 2 ** ((note - 69) / 12)
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

/**
 * Harmonic chord, same generator shape as the analysis regression suite.
 * `boostPc` makes one pitch class louder, the way the felt loop's A outruns its C.
 */
function chordBar(notes: number[], beats: number, tempo: number, sampleRate: number, boostPc = -1, boost = 1.2) {
  const samples = Math.round((beats * 60 * sampleRate) / tempo)
  const beat = (60 / tempo) * sampleRate
  const data = new Float32Array(samples)
  for (const note of notes) {
    const freq = midiHz(note)
    const gain = ((note % 12) + 12) % 12 === boostPc ? boost : 1
    for (let h = 1; h <= 4; h++) {
      const f = freq * h
      if (f >= sampleRate * 0.45) break
      const amp = (0.2 / h) * gain
      for (let i = 0; i < samples; i++) {
        const pos = (i % beat) / beat
        const env = Math.min(1, pos / 0.015) * Math.exp(-pos * 1.3)
        data[i] += Math.sin((2 * Math.PI * f * i) / sampleRate) * amp * (0.4 + 0.6 * env)
      }
    }
  }
  return data
}

function audioOf(chords: number[][], tempo = 100, rate = 16000, boostPc = -1, boost = 1.2) {
  return concat(chords.map((notes) => chordBar(notes, 4, tempo, rate, boostPc, boost)))
}

function shift(chords: number[][], semis: number) {
  return chords.map((notes) => notes.map((note) => note + semis))
}

/** I–vi–IV–V7. The same white keys as the minor loop below. */
const MAJOR_LOOP = [
  [48, 60, 64, 67],
  [45, 57, 60, 64],
  [41, 53, 57, 60],
  [43, 59, 62, 65],
]

/** i–iv–v–i. No G major, so the relative major has no dominant. */
const MINOR_LOOP = [
  [45, 57, 60, 64],
  [38, 50, 53, 57],
  [40, 52, 55, 59],
  [45, 57, 60, 64],
]

/** I–IV–V–vi. The vi is louder, and V moves to vi instead of back to I. */
const DECEPTIVE = [
  [48, 60, 64, 67],
  [41, 53, 57, 60],
  [43, 55, 59, 62],
  [45, 57, 60, 64],
]

/** i–iv–V–i with the raised leading tone. Still minor, and not C major's collection. */
const HARMONIC_MINOR = [
  [45, 57, 60, 64],
  [38, 50, 53, 57],
  [40, 52, 56, 59],
  [45, 57, 60, 64],
]

function note(pitch: number, startBeat: number, durationBeats: number, velocity: number): MidiNote {
  return { id: uid('note'), pitch, startBeat, durationBeats, velocity }
}

function midiProject(chords: number[][], tempo = 96): Project {
  const project = createEmptyProject()
  project.tempo = tempo
  const track = project.tracks.find((item) => item.type === 'midi')!
  track.midiClips = [{
    id: uid('midi'),
    name: 'Chords',
    startBeat: 0,
    durationBeats: chords.length * 4,
    notes: chords.flatMap((pitches, bar) => pitches.map((pitch) => note(pitch, bar * 4, 4, pitch < 52 ? 1 : 0.75))),
  }]
  return project
}

describe('tonal center', () => {
  it('hears I–vi–IV–V as major and i–iv–v as minor on one shared note set', () => {
    const tempo = 100
    const rate = 16000
    // A is a little louder than C, which is enough for the pitch profile to say A minor.
    const major = analyzeAudio({ sampleRate: rate, channels: [audioOf(MAJOR_LOOP, tempo, rate, 9)], tempo })
    expect(major.key.root).toBe(0)
    expect(major.key.mode).toBe('major')
    expect(major.scale).toBe('ionian')
    expect(major.key.alternative).toBeUndefined()
    expect(major.key.label).toBe('C major')
    expect(major.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'Am', 'F', 'G7'])

    const minor = analyzeAudio({ sampleRate: rate, channels: [audioOf(MINOR_LOOP, tempo, rate)], tempo })
    expect(minor.key.root).toBe(9)
    expect(minor.key.mode).toBe('minor')
    expect(minor.scale).toBe('aeolian')
    expect(minor.key.alternative).toBeUndefined()
    expect(minor.chordsByBar.map((chord) => chord.symbol)).toEqual(['Am', 'Dm', 'Em', 'Am'])

    const raised = analyzeAudio({ sampleRate: rate, channels: [audioOf(HARMONIC_MINOR, tempo, rate)], tempo })
    expect(raised.key.root).toBe(9)
    expect(raised.scale).toBe('aeolian')
    expect(raised.key.alternative).toBeUndefined()
    expect(raised.chordsByBar.map((chord) => chord.symbol)).toEqual(['Am', 'Dm', 'E', 'Am'])
  })

  it('transposes both centers together', () => {
    const tempo = 96
    const rate = 16000
    for (const semis of [3, 6, 10]) {
      const vi = (9 + semis) % 12
      const major = analyzeAudio({ sampleRate: rate, channels: [audioOf(shift(MAJOR_LOOP, semis), tempo, rate, vi)], tempo })
      expect(major.key.root).toBe(semis % 12)
      expect(major.scale).toBe('ionian')
      expect(major.key.alternative).toBeUndefined()
      const minor = analyzeAudio({ sampleRate: rate, channels: [audioOf(shift(MINOR_LOOP, semis), tempo, rate)], tempo })
      expect(minor.key.root).toBe((9 + semis) % 12)
      expect(minor.scale).toBe('aeolian')
      expect(minor.key.alternative).toBeUndefined()
    }
  })

  it('uses the same decision on MIDI and on the worker project path', () => {
    const midi = analyzeProject(midiProject([
      [48, 60, 64, 67],
      [43, 55, 59, 62],
      [45, 57, 60, 64],
      [41, 53, 57, 60],
    ]))
    expect(midi.key.root).toBe(0)
    expect(midi.scale).toBe('ionian')
    expect(midi.tempo).toBe(96)
    expect(midi.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'G', 'Am', 'F'])
    const minor = analyzeProject(midiProject(MINOR_LOOP))
    expect(minor.key.root).toBe(9)
    expect(minor.scale).toBe('aeolian')

    const rate = 16000
    const tempo = 110
    const audio = audioOf(shift(MAJOR_LOOP, 7), tempo, rate, (9 + 7) % 12)
    const response = handleAnalysisMessage({
      id: 3,
      type: 'analyze',
      sampleRate: rate,
      channels: [audio],
      tempo,
      numerator: 4,
      denominator: 4,
    })
    expect(response.analysis?.key.root).toBe(7)
    expect(response.analysis?.scale).toBe('ionian')
    expect(response.analysis?.key.alternative).toBeUndefined()
  })

  it('stays quiet on silence and does not invent a key for a handful of samples', () => {
    const silent = analyzeAudio({ sampleRate: 16000, channels: [new Float32Array(16000)], tempo: 90 })
    expect(silent.key.confidence).toBe(0)
    expect(silent.key.alternative).toBeUndefined()
    expect(silent.chordsByBar).toEqual([])
    expect(silent.sections).toEqual([])
    expect(analysisReadout(silent)).toBe('Nothing to analyze on this track yet.')

    const short = analyzeAudio({ sampleRate: 16000, channels: [new Float32Array(48)], tempo: 90 })
    expect(short.key.confidence).toBe(0)
    expect(short.key.label).toBe('C major')
    expect(short.key.alternative).toBeUndefined()
    expect(short.tempo).toBe(90)
  })

  it('keeps I–IV–V–vi in the major when vi is louder, and says the minor is still possible', () => {
    const tempo = 100
    const rate = 16000
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    for (const semis of [0, 3, 6]) {
      const root = semis % 12
      const vi = (root + 9) % 12
      const audio = audioOf(shift(DECEPTIVE, semis), tempo, rate, vi, 1.15)
      const fromAudio = analyzeAudio({ sampleRate: rate, channels: [audio], tempo })
      const project = createEmptyProject(rate)
      project.tempo = tempo
      const track = project.tracks.find((item) => item.type === 'audio')!
      track.clips = [{
        id: 'clip',
        name: 'Loop',
        bufferId: 'buf',
        startSample: 0,
        offsetSamples: 0,
        durationSamples: audio.length,
        fadeInSamples: 0,
        fadeOutSamples: 0,
        gain: 1,
        source: 'import',
      }]
      const fromProject = analyzeProject(project, new Map([['buf', { sampleRate: rate, channels: [audio] }]]))
      const fromWorker = handleAnalysisMessage({
        id: semis + 1,
        type: 'analyze',
        sampleRate: rate,
        channels: [audio],
        tempo,
        numerator: 4,
        denominator: 4,
      })
      const fromWorkerProject = handleAnalysisMessage({
        id: semis + 11,
        type: 'project',
        project,
        assets: [{ id: 'buf', sampleRate: rate, channels: [audio] }],
      })
      for (const result of [fromAudio, fromProject, fromWorker.analysis, fromWorkerProject.analysis]) {
        expect(result?.key.root).toBe(root)
        expect(result?.scale).toBe('ionian')
        expect(result?.key.alternative).toBe(`${names[vi]} minor`)
        expect(result?.key.confidence).toBeLessThan(0.6)
        expect(result?.chordsByBar.map((chord) => chord.root)).toEqual([root, (root + 5) % 12, (root + 7) % 12, vi])
      }
      expect(analysisReadout(fromAudio)).toContain(`or ${names[vi]} minor`)
    }
  })

  it('names the relative key when both tonics alternate and neither dominant arrives', () => {
    const tempo = 100
    const rate = 16000
    const swap = [
      [48, 60, 64, 67],
      [45, 57, 60, 64],
      [48, 60, 64, 67],
      [45, 57, 60, 64],
    ]
    const heard = analyzeAudio({ sampleRate: rate, channels: [audioOf(swap, tempo, rate)], tempo })
    expect([0, 9]).toContain(heard.key.root)
    expect(heard.key.alternative).toBe(heard.key.root === 0 ? 'A minor' : 'C major')
    expect(heard.key.confidence).toBeLessThan(0.6)
    expect(analysisReadout(heard)).toContain(`or ${heard.key.alternative}`)
    expect(analysisReadout(heard)).toContain(`${Math.round(heard.key.confidence * 100)}%`)
    expect(heard.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'Am', 'C', 'Am'])
  })

  it('shows a settled key without a percentage hedge', () => {
    const settled = analysisReadout({
      key: { root: 0, name: 'C', mode: 'major', label: 'C major', confidence: 0.82 },
      scale: 'ionian',
      chordsByBar: [],
      sections: [],
      tempo: 93.4,
    })
    expect(settled).toBe('C major · ionian · 93 bpm')
    const open = analysisReadout({
      key: { root: 0, name: 'C', mode: 'major', label: 'C major', confidence: 0.42, alternative: 'A minor' },
      scale: 'ionian',
      chordsByBar: [{ bar: 0, startBeat: 0, beats: 4, symbol: 'C', root: 0, confidence: 0.5 }],
      sections: [],
      tempo: 93,
    })
    expect(open).toBe('C major · ionian · 93 bpm · 42% · or A minor')
  })

  it('prints the hedge on the analysis panel and keeps a settled label plain', () => {
    const project = createEmptyProject()
    const music = project.tracks.find((track) => track.name === 'Music')!
    const store = new ProjectStore(project)
    rememberTrackAnalysis(music.id, {
      key: { root: 9, name: 'A', mode: 'minor', label: 'A minor', confidence: 0.44, alternative: 'C major' },
      scale: 'aeolian',
      chordsByBar: [{ bar: 0, startBeat: 0, beats: 4, symbol: 'Am', root: 9, confidence: 0.8 }],
      sections: [],
      tempo: 93,
    })
    const html = renderToStaticMarkup(createElement(AnalysisSheet, { store, trackId: music.id, onClose: () => undefined }))
    expect(html).toContain('A minor · aeolian · 93 bpm · 44% · or C major')
    expect(html).toContain('Listen to')
  })
})

const LIBRARY = SOUND_DATASET_BASE

async function libraryWav(path: string) {
  const response = await fetch(`${LIBRARY}/${path}`)
  if (!response.ok) throw new Error(`library ${response.status} ${path}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return decodeWavPCM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function entry(id: string, bpm: number, key: string): SoundEntry {
  return {
    id,
    path: 'loops/melodic/x.wav',
    name: id,
    type: 'loop',
    tags: ['melodic', 'loop', 'piano', 'felt', 'chords'],
    bpm,
    key,
    durationSec: 12,
    sampleRate: 44100,
    license: 'Public Domain',
    source: 'library',
  }
}

/** The panel's "This track" scope: one lane, unmuted, through analyzeProject. */
function analyzeTrack(project: Project, trackName: string, bufferId: string, asset: { sampleRate: number; channels: Float32Array[] }) {
  const track = project.tracks.find((item) => item.name === trackName)!
  const isolated = { ...project, tracks: [{ ...track, mute: false }] }
  return analyzeProject(isolated, new Map([[bufferId, { sampleRate: asset.sampleRate, channels: asset.channels }]]))
}

describe('felt piano library loops', () => {
  it('reads the C-major felt loop as C major on the Music track at 93 BPM', async () => {
    const decoded = await libraryWav('loops/melodic/felt-piano-chords_c-maj_80bpm.wav')
    const project = createEmptyProject(48000)
    project.tempo = 93
    const placed = placeSound({
      entry: entry('felt-c', 80, 'F# minor'),
      channels: decoded.channels,
      fileRate: decoded.sampleRate,
      project,
      startSample: 0,
    })
    expect(placed).toBeTruthy()
    const music = project.tracks.find((track) => track.name === 'Music')!
    music.clips = [placed!.clip]
    const ratio = placed!.clip.durationSamples / (placed!.clip.stretch?.sourceSamples || 1)
    expect(ratio).toBeGreaterThan(0.85)
    expect(ratio).toBeLessThan(0.87)

    const result = analyzeTrack(project, 'Music', placed!.clip.bufferId, placed!.asset)
    expect(result.key.label).toBe('C major')
    expect(result.key.root).toBe(0)
    expect(result.scale).toBe('ionian')
    expect(result.key.alternative).toBeUndefined()
    expect(result.tempo).toBe(93)
    expect(result.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'Am', 'F', 'G7'])
    expect(result.sections.map((section) => `${section.kind} ${section.startBar + 1}-${section.endBar}`)).toEqual(['chorus 1-4', 'outro 5-5'])
    expect(analysisReadout(result)).toBe('C major · ionian · 93 bpm')

    const whole = analyzeAudio({
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      tempo: 80,
    })
    expect(whole.key.label).toBe('C major')
    expect(whole.scale).toBe('ionian')
    expect(whole.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'Am', 'F', 'G'])
    expect(whole.sections.map((section) => section.kind)).toEqual(['section'])
    expect(whole.tempo).toBe(80)
  }, 60000)

  it('keeps the A-minor felt loop minor, including the stretched Music-track path', async () => {
    const decoded = await libraryWav('loops/melodic/felt-piano-chords_a-min_70bpm.wav')
    const native = analyzeAudio({ sampleRate: decoded.sampleRate, channels: decoded.channels, tempo: 70 })
    expect(native.key.root).toBe(9)
    expect(native.scale).toBe('aeolian')
    expect(native.key.mode).toBe('minor')
    expect(native.key.alternative).toBeUndefined()
    expect(native.chordsByBar.map((chord) => chord.symbol)).toEqual(['Am7', 'Fmaj7', 'C', 'G'])

    const project = createEmptyProject(48000)
    project.tempo = 93
    const placed = placeSound({
      entry: entry('felt-am', 70, 'C major'),
      channels: decoded.channels,
      fileRate: decoded.sampleRate,
      project,
      startSample: 0,
    })
    const music = project.tracks.find((track) => track.name === 'Music')!
    music.clips = [placed!.clip]
    const result = analyzeTrack(project, 'Music', placed!.clip.bufferId, placed!.asset)
    expect(result.key.label).toBe('A minor')
    expect(result.scale).toBe('aeolian')
    expect(result.key.alternative).toBeUndefined()
    expect(result.tempo).toBe(93)
    expect(result.chordsByBar.map((chord) => chord.symbol)).toEqual(['Am7', 'Fmaj7', 'Fsus2', 'C'])
    expect(result.sections.map((section) => `${section.kind} ${section.startBar + 1}-${section.endBar}`)).toEqual(['chorus 1-4', 'outro 5-5'])
  }, 60000)
})

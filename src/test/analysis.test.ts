import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { magnitudeSpectrum } from '../analysis/fft'
import { analyzeAudio } from '../analysis/audio'
import { handleAnalysisMessage } from '../analysis/worker'
import { analyzeProject } from '../analysis/project'
import { transcribeHum } from '../analysis/pitch'
import { createEmptyProject, makeTrack, uid, type MidiNote, type Project } from '../model/types'

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

function chordBar(notes: number[], beats: number, tempo: number, sampleRate: number) {
  const samples = Math.round((beats * 60 * sampleRate) / tempo)
  const beat = (60 / tempo) * sampleRate
  const data = new Float32Array(samples)
  for (const note of notes) {
    const freq = midiHz(note)
    for (let h = 1; h <= 4; h++) {
      const f = freq * h
      if (f >= sampleRate * 0.45) break
      const amp = 0.2 / h
      for (let i = 0; i < samples; i++) {
        const pos = (i % beat) / beat
        const env = Math.min(1, pos / 0.015) * Math.exp(-pos * 1.3)
        data[i] += Math.sin((2 * Math.PI * f * i) / sampleRate) * amp * (0.4 + 0.6 * env)
      }
    }
  }
  return data
}

function clicks(bpm: number, beats: number, sampleRate: number) {
  const beat = (60 / bpm) * sampleRate
  const data = new Float32Array(Math.round(beat * beats))
  for (let hit = 0; hit < beats; hit++) {
    const at = Math.round(hit * beat)
    for (let i = 0; i < 180 && at + i < data.length; i++) {
      const env = Math.exp(-i / 28)
      data[at + i] += Math.sin((2 * Math.PI * 1400 * i) / sampleRate) * env * 0.9
    }
  }
  return data
}

function sung(note: number, seconds: number, sampleRate: number) {
  const n = Math.round(seconds * sampleRate)
  const freq = midiHz(note)
  const data = new Float32Array(n)
  const partials = [1, 0.32, 0.14, 0.06]
  for (let i = 0; i < n; i++) {
    const attack = Math.min(1, i / (0.012 * sampleRate))
    const release = Math.min(1, (n - i) / (0.02 * sampleRate))
    let sample = 0
    for (let h = 0; h < partials.length; h++) {
      const f = freq * (h + 1)
      if (f >= sampleRate * 0.45) break
      sample += Math.sin((2 * Math.PI * f * i) / sampleRate) * partials[h]
    }
    data[i] = sample * 0.45 * attack * release
  }
  return data
}

function note(pitch: number, startBeat: number, durationBeats: number, velocity: number): MidiNote {
  return { id: uid('note'), pitch, startBeat, durationBeats, velocity }
}

describe('analysis', () => {
  it('places an FFT peak on a pure sine', () => {
    const rate = 22050
    const n = 2048
    const data = new Float32Array(n)
    for (let i = 0; i < n; i++) data[i] = Math.sin((2 * Math.PI * 440 * i) / rate)
    const mag = magnitudeSpectrum(data, n)
    let peak = 1
    for (let i = 2; i < mag.length; i++) if (mag[i] > mag[peak]) peak = i
    expect(Math.abs(peak - (440 * n) / rate)).toBeLessThan(1.5)
  })

  it('reads key and chords from a MIDI progression', () => {
    const project = createEmptyProject()
    project.tempo = 96
    const track = project.tracks.find((item) => item.type === 'midi')
    expect(track).toBeTruthy()
    const bars = [
      [48, 60, 64, 67],
      [43, 55, 59, 62],
      [45, 57, 60, 64],
      [41, 53, 57, 60],
    ]
    track!.midiClips = [{
      id: uid('midi'),
      name: 'Chords',
      startBeat: 0,
      durationBeats: 16,
      notes: bars.flatMap((pitches, bar) => pitches.map((pitch) => note(pitch, bar * 4, 4, pitch < 52 ? 1 : 0.75))),
    }]
    const result = analyzeProject(project)
    expect(result.tempo).toBe(96)
    expect(result.key.root).toBe(0)
    expect(result.key.mode).toBe('major')
    expect(result.scale).toBe('ionian')
    expect(result.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'G', 'Am', 'F'])
    expect(result.sections.length).toBeGreaterThan(0)
    expect(result.sections[0].startBeat).toBe(0)
  })

  it('labels intro, chorus, and outro from the arrangement', () => {
    const project = createEmptyProject()
    project.tempo = 120
    const quiet = (start: number, bars: number) => {
      const notes: MidiNote[] = []
      for (let bar = 0; bar < bars; bar++) notes.push(note(36, start + bar * 4, 4, 0.2))
      return notes
    }
    const block = (pitches: number[], start: number, bars: number, velocity: number) => {
      const notes: MidiNote[] = []
      for (let bar = 0; bar < bars; bar++) {
        for (const pitch of pitches) notes.push(note(pitch, start + bar * 4, 4, velocity))
      }
      return notes
    }
    const clip = (name: string, notes: MidiNote[], beats: number) => ({
      id: uid('midi'),
      name,
      startBeat: 0,
      durationBeats: beats,
      notes,
    })
    project.tracks = [
      makeTrack({ name: 'Bass', type: 'midi', clips: [], midiClips: [clip('bass', [...quiet(0, 4), ...block([45], 16, 4, 0.25), ...block([36, 43], 32, 8, 0.9), ...quiet(64, 4)], 80)] }),
      makeTrack({ name: 'Verse', type: 'midi', clips: [], midiClips: [clip('verse', block([57, 60, 64], 16, 4, 0.55), 32)] }),
      makeTrack({ name: 'Chorus', type: 'midi', clips: [], midiClips: [clip('chorus', block([60, 64, 67, 72], 32, 8, 0.95), 64)] }),
    ]
    const result = analyzeProject(project)
    expect(result.sections[0].kind).toBe('intro')
    expect(result.sections.some((section) => section.kind === 'chorus' && section.startBar >= 6 && section.startBar <= 10)).toBe(true)
    expect(result.sections.at(-1)?.kind).toBe('outro')
    expect(result.sections.some((section) => section.kind === 'verse')).toBe(true)
    expect(result.key.label.length).toBeGreaterThan(0)
  })

  it('detects key, chords, and tempo from synthesized audio', () => {
    const rate = 16000
    const tempo = 120
    const audio = concat([
      chordBar([48, 60, 64, 67], 4, tempo, rate),
      chordBar([43, 55, 59, 62], 4, tempo, rate),
      chordBar([45, 57, 60, 64], 4, tempo, rate),
      chordBar([41, 53, 57, 60], 4, tempo, rate),
    ])
    const heard = analyzeAudio({ sampleRate: rate, channels: [audio], tempo })
    expect(heard.key.root).toBe(0)
    expect(heard.scale).toBe('ionian')
    expect(heard.chordsByBar.map((chord) => chord.symbol)).toEqual(['C', 'G', 'Am', 'F'])
    expect(heard.tempo).toBe(tempo)

    const clicksOnly = clicks(100, 16, rate)
    const paced = analyzeAudio({ sampleRate: rate, channels: [clicksOnly] })
    expect(paced.tempo).toBeGreaterThan(94)
    expect(paced.tempo).toBeLessThan(106)
  })

  it('transcribes a hummed melody into quantized MIDI notes', () => {
    const rate = 16000
    const melody = concat([
      sung(60, 0.45, rate),
      new Float32Array(Math.round(0.05 * rate)),
      sung(64, 0.45, rate),
      new Float32Array(Math.round(0.05 * rate)),
      sung(67, 0.45, rate),
      new Float32Array(Math.round(0.05 * rate)),
      sung(72, 0.45, rate),
    ])
    const notes = transcribeHum({ sampleRate: rate, channels: [melody], tempo: 120 }, { tempo: 120, grid: 0.5 })
    expect(notes.map((item) => item.pitch)).toEqual([60, 64, 67, 72])
    expect(notes.map((item) => item.startBeat)).toEqual([0, 1, 2, 3])
    expect(notes.every((item) => item.durationBeats >= 0.5 && item.durationBeats <= 1.5)).toBe(true)
    expect(notes.every((item) => item.velocity > 0 && item.velocity <= 1)).toBe(true)
  })

  it('runs audio analysis through the worker message handler', () => {
    const rate = 16000
    const audio = chordBar([48, 60, 64, 67], 4, 120, rate)
    const response = handleAnalysisMessage({
      id: 7,
      type: 'analyze',
      sampleRate: rate,
      channels: [audio],
      tempo: 120,
      numerator: 4,
      denominator: 4,
    })
    expect(response.id).toBe(7)
    expect(response.type).toBe('result')
    expect(response.analysis?.key.root).toBe(0)
    expect(response.analysis?.chordsByBar[0]?.symbol).toBe('C')
    const worker = readFileSync('src/analysis/worker.ts', 'utf8')
    const job = readFileSync('src/analysis/job.ts', 'utf8')
    expect(worker).toContain('handleAnalysisMessage')
    expect(job).toContain('new Worker')
    expect(worker).not.toContain('onnxruntime')
    expect(worker).not.toContain('huggingface')
  })

  it('reads an imported audio clip on the arrangement', () => {
    const rate = 16000
    const project = createEmptyProject(rate)
    project.tempo = 120
    const audio = chordBar([48, 60, 64, 67], 4, 120, rate)
    const track = project.tracks.find((item) => item.type === 'audio')
    expect(track).toBeTruthy()
    track!.clips = [{
      id: 'clip',
      name: 'Import',
      bufferId: 'buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: audio.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
    }]
    const result = analyzeProject(project, new Map([['buf', { sampleRate: rate, channels: [audio] }]]))
    expect(result.key.root).toBe(0)
    expect(result.key.mode).toBe('major')
    expect(result.chordsByBar[0]?.symbol).toBe('C')
    expect(result.tempo).toBe(120)
  })

  it('keeps a minor loop in A minor', () => {
    const project: Project = createEmptyProject()
    const track = project.tracks.find((item) => item.type === 'midi')!
    const bars = [
      [45, 57, 60, 64],
      [41, 53, 57, 60],
      [40, 52, 55, 59],
      [45, 57, 60, 64],
    ]
    track.midiClips = [{
      id: uid('midi'),
      name: 'Minor',
      startBeat: 0,
      durationBeats: 16,
      notes: bars.flatMap((pitches, bar) => pitches.map((pitch) => note(pitch, bar * 4, 4, pitch < 52 ? 1 : 0.7))),
    }]
    const result = analyzeProject(project)
    expect(result.key.root).toBe(9)
    expect(result.scale).toBe('aeolian')
    expect(result.chordsByBar.map((chord) => chord.symbol)).toEqual(['Am', 'F', 'Em', 'Am'])
  })
})

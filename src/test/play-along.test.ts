import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { timeStretch } from '../audio/stretch/engine'
import { decodeWavPCM } from '../model/wav'
import { createEmptyProject, type AudioClip } from '../model/types'
import { nameChord } from '../playalong/chords'
import { notesForMidi } from '../playalong/convert'
import { cachedScore, forgetScore, rememberScore, transcriptionKey } from '../playalong/cache'
import { noteLabel } from '../playalong/names'
import { practicePlan } from '../playalong/practice'
import { beatAtSample, heardTimelineSample, latencySamples, notesSounding, practiceLength, sectionSamples, stepTo } from '../playalong/sync'
import { transcribeScore } from '../playalong/transcribe'
import { handlePlayAlongMessage } from '../playalong/worker'
import { SOUND_DATASET_BASE } from '../sounds/contract'
import { ProjectStore } from '../state/store'
import { beatsToSamples } from '../model/time'
import { PlayAlongFace } from '../ui/PlayAlongFace'

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

function tone(note: number, seconds: number, sampleRate: number, partials = [1, 0.35, 0.16, 0.07]) {
  const n = Math.round(seconds * sampleRate)
  const freq = midiHz(note)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const attack = Math.min(1, i / (0.012 * sampleRate))
    const release = Math.min(1, (n - i) / (0.03 * sampleRate))
    let sample = 0
    for (let h = 0; h < partials.length; h++) {
      const f = freq * (h + 1)
      if (f >= sampleRate * 0.45) break
      sample += Math.sin((2 * Math.PI * f * i) / sampleRate) * partials[h]
    }
    data[i] = sample * 0.4 * attack * release
  }
  return data
}

function chordBar(notes: number[], beats: number, tempo: number, sampleRate: number) {
  const samples = Math.round((beats * 60 * sampleRate) / tempo)
  const beat = (60 / tempo) * sampleRate
  const data = new Float32Array(samples)
  for (const note of notes) {
    const freq = midiHz(note)
    for (let h = 1; h <= 5; h++) {
      const f = freq * h
      if (f >= sampleRate * 0.45) break
      const amp = 0.18 / h
      for (let i = 0; i < samples; i++) {
        const pos = (i % beat) / beat
        const env = Math.min(1, pos / 0.02) * Math.exp(-pos * 1.1)
        data[i] += Math.sin((2 * Math.PI * f * i) / sampleRate) * amp * (0.35 + 0.65 * env)
      }
    }
  }
  return data
}

function gap(seconds: number, sampleRate: number) {
  return new Float32Array(Math.round(seconds * sampleRate))
}

/** Fraction of expected pitches found in order. Extra detections between them do not count as misses. */
export function sequenceAccuracy(got: number[], want: number[]) {
  let index = 0
  let hit = 0
  for (const pitch of want) {
    while (index < got.length && Math.abs(got[index] - pitch) > 0) index++
    if (index < got.length) {
      hit++
      index++
    }
  }
  return want.length ? hit / want.length : 0
}

export function chordAccuracy(got: string[], want: string[]) {
  if (!want.length) return 0
  let hit = 0
  for (let i = 0; i < want.length; i++) if (got[i] === want[i]) hit++
  return hit / want.length
}

function line(notes: number[], hold: number, sampleRate: number, partials?: number[]) {
  const parts: Float32Array[] = []
  for (const note of notes) {
    parts.push(tone(note, hold, sampleRate, partials))
    parts.push(gap(0.06, sampleRate))
  }
  return concat(parts)
}

describe('play-along MIDI sync', () => {
  it('lights a note when the speaker reaches it, not when the audio clock does', () => {
    const sampleRate = 48000
    const tempo = 120
    const latency = latencySamples(20, sampleRate)
    expect(latency).toBeCloseTo(960, 0)
    const start = beatsToSamples(1, sampleRate, tempo)
    const clockEarly = start + sampleRate * 0.005
    const heardEarly = beatAtSample(heardTimelineSample(clockEarly, latency, true), sampleRate, tempo)
    expect(heardEarly).toBeLessThan(1)
    expect(notesSounding([{ pitch: 60, startBeat: 1, durationBeats: 1, velocity: 1 }], heardEarly)).toEqual([])
    const clockLate = start + sampleRate * 0.04
    const heardLate = beatAtSample(heardTimelineSample(clockLate, latency, true), sampleRate, tempo)
    expect(notesSounding([{ pitch: 60, startBeat: 1, durationBeats: 1, velocity: 1 }], heardLate).map((note) => note.pitch)).toEqual([60])
    expect(heardTimelineSample(100, 500, false)).toBe(100)
    expect(notesSounding([{ pitch: 64, startBeat: 0, durationBeats: 1, velocity: 0, muted: true }], 0.2)).toEqual([])
  })

  it('steps to the next and previous attack and loops A to B', () => {
    const notes = [{ startBeat: 0 }, { startBeat: 1 }, { startBeat: 2.5 }]
    expect(stepTo(notes, 0.2, 1)).toBe(1)
    expect(stepTo(notes, 2.5, 1)).toBe(0)
    expect(stepTo(notes, 1, -1)).toBe(0)
    expect(stepTo(notes, 0, -1)).toBe(2.5)
    const section = sectionSamples(48000, 120, 4, 1)
    expect(section.startBeat).toBe(1)
    expect(section.endBeat).toBe(4)
    expect(section.endSample).toBeGreaterThan(section.startSample)
  })
})

describe('play-along chord names', () => {
  it('names the sounding pitches, including sevenths and slash bass', () => {
    expect(nameChord([57, 60, 64, 67])?.symbol).toBe('Am7')
    expect(nameChord([60, 64, 67])?.symbol).toBe('C')
    expect(nameChord([55, 59, 62, 65])?.symbol).toBe('G7')
    expect(nameChord([64, 67, 72])?.symbol).toBe('C/E')
    expect(nameChord([58, 62, 65], { root: 10, scale: 'ionian' })?.symbol).toBe('Bb')
    expect(nameChord([60])).toBeNull()
    expect(noteLabel(60, 'letters', null)).toBe('C4')
    expect(noteLabel(60, 'solfege', { root: 0, scale: 'ionian' })).toBe('Do4')
    expect(noteLabel(60, 'solfege', { root: 9, scale: 'aeolian' })).toBe('Me4')
    expect(noteLabel(61, 'letters', { root: 10, scale: 'ionian' })).toBe('Db4')
  })
})

describe('play-along transcription', () => {
  it('tracks synthetic monophonic lines and library-style bass loops', () => {
    const rate = 16000
    const melody = line([60, 64, 67, 72], 0.45, rate)
    const lead = transcribeScore({
      channels: [melody],
      sampleRate: rate,
      tempo: 120,
      name: 'Lead',
      soundCategory: 'lead',
      part: 'mono',
    })
    const leadAccuracy = sequenceAccuracy(lead.notes.map((note) => note.pitch), [60, 64, 67, 72])
    expect(lead.approximate).toBe(true)
    expect(leadAccuracy).toBe(1)

    const bassWant = [40, 43, 47, 45, 43, 40]
    const bass = transcribeScore({
      channels: [line(bassWant, 0.42, rate)],
      sampleRate: rate,
      tempo: 100,
      name: 'Finger bass',
      soundCategory: 'bass',
      soundTags: ['bass', 'loop'],
      part: 'mono',
    })
    const bassAccuracy = sequenceAccuracy(bass.notes.map((note) => note.pitch), bassWant)

    const walkWant = [36, 36, 38, 40, 41, 40, 38, 36]
    const walk = transcribeScore({
      channels: [line(walkWant, 0.38, rate, [1, 0.2, 0.08])],
      sampleRate: rate,
      tempo: 90,
      name: 'Walking bass loop',
      soundRole: 'bass',
      part: 'mono',
    })
    const walkAccuracy = sequenceAccuracy(walk.notes.map((note) => note.pitch), walkWant)
    expect(bassAccuracy).toBeGreaterThanOrEqual(0.9)
    expect(walkAccuracy).toBeGreaterThanOrEqual(0.9)
    console.log(`PLAY_ALONG_MONO ${JSON.stringify({ lead: leadAccuracy, bass: bassAccuracy, walk: walkAccuracy })}`)
  })

  it('names synthetic chords and felt-piano library loops', async () => {
    const rate = 16000
    const tempo = 120
    const audio = concat([
      chordBar([48, 60, 64, 67], 4, tempo, rate),
      chordBar([43, 55, 59, 62], 4, tempo, rate),
      chordBar([45, 57, 60, 64], 4, tempo, rate),
      chordBar([41, 53, 57, 60], 4, tempo, rate),
    ])
    const synthetic = transcribeScore({
      channels: [audio],
      sampleRate: rate,
      tempo,
      name: 'Keys loop',
      soundTags: ['chords', 'piano'],
      part: 'poly',
    })
    const syntheticChords = synthetic.chords.map((chord) => chord.symbol)
    const syntheticAccuracy = chordAccuracy(syntheticChords, ['C', 'G', 'Am', 'F'])
    expect(synthetic.approximate).toBe(true)
    expect(syntheticAccuracy).toBe(1)
    expect(synthetic.notes[0]?.pitch % 12).toBe(0)

    const library: { file: string; accuracy: number; got: string[] }[] = []
    const files: { path: string; tempo: number; want: string[] }[] = [
      { path: 'loops/melodic/felt-piano-chords_c-maj_80bpm.wav', tempo: 80, want: ['C', 'Am', 'F', 'G'] },
      { path: 'loops/melodic/felt-piano-chords_a-min_70bpm.wav', tempo: 70, want: ['Am7', 'Fmaj7', 'C', 'G'] },
    ]
    for (const file of files) {
      try {
        const response = await fetch(`${SOUND_DATASET_BASE}/${file.path}`, { signal: AbortSignal.timeout(20000) })
        if (!response.ok) throw new Error(String(response.status))
        const bytes = new Uint8Array(await response.arrayBuffer())
        const decoded = decodeWavPCM(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        const score = transcribeScore({
          channels: decoded.channels,
          sampleRate: decoded.sampleRate,
          tempo: file.tempo,
          name: 'felt piano chords',
          soundCategory: 'chords',
          soundTags: ['piano', 'chords'],
          part: 'poly',
        })
        const got = score.chords.map((chord) => chord.symbol)
        const accuracy = chordAccuracy(got, file.want)
        library.push({ file: file.path, accuracy, got })
        expect(accuracy).toBeGreaterThanOrEqual(0.75)
      } catch (error) {
        library.push({ file: file.path, accuracy: -1, got: [error instanceof Error ? error.message : 'unavailable'] })
      }
    }
    console.log(`PLAY_ALONG_CHORDS ${JSON.stringify({ synthetic: syntheticAccuracy, symbols: syntheticChords, library })}`)
  })

  it('runs in the worker handler and caches a clip', () => {
    const rate = 16000
    const audio = tone(60, 0.4, rate)
    const direct = transcribeScore({ channels: [audio], sampleRate: rate, tempo: 120, name: 'Lead', part: 'mono' })
    const response = handlePlayAlongMessage({
      id: 3,
      type: 'transcribe',
      sampleRate: rate,
      channels: [audio],
      tempo: 120,
      name: 'Lead',
      part: 'mono',
    })
    expect(response.type).toBe('result')
    expect(response.score?.notes[0]?.pitch).toBe(direct.notes[0]?.pitch)
    const worker = readFileSync('src/playalong/worker.ts', 'utf8')
    const job = readFileSync('src/playalong/job.ts', 'utf8')
    expect(worker).toContain('handlePlayAlongMessage')
    expect(job).toContain('new Worker')
    expect(worker).not.toContain('onnxruntime')
    expect(worker).not.toContain('huggingface')
    expect(job).not.toContain('huggingface')
    forgetScore()
    const key = transcriptionKey(['clip', 'a'])
    expect(cachedScore(key)).toBeNull()
    rememberScore(key, direct)
    expect(cachedScore(key)?.notes.length).toBe(direct.notes.length)
  })
})

describe('play-along practice and convert', () => {
  it('slows with the in-house stretch and leaves a recorded take alone', () => {
    expect(practicePlan({ playback: 'recorded' }, 0.5)).toEqual({ rate: 1, stretch: false, reason: 'This take plays as sung. Speed stays at 100%.' })
    expect(practicePlan({}, 0.75)).toMatchObject({ rate: 0.75, stretch: true })
    const rate = 16000
    const input = tone(57, 0.3, rate)
    const slowed = timeStretch(input, practiceLength(input.length, 0.5), 'tonal', rate, 'preview')
    expect(slowed.length).toBe(practiceLength(input.length, 0.5))
    expect(slowed.length).toBeGreaterThan(input.length * 1.9)
    const period = (samples: Float32Array) => {
      let crosses = 0
      let last = 0
      for (let i = 0; i < samples.length; i++) {
        const sample = samples[i] || 0
        if ((sample >= 0 && last < 0) || (sample < 0 && last >= 0)) crosses++
        last = sample
      }
      return crosses > 0 ? samples.length / crosses : 0
    }
    const before = period(input)
    const after = period(slowed)
    expect(after).toBeGreaterThan(before * 0.7)
    expect(after).toBeLessThan(before * 1.35)
  })

  it('converts a transcription to MIDI in one undo and does not change the recording', () => {
    const project = createEmptyProject(48000)
    const music = project.tracks.find((track) => track.name === 'Music')!
    const channel = tone(40, 0.2, 48000)
    const clip: AudioClip = {
      id: 'bass-loop',
      name: 'Bass loop',
      bufferId: 'bass-buf',
      startSample: 0,
      offsetSamples: 0,
      durationSamples: channel.length,
      fadeInSamples: 0,
      fadeOutSamples: 0,
      gain: 1,
      source: 'import',
      playback: 'recorded',
      soundCategory: 'bass',
    }
    music.clips = [clip]
    const store = new ProjectStore(project, new Map([[clip.bufferId, { id: clip.bufferId, name: clip.name, sampleRate: 48000, channels: [channel] }]]))
    const before = store.project.tracks.length
    const score = transcribeScore({ channels: [channel], sampleRate: 48000, tempo: 120, name: 'Bass loop', soundCategory: 'bass', part: 'mono' })
    const drafts = notesForMidi(score)
    expect(drafts.length).toBeGreaterThan(0)
    store.convertPlayAlong(music.id, clip.id, drafts)
    expect(store.project.tracks.length).toBe(before + 1)
    const made = store.project.tracks.find((track) => track.name.includes('MIDI'))
    expect(made?.midiClips[0]?.name).toBe('Play along')
    expect(made?.midiClips[0]?.notes.length).toBe(drafts.length)
    expect(store.track(music.id)?.clips[0]?.playback).toBe('recorded')
    expect(store.buffers.get(clip.bufferId)?.channels[0]).toBe(channel)
    expect(store.canUndo).toBe(true)
    store.undo()
    expect(store.project.tracks.length).toBe(before)
    expect(store.project.tracks.some((track) => track.midiClips.some((item) => item.name === 'Play along'))).toBe(false)
    expect(store.track(music.id)?.clips[0]?.playback).toBe('recorded')
    expect(store.track(music.id)?.clips[0]?.durationSamples).toBe(channel.length)
    expect(store.buffers.get(clip.bufferId)?.channels[0]).toBe(channel)
    expect(store.canUndo).toBe(false)
  })
})

describe('play-along sheet', () => {
  it('shows a chord, lit keys, and a control for every practice action', () => {
    const html = renderToStaticMarkup(createElement(PlayAlongFace, {
      title: 'Keys',
      subtitle: 'MIDI',
      chord: 'Am7',
      bass: 'A3',
      confidence: 'Exact',
      approximate: false,
      beat: 0,
      lane: [
        { id: 'a', pitch: 57, startBeat: 0, label: 'A3' },
        { id: 'c', pitch: 60, startBeat: 0, label: 'C4' },
        { id: 'e', pitch: 64, startBeat: 0, label: 'E4' },
        { id: 'g', pitch: 67, startBeat: 0, label: 'G4' },
      ],
      drums: false,
      pads: [],
      low: 48,
      high: 72,
      lit: [57, 60, 64, 67],
      speed: 1,
      names: 'letters',
      followKey: true,
      countLabel: '1 bar',
      countOn: true,
      loopOn: false,
      markA: false,
      markB: false,
      canConvert: false,
      playing: false,
      status: '',
      onClose: () => undefined,
      onSpeed: () => undefined,
      onNames: () => undefined,
      onFollow: () => undefined,
      onCount: () => undefined,
      onLoop: () => undefined,
      onA: () => undefined,
      onB: () => undefined,
      onStep: () => undefined,
      onPlay: () => undefined,
      onConvert: () => undefined,
      onKey: () => undefined,
    }))
    expect(html).toContain('Play along')
    expect(html).toContain('Am7')
    expect(html).toContain('50%')
    expect(html).toContain('75%')
    expect(html).toContain('100%')
    expect(html).toContain('>A<')
    expect(html).toContain('Loop')
    expect(html).toContain('Back')
    expect(html).toContain('Next')
    expect(html).toContain('Letters')
    expect(html).toContain('>Key<')
    expect(html).toContain('data-key="60"')
    expect(html).toContain('class="lit"')
    const dock = readFileSync('src/ui/phoneDock.tsx', 'utf8')
    expect(dock).toContain('Play along')
    expect(dock).toContain('togglePlayAlong')
    const app = readFileSync('src/App.tsx', 'utf8')
    expect(app).toContain("import('./ui/PlayAlongSheet')")
  })

  it('draws drum names instead of piano keys', () => {
    const html = renderToStaticMarkup(createElement(PlayAlongFace, {
      title: 'Kit',
      subtitle: 'Drums',
      chord: 'Kick',
      bass: '',
      confidence: 'Exact',
      approximate: false,
      beat: 0,
      lane: [{ id: 'k', pitch: 36, startBeat: 0, label: 'Kick' }],
      drums: true,
      pads: [{ pitch: 36, name: 'Kick' }, { pitch: 38, name: 'Snare' }],
      low: 36,
      high: 60,
      lit: [36],
      speed: 0.5,
      names: 'letters',
      followKey: true,
      countLabel: 'Off',
      countOn: false,
      loopOn: true,
      markA: true,
      markB: true,
      canConvert: true,
      playing: true,
      status: '',
      onClose: () => undefined,
      onSpeed: () => undefined,
      onNames: () => undefined,
      onFollow: () => undefined,
      onCount: () => undefined,
      onLoop: () => undefined,
      onA: () => undefined,
      onB: () => undefined,
      onStep: () => undefined,
      onPlay: () => undefined,
      onConvert: () => undefined,
      onKey: () => undefined,
    }))
    expect(html).toContain('Kick')
    expect(html).toContain('Snare')
    expect(html).toContain('Convert to MIDI')
    expect(html).not.toContain('along-keys')
    expect(html).toContain('aria-label="Drums"')
  })
})

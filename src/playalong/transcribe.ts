/**
 * Audio to a play-along score.
 * One line uses the in-house pYIN tracker. Chords use chroma templates.
 * Drums use onsets. Nothing here is a third-party pitch library.
 */

import { foldChroma, spectralFrames, tuningShift } from '../analysis/chroma'
import { accumulateBar, blankBars, chordFromChroma, histogramFromFrames, keyFromHistogram } from '../analysis/harmony'
import { monoMix } from '../analysis/mix'
import { transcribeHum } from '../analysis/pitch'
import type { ScaleId } from '../model/scale'
import { clipText, partFromDensity, partFromLabel, type AudioPart } from './classify'
import { nameChord } from './chords'
import type { PlayChord, PlayNote, PlayScore } from './types'

const INTERVALS: Record<string, number[]> = {
  maj7: [0, 4, 7, 11],
  '7': [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  m7b5: [0, 3, 6, 10],
  dim7: [0, 3, 6, 9],
  mMaj7: [0, 3, 7, 11],
  aug: [0, 4, 8],
  dim: [0, 3, 6],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  maj: [0, 4, 7],
  min: [0, 3, 7],
}

export interface TranscribeInput {
  channels: ArrayLike<number> | ArrayLike<number>[]
  sampleRate: number
  /** Tempo that maps this buffer onto the clip's timeline beats. */
  tempo: number
  beats?: number
  numerator?: number
  denominator?: number
  /** Song key, used only to nudge a near chord tie. */
  key?: { root: number; scale: string } | null
  name?: string
  soundCategory?: string
  soundRole?: string
  soundType?: string
  soundTags?: string[]
  /** Force a part. Auto reads the name, then the pitch-class spread. */
  part?: AudioPart | 'auto'
}

function mean(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function hzFor(text: string) {
  if (/\bbass\b/.test(text)) return { minHz: 32, maxHz: 500 }
  if (/\b(vocal|vox|lead|melody|flute|sax)\b/.test(text)) return { minHz: 75, maxHz: 1100 }
  return { minHz: 65, maxHz: 950 }
}

function collapse(notes: PlayNote[]) {
  const out: PlayNote[] = []
  for (const note of notes) {
    const prev = out[out.length - 1]
    // A real rest stays two notes. Only a tracker split of one held note is joined.
    if (prev && prev.pitch === note.pitch && note.startBeat <= prev.startBeat + prev.durationBeats + 0.03) {
      const end = note.startBeat + note.durationBeats
      prev.durationBeats = Math.max(prev.durationBeats, end - prev.startBeat)
      prev.confidence = Math.max(prev.confidence, note.confidence)
      prev.velocity = Math.max(prev.velocity, note.velocity)
      continue
    }
    // A slide or a vibrato wobble shows up as a very short neighbor into the landing pitch.
    if (
      prev
      && Math.abs(prev.pitch - note.pitch) === 1
      && prev.durationBeats < 0.22
      && note.startBeat <= prev.startBeat + prev.durationBeats + 0.05
    ) {
      const end = note.startBeat + note.durationBeats
      prev.pitch = note.pitch
      prev.durationBeats = Math.max(prev.durationBeats, end - prev.startBeat)
      prev.confidence = Math.min(prev.confidence, note.confidence)
      prev.velocity = Math.max(prev.velocity, note.velocity)
      continue
    }
    out.push({ ...note })
  }
  return out
}

function strongClasses(chroma: Float32Array) {
  let max = 0
  for (let i = 0; i < 12; i++) if (chroma[i] > max) max = chroma[i]
  if (max <= 1e-6) return 0
  let count = 0
  for (let i = 0; i < 12; i++) if (chroma[i] >= max * 0.22) count++
  return count
}

function bassOf(bass: Float32Array) {
  let best = -1
  let energy = 0
  let total = 0
  for (let i = 0; i < 12; i++) {
    total += bass[i]
    if (bass[i] > energy) {
      energy = bass[i]
      best = i
    }
  }
  if (best < 0 || energy <= 0 || energy < total * 0.18) return null
  return 36 + best
}

function tonesOf(root: number, id: string, bass: number | null) {
  const intervals = INTERVALS[id] ?? [0, 4, 7]
  const base = 48 + ((root % 12) + 12) % 12
  const tones = intervals.map((interval) => base + interval)
  if (bass != null && !tones.some((tone) => ((tone % 12) + 12) % 12 === bass % 12)) tones.unshift(bass)
  return tones
}

function familyOf(id: string) {
  if (id === 'maj' || id === 'maj7' || id === '7' || id === '6') return 'maj'
  if (id === 'min' || id === 'm7' || id === 'mMaj7' || id === 'm6') return 'min'
  return id
}

function polyScore(mixed: Float32Array, sampleRate: number, tempo: number, beats: number, key: { root: number; scale: ScaleId } | null, numerator: number, denominator: number): { chords: PlayChord[]; notes: PlayNote[]; density: number[] } {
  const frames = spectralFrames(mixed, sampleRate)
  if (!frames.length) return { chords: [], notes: [], density: [] }
  const shift = tuningShift(frames)
  const seconds = mixed.length / sampleRate
  const beatSeconds = 60 / Math.max(1, tempo)
  const beatCount = Math.max(1, Math.round(Math.min(beats, seconds / beatSeconds)))
  const beatsPerBar = Math.max(1, Math.round(numerator * (4 / Math.max(1, denominator))))
  const barsForKey = blankBars(Math.max(1, Math.ceil(beatCount / beatsPerBar)))
  const beatsChroma = blankBars(beatCount)
  const density: number[] = []
  let frameClasses = 0
  let frameCount = 0
  for (const frame of frames) {
    const chroma = foldChroma(frame.fine, shift)
    const beatIndex = Math.min(beatCount - 1, Math.max(0, Math.floor(frame.time / beatSeconds)))
    accumulateBar(beatsChroma[beatIndex], chroma, frame.bass, frame.rms, frame.flux)
    const barIndex = Math.min(barsForKey.length - 1, Math.floor(beatIndex / beatsPerBar))
    accumulateBar(barsForKey[barIndex], chroma, frame.bass, frame.rms, frame.flux)
    if (frame.rms > 1e-4) {
      frameClasses += strongClasses(chroma)
      frameCount++
    }
  }
  if (frameCount) density.push(frameClasses / frameCount)
  const fitted = key ?? (() => {
    const heard = keyFromHistogram(histogramFromFrames(frames, shift, foldChroma), barsForKey)
    return { root: heard.root, scale: heard.scale }
  })()
  const barFit = barsForKey.map((bar) => (bar.energy > 1e-5 ? chordFromChroma(bar.chroma, bar.bass, fitted) : null))
  interface BeatChord extends PlayChord { id: string; classes: number }
  const raw: BeatChord[] = []
  beatsChroma.forEach((bar, index) => {
    const covered = index === beatCount - 1 ? Math.min(1, seconds / beatSeconds - index) : 1
    if (covered < 0.45 || bar.energy <= 1e-5) return
    const fit = chordFromChroma(bar.chroma, bar.bass, fitted)
    if (!fit) return
    const classes = strongClasses(bar.chroma)
    // Two tones do not identify a seventh or a sus. Say so in the confidence.
    let confidence = Math.max(0, Math.min(1, fit.score))
    if (classes < 3) confidence = Math.min(confidence, 0.55)
    const bass = bassOf(bar.bass)
    raw.push({
      symbol: fit.symbol,
      root: fit.root,
      bass,
      startBeat: index,
      durationBeats: 1,
      confidence,
      tones: tonesOf(fit.root, fit.id, bass),
      id: fit.id,
      classes,
    })
  })
  // A one-beat name sandwiched between the same chord is a flicker, not a new change.
  for (let index = 1; index < raw.length - 1; index++) {
    const prev = raw[index - 1]
    const beat = raw[index]
    const next = raw[index + 1]
    if (beat.durationBeats > 1 || prev.symbol !== next.symbol || beat.symbol === prev.symbol) continue
    if (beat.startBeat !== prev.startBeat + prev.durationBeats || next.startBeat !== beat.startBeat + beat.durationBeats) continue
    raw[index] = { ...prev, startBeat: beat.startBeat, durationBeats: beat.durationBeats }
  }
  const groups: BeatChord[][] = []
  for (const beat of raw) {
    const group = groups[groups.length - 1]
    const head = group?.[0]
    const tail = group?.[group.length - 1]
    if (
      group
      && head
      && tail
      && familyOf(head.id) === familyOf(beat.id)
      && head.root === beat.root
      && beat.startBeat <= tail.startBeat + tail.durationBeats + 0.01
    ) {
      group.push(beat)
    } else groups.push([beat])
  }
  const chords: PlayChord[] = []
  const notes: PlayNote[] = []
  for (const group of groups) {
    const tally = new Map<string, { n: number; beat: BeatChord }>()
    let confidence = 1
    for (const beat of group) {
      const key = `${beat.symbol}|${beat.id}`
      const have = tally.get(key) ?? { n: 0, beat }
      have.n += 1
      tally.set(key, have)
      confidence = Math.min(confidence, beat.confidence)
    }
    let chosen = group[0]
    let bestCount = -1
    for (const item of tally.values()) {
      const tieSimpler = item.n === bestCount && item.beat.id.length < chosen.id.length
      if (item.n > bestCount || tieSimpler) {
        bestCount = item.n
        chosen = item.beat
      }
    }
    const startBeat = group[0].startBeat
    const durationBeats = group[group.length - 1].startBeat + group[group.length - 1].durationBeats - startBeat
    const barIndex = Math.floor(startBeat / beatsPerBar)
    const bar = barFit[barIndex]
    const coversBar = startBeat <= barIndex * beatsPerBar + 0.01 && startBeat + durationBeats >= (barIndex + 1) * beatsPerBar - 0.01
    if (bar && coversBar && bar.root === chosen.root && familyOf(bar.id) === familyOf(chosen.id)) {
      chosen = {
        ...chosen,
        symbol: bar.symbol,
        tones: tonesOf(bar.root, bar.id, chosen.bass),
        id: bar.id,
      }
    }
    chords.push({
      symbol: chosen.symbol,
      root: chosen.root,
      bass: chosen.bass,
      startBeat,
      durationBeats,
      confidence,
      tones: chosen.tones,
    })
    if (chosen.bass != null) {
      notes.push({
        pitch: chosen.bass,
        startBeat,
        durationBeats,
        velocity: 0.8,
        confidence,
      })
    }
  }
  return { chords, notes, density }
}

function drumNotes(samples: Float32Array, sampleRate: number, tempo: number): PlayNote[] {
  const hop = Math.max(1, Math.round(sampleRate * 0.008))
  const win = Math.max(hop * 2, Math.round(sampleRate * 0.018))
  const hits: PlayNote[] = []
  let prev = 0
  let before = 0
  for (let start = 0; start + win < samples.length; start += hop) {
    let energy = 0
    let last = 0
    let crosses = 0
    for (let i = 0; i < win; i++) {
      const sample = samples[start + i] || 0
      energy += sample * sample
      if ((sample >= 0 && last < 0) || (sample < 0 && last >= 0)) crosses++
      last = sample
    }
    const rms = Math.sqrt(energy / win)
    const onset = rms > 0.03 && rms > prev * 1.65 && prev <= before * 1.35
    if (onset) {
      const hz = (crosses * sampleRate) / (2 * Math.max(1, win))
      let pitch = 38
      let drum = 'Snare'
      if (hz < 200) {
        pitch = 36
        drum = 'Kick'
      } else if (hz > 2200) {
        pitch = 42
        drum = 'Hat'
      }
      const startBeat = (start / sampleRate) * tempo / 60
      const prior = hits[hits.length - 1]
      if (!prior || startBeat - prior.startBeat > 0.07) {
        hits.push({
          pitch,
          startBeat,
          durationBeats: 0.18,
          velocity: Math.max(0.2, Math.min(1, rms * 3.2)),
          confidence: Math.max(0.35, Math.min(0.85, rms * 2.4)),
          drum,
        })
      }
    }
    before = prev
    prev = rms
  }
  return hits
}

/** Turn one audio buffer into notes and chords. The result is marked approximate. */
export function transcribeScore(input: TranscribeInput): PlayScore {
  const mixed = monoMix(input.channels)
  const sampleRate = input.sampleRate > 0 ? input.sampleRate : 48000
  const tempo = input.tempo > 20 ? input.tempo : 120
  const seconds = mixed.length / sampleRate
  const beats = input.beats && input.beats > 0 ? input.beats : (seconds * tempo) / 60
  const text = clipText(input)
  const empty: PlayScore = { kind: 'mono', approximate: true, confidence: 0, notes: [], chords: [], durationBeats: beats }
  if (mixed.length < 64) return empty
  const labeled = input.part && input.part !== 'auto' ? input.part : partFromLabel(text)
  const key = input.key && Number.isFinite(input.key.root) ? { root: ((input.key.root % 12) + 12) % 12, scale: input.key.scale as ScaleId } : null
  if (labeled === 'drums') {
    const notes = drumNotes(mixed, sampleRate, tempo)
    return { kind: 'drums', approximate: true, confidence: mean(notes.map((note) => note.confidence)), notes, chords: [], durationBeats: beats }
  }
  const preview = labeled ? null : polyScore(mixed, sampleRate, tempo, beats, key, input.numerator ?? 4, input.denominator ?? 4)
  const kind: AudioPart = labeled ?? partFromDensity(preview?.density ?? [])
  if (kind === 'poly') {
    const poly = preview ?? polyScore(mixed, sampleRate, tempo, beats, key, input.numerator ?? 4, input.denominator ?? 4)
    return {
      kind: 'poly',
      approximate: true,
      confidence: mean(poly.chords.map((chord) => chord.confidence)),
      notes: poly.notes,
      chords: poly.chords,
      durationBeats: beats,
    }
  }
  const range = hzFor(text)
  const raw = transcribeHum(
    { sampleRate, channels: [mixed], tempo },
    { tempo, grid: 0, minHz: range.minHz, maxHz: range.maxHz },
  )
  const notes = collapse(raw.map((note) => ({
    pitch: note.pitch,
    startBeat: note.startBeat,
    durationBeats: Math.max(0.08, note.durationBeats),
    velocity: note.velocity,
    confidence: note.confidence,
  })))
  const chords: PlayChord[] = []
  for (const note of notes) {
    const sounding = notes.filter((other) => other.startBeat < note.startBeat + note.durationBeats && note.startBeat < other.startBeat + other.durationBeats)
    const named = nameChord(sounding.map((other) => other.pitch), key)
    if (!named) continue
    const last = chords[chords.length - 1]
    if (last && last.symbol === named.symbol && note.startBeat <= last.startBeat + last.durationBeats + 0.05) {
      last.durationBeats = Math.max(last.durationBeats, note.startBeat + note.durationBeats - last.startBeat)
      continue
    }
    chords.push({
      symbol: named.symbol,
      root: named.root,
      bass: named.bass,
      startBeat: note.startBeat,
      durationBeats: note.durationBeats,
      confidence: mean(sounding.map((other) => other.confidence)),
      tones: named.tones,
    })
  }
  return {
    kind: 'mono',
    approximate: true,
    confidence: mean(notes.map((note) => note.confidence)),
    notes,
    chords,
    durationBeats: beats,
  }
}

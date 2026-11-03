import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { notesFromSlots } from '../instruments/scaler/clips'
import { audioChordSymbols, chordsFromMidi, pitchesFromAudio } from '../instruments/scaler/listen'
import { playScalerLive } from '../instruments/scaler/live'
import { padPerformance } from '../instruments/scaler/model'
import {
  applyExpression,
  applyKeysLock,
  humanizeNotes,
  moveItem,
  patternCatalog,
  performanceCatalog,
  renderPerformance,
} from '../instruments/scaler/perform'
import { defaultScaler } from '../instruments/scaler/types'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { playKeyboardNote } from '../ui/KeyboardDock'
import { allProgressions, progressionsFor, realizeProgression, songSets } from '../theory'

describe('scaler depth', () => {
  it('ships hundreds of progressions, song sets, patterns, and performances', () => {
    const progressions = allProgressions()
    const songs = songSets()
    const patterns = patternCatalog()
    const performances = performanceCatalog()
    expect(progressions.length).toBeGreaterThanOrEqual(200)
    expect(songs.length).toBeGreaterThanOrEqual(24)
    expect(patterns.length).toBeGreaterThanOrEqual(20)
    expect(performances.length).toBeGreaterThanOrEqual(80)
    for (const genre of ['pop', 'rnb', 'hiphop', 'trap', 'gospel', 'jazz', 'neosoul', 'latin', 'afrobeats', 'edm', 'film', 'lofi', 'rock', 'country', 'maqam']) {
      expect(progressions.some((item) => item.genre === genre)).toBe(true)
    }
    expect(songs.some((item) => item.genre === 'maqam' && item.progressionIds.length > 0)).toBe(true)
    expect(progressionsFor('ionian')[0].id).toBe('axis')
    expect(realizeProgression(0, 'ionian', progressionsFor('ionian')[0], 4, 3).map((chord) => chord.symbol)).toEqual(['C', 'G', 'Am', 'F'])
    const hijaz = progressions.find((item) => item.song === 'Hijaz Gate' && item.spell?.[1]?.root === 1)
    expect(hijaz).toBeTruthy()
    expect(realizeProgression(0, 'aeolian', hijaz!, 4, 3)[1]?.symbol.startsWith('C#')).toBe(true)
    const styles = new Set(performances.map((item) => item.style))
    for (const style of ['Pop', 'Jazz', 'Latin', 'Gospel', 'Trap', 'Afrobeats', 'Rock', 'Lo-fi']) expect(styles.has(style)).toBe(true)
  })

  it('plays a block chord together and swings an arpeggio', () => {
    const tones = [{ midi: 60, cents: 0 }, { midi: 64, cents: 0 }, { midi: 67, cents: 0 }]
    const block = renderPerformance(tones, 'pop-rhythm-block', 4, 0.5, 0)
    expect(block).toHaveLength(3)
    expect(new Set(block.map((note) => note.startBeat))).toEqual(new Set([0]))
    const arp = renderPerformance(tones, 'jazz-arp-up', 2, 0.5, 0)
    expect(arp.length).toBeGreaterThan(2)
    const off = arp.filter((_, index) => index % 2 === 1)
    expect(off.some((note) => note.startBeat > 0.5)).toBe(true)
    const straight = renderPerformance(tones, 'pop-arp-up', 2, 0.5, 0)
    expect(off[0].startBeat).toBeGreaterThan(straight[1].startBeat)
  })

  it('humanizes timing and keeps a strum from stacking on the same instant', () => {
    const chord = [
      { pitch: 60, startBeat: 0, durationBeats: 1, velocity: 0.8 },
      { pitch: 64, startBeat: 0, durationBeats: 1, velocity: 0.8 },
      { pitch: 67, startBeat: 0, durationBeats: 1, velocity: 0.8 },
    ]
    const still = humanizeNotes(chord, 0)
    expect(still.every((note) => note.startBeat === 0)).toBe(true)
    const moved = humanizeNotes(chord, 2)
    expect(moved.some((note) => note.startBeat !== 0)).toBe(true)
    expect(moved.some((note) => note.velocity !== chord[0].velocity)).toBe(true)
    const strummed = applyExpression(chord, 'strum')
    expect(strummed[2].startBeat).toBeGreaterThan(strummed[0].startBeat)
    const pushed = applyExpression(chord, 'push')
    expect(pushed[0].velocity).toBeGreaterThan(applyExpression(chord, 'still')[0].velocity)
  })

  it('locks keys for scale, chord, chord notes, and one finger', () => {
    const chords = [
      [{ midi: 60, cents: 0 }, { midi: 64, cents: 0 }, { midi: 67, cents: 0 }],
      [{ midi: 62, cents: 0 }, { midi: 65, cents: 0 }, { midi: 69, cents: 0 }],
    ]
    const base = { root: 0, scale: 'ionian', library: '', chordPcs: [0, 4, 7], chords, current: chords[0] }
    expect(applyKeysLock({ ...base, mode: 'scale-snap', midi: 61 }).notes?.[0].midi).toBe(60)
    expect(applyKeysLock({ ...base, mode: 'scale-hide', midi: 61 }).notes).toBeNull()
    expect(applyKeysLock({ ...base, mode: 'scale-hide', midi: 64 }).notes?.[0].midi).toBe(64)
    expect(applyKeysLock({ ...base, mode: 'chord-notes', midi: 62 }).notes).toBeNull()
    expect(applyKeysLock({ ...base, mode: 'chord-notes', midi: 67 }).notes?.[0].midi).toBe(67)
    expect(applyKeysLock({ ...base, mode: 'chord', midi: 61 }).hidden).toBe(true)
    expect(applyKeysLock({ ...base, mode: 'chord', midi: 62 }).notes?.map((note) => note.midi % 12).sort()).toEqual([2, 5, 9])
    const finger = applyKeysLock({ ...base, mode: 'one-finger', midi: 62 })
    expect(finger.notes?.map((note) => note.midi)).toEqual([62, 66, 69])
    expect(moveItem(['Intro', 'Part 1', 'Part 2'], 2, 0)).toEqual(['Part 2', 'Intro', 'Part 1'])
  })

  it('records a chord as simultaneous notes and follows keys lock on the computer keyboard', () => {
    const state = { ...defaultScaler(), performanceId: 'pop-rhythm-block' }
    const played = padPerformance(state, 0, 4)
    expect(played?.notes.length).toBeGreaterThan(1)
    expect(new Set(played?.notes.map((note) => note.startBeat))).toEqual(new Set([0]))
    const lane = notesFromSlots([{ notes: played!.notes }, null], 4)
    expect(lane.every((note) => note.startBeat === 0)).toBe(true)

    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.setTrackInstrument(id, 'scaler')
    store.setScaler(id, { keysLock: 'one-finger', output: 'audio' })
    store.selectTrack(id)
    const sounded: number[] = []
    const engine = {
      playThrough(_track: string, pitch: number) { sounded.push(pitch) },
      pulseMidi() { sounded.push(-1) },
    } as unknown as AudioEngine
    const keys = playKeyboardNote(store, engine, 60, 0.8)
    expect(keys.length).toBeGreaterThan(1)
    expect(sounded).toEqual(keys)
    store.setScaler(id, { keysLock: 'scale-hide' })
    expect(playScalerLive(store.project, engine, id, 61, 0.8)).toEqual([])
  })

  it('detects a key from audio and a chord from notes that start together', () => {
    const rate = 22050
    const melody = [60, 62, 64, 65, 67, 69, 71]
    const pieces = melody.map((midi) => tone(midi, rate, 0.45))
    const channel = concat(pieces)
    const pitches = pitchesFromAudio(channel, rate)
    expect(pitches.length).toBeGreaterThanOrEqual(5)
    const heard = new Set(pitches.map((item) => item.midi))
    expect(melody.filter((midi) => heard.has(midi)).length).toBeGreaterThanOrEqual(5)
    expect(audioChordSymbols(mix([tone(60, rate, 0.7), tone(64, rate, 0.7), tone(67, rate, 0.7)]), rate)).toContain('C')
    expect(chordsFromMidi([
      { midi: 60, startBeat: 0, durationBeats: 4 },
      { midi: 64, startBeat: 0, durationBeats: 4 },
      { midi: 67, startBeat: 0, durationBeats: 4 },
      { midi: 65, startBeat: 4, durationBeats: 4 },
      { midi: 69, startBeat: 4, durationBeats: 4 },
      { midi: 72, startBeat: 4, durationBeats: 4 },
    ])).toEqual(['C', 'F'])
  })

  it('keeps touch targets at 40px and full labels in the scaler skin', () => {
    const css = readFileSync(new URL('../ui/scaler.css', import.meta.url), 'utf8')
    expect(css).toMatch(/min-height:\s*40px/)
    expect(css).toMatch(/min-width:\s*40px/)
    expect(css).not.toMatch(/display:\s*none/)
  })
})

function tone(midi: number, rate: number, seconds: number) {
  const freq = 440 * 2 ** ((midi - 69) / 12)
  const out = new Float32Array(Math.floor(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return out
}

function concat(parts: Float32Array[]) {
  const length = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Float32Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function mix(parts: Float32Array[]) {
  const length = Math.max(...parts.map((part) => part.length))
  const out = new Float32Array(length)
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) out[i] += part[i] / parts.length
  }
  return out
}

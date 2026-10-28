import { describe, expect, it } from 'vitest'
import type { AnalysisSection } from '../analysis/types'
import { DRUM_PADS } from '../model/drums'
import { createEmptyProject, makeTrack, type MidiClip } from '../model/types'
import { buildSession, chordsFromAnalysis } from '../players'
import { diffProject } from '../state/ops'
import { selectPlayers } from '../state/select'
import { ProjectStore } from '../state/store'

const kit = new Set(DRUM_PADS.map((pad) => pad.pitch))

function section(kind: AnalysisSection['kind'], startBar: number, endBar: number): AnalysisSection {
  return { kind, label: kind, startBar, endBar, startBeat: startBar * 4, endBeat: endBar * 4 }
}

function chordTrack() {
  const track = makeTrack({ name: 'Chords', type: 'midi', color: '#e0b15a', input: 'none' })
  const clip: MidiClip = {
    id: 'chords',
    name: 'Chords',
    startBeat: 0,
    durationBeats: 8,
    notes: [
      note(60, 0), note(64, 0), note(67, 0),
      note(65, 4), note(69, 4), note(72, 4),
    ],
  }
  track.midiClips = [clip]
  return track
}

function note(pitch: number, startBeat: number) {
  return { id: `n${pitch}-${startBeat}`, pitch, startBeat, durationBeats: 3.9, velocity: 0.8 }
}

function projectWithChords() {
  const project = createEmptyProject()
  project.tracks.push(chordTrack())
  return project
}

function rolls(notes: { pitch: number; startBeat: number }[], bars: number, bar = 4) {
  const origin = (bars - 1) * bar
  return notes.filter((item) => item.pitch === 38 && item.startBeat > origin + bar - 1 + 0.12).length
}

describe('session players', () => {
  it('writes kit drums, and a busier pad keeps more hits', () => {
    const project = createEmptyProject()
    const sparse = buildSession(project, { style: 'pop', complexity: 0, loudness: 0.8, fills: 0, followSections: false, bass: false, keys: false, endBar: 4 })
    const busy = buildSession(project, { style: 'pop', complexity: 1, loudness: 0.8, fills: 0, followSections: false, bass: false, keys: false, endBar: 4 })
    const quiet = sparse.parts[0]
    const full = busy.parts[0]
    expect(quiet.role).toBe('drums')
    expect(quiet.instrument).toBe('drum-machine')
    expect(quiet.notes.length).toBeGreaterThan(0)
    expect(full.notes.length).toBeGreaterThan(quiet.notes.length)
    for (const hit of full.notes) expect(kit.has(hit.pitch)).toBe(true)
  })

  it('keeps rock, funk, trap, house, hip-hop, R&B, and lo-fi on the drum kit', () => {
    const project = createEmptyProject()
    for (const style of ['rock', 'funk', 'trap', 'house', 'boom-bap', 'rnb', 'lofi']) {
      const built = buildSession(project, { style, complexity: 1, fills: 0, followSections: false, bass: false, keys: false, endBar: 2 })
      expect(built.parts[0].notes.length, style).toBeGreaterThan(0)
      for (const hit of built.parts[0].notes) expect(kit.has(hit.pitch), style).toBe(true)
    }
    const rock = buildSession(project, { style: 'rock', complexity: 1, fills: 0, followSections: false, bass: false, keys: false, endBar: 2 })
    expect(rock.parts[0].notes.some((hit) => hit.pitch === 49)).toBe(true)
  })

  it('plays a louder part and a fill from the generator roll', () => {
    const project = createEmptyProject()
    const soft = buildSession(project, { style: 'pop', complexity: 1, loudness: 0.15, fills: 0, followSections: false, bass: false, keys: false, endBar: 4, seed: 3 })
    const hard = buildSession(project, { style: 'pop', complexity: 1, loudness: 1, fills: 1, followSections: false, bass: false, keys: false, endBar: 4, seed: 3 })
    const mean = (notes: { velocity: number }[]) => notes.reduce((sum, note) => sum + note.velocity, 0) / notes.length
    expect(mean(hard.parts[0].notes)).toBeGreaterThan(mean(soft.parts[0].notes))
    expect(rolls(soft.parts[0].notes, 4)).toBe(0)
    expect(rolls(hard.parts[0].notes, 4)).toBeGreaterThan(0)
  })

  it('makes the chorus busier than the intro', () => {
    const project = createEmptyProject()
    const built = buildSession(project, {
      style: 'pop',
      complexity: 0.5,
      loudness: 0.7,
      fills: 0.2,
      followSections: true,
      bass: false,
      keys: false,
      endBar: 8,
    }, {
      sections: [section('intro', 0, 4), section('chorus', 4, 8)],
    })
    const notes = built.parts[0].notes
    const intro = notes.filter((hit) => hit.startBeat < 16).length
    const chorus = notes.filter((hit) => hit.startBeat >= 16).length
    expect(chorus).toBeGreaterThan(intro)
  })

  it('follows the chord track with bass roots and key tones', () => {
    const project = projectWithChords()
    const built = buildSession(project, { style: 'pop', complexity: 0, loudness: 0.8, fills: 0, followSections: false, drummer: false, endBar: 2 })
    expect(built.source).toBe('track')
    const bass = built.parts.find((part) => part.role === 'bass')!
    const keys = built.parts.find((part) => part.role === 'keys')!
    const roots = bass.notes.filter((item) => item.startBeat % 4 < 0.05).map((item) => item.pitch % 12)
    expect(roots).toEqual([0, 5])
    for (const item of keys.notes) {
      const bar = item.startBeat < 4 ? 0 : 5
      const tones = bar === 0 ? [0, 4, 7] : [5, 9, 0]
      expect(tones).toContain(item.pitch % 12)
    }
    const busy = buildSession(project, { style: 'funk', complexity: 1, loudness: 0.8, followSections: false, drummer: false, bass: false, endBar: 2 })
    expect(busy.parts[0].notes.length).toBeGreaterThan(keys.notes.length)
  })

  it('uses detected chords when the chord track is empty', () => {
    const spelled = chordsFromAnalysis([{ bar: 0, startBeat: 0, beats: 4, symbol: 'Am', root: 9, confidence: 0.8 }])
    expect(spelled[0].root).toBe(9)
    expect(spelled[0].pitches.map((pitch) => pitch % 12).sort((a, b) => a - b)).toEqual([0, 4, 9])
    const built = buildSession(createEmptyProject(), { style: 'pop', complexity: 0, drummer: false, keys: false, endBar: 4 }, {
      detected: [{ bar: 0, startBeat: 0, beats: 4, symbol: 'Am', root: 9, confidence: 0.8 }],
    })
    expect(built.source).toBe('detected')
    expect(built.parts[0].notes[0].pitch % 12).toBe(9)
  })

  it('rebuilds the same MIDI and changes with the seed', () => {
    const project = createEmptyProject()
    const once = buildSession(project, { style: 'funk', seed: 4, complexity: 0.7, fills: 0.4, followSections: false, endBar: 4 })
    const twice = buildSession(project, { style: 'funk', seed: 4, complexity: 0.7, fills: 0.4, followSections: false, endBar: 4 })
    expect(twice.parts.map((part) => part.notes)).toEqual(once.parts.map((part) => part.notes))
    const other = buildSession(project, { style: 'funk', seed: 19, complexity: 0.7, fills: 0.4, followSections: false, endBar: 4 })
    expect(other.parts[0].notes).not.toEqual(once.parts[0].notes)
  })

  it('stores editable MIDI through the project journal', () => {
    const store = new ProjectStore(projectWithChords())
    const before = JSON.parse(JSON.stringify(store.project))
    store.writeSession({ sections: [section('verse', 0, 4), section('chorus', 4, 8)] })
    const drums = store.project.tracks.find((track) => track.name === 'Drums')
    const bass = store.project.tracks.find((track) => track.name === 'Bass')
    const keys = store.project.tracks.find((track) => track.name === 'Keys')
    expect(drums?.instrument).toBe('drum-machine')
    expect(drums?.midiClips[0].notes.length).toBeGreaterThan(0)
    expect(drums?.midiClips[0].notes.every((item) => item.id && kit.has(item.pitch))).toBe(true)
    expect(bass?.midiClips.some((clip) => clip.name.endsWith('bass player'))).toBe(true)
    expect(keys?.midiClips.some((clip) => clip.name.endsWith('keys player'))).toBe(true)
    expect(selectPlayers(store).settings.style).toBe('pop')
    const ops = diffProject(before, store.project)
    expect(ops.some((op) => op.p.includes('midiClips') || op.p === 'players' || op.p.startsWith('tracks'))).toBe(true)
    store.writeSession()
    expect(drums?.midiClips.filter((clip) => clip.name.endsWith('drummer'))).toHaveLength(1)
    store.setPlayers({ style: 'house', complexity: 0.2 })
    const restored = new ProjectStore(JSON.parse(JSON.stringify(store.project)))
    expect(restored.playerState().style).toBe('house')
    expect(restored.playerState().complexity).toBeCloseTo(0.2)
    store.undo()
    expect(store.playerState().style).toBe('pop')
  })
})

import { describe, expect, it } from 'vitest'
import { ProjectStore } from '../state/store'
import { isUntouchedEmpty } from '../model/launchProject'
import { createEmptyProject, makeTrack, uid, type MidiNote, type Project } from '../model/types'
import { spellSymbol } from '../model/progressions'
import { starterPattern } from '../model/steps'
import { applySuggestion } from '../unstuck/apply'
import { deriveSongContext, normalizeSongContext } from '../unstuck/context'
import { audition } from '../unstuck/preview'
import { suggest, suggestionsFor } from '../unstuck/suggest'
import { degreeKey, nextWeights, sectionWeights } from '../unstuck/theory'
import type { Suggestion } from '../unstuck/types'

function note(pitch: number, startBeat: number, durationBeats = 3.5, velocity = 0.8): MidiNote {
  return { id: uid('note'), pitch, startBeat, durationBeats, velocity }
}

function song(chords: { pitches: number[]; bar: number }[], extra?: (project: Project) => void): Project {
  const project = createEmptyProject()
  const keys = project.tracks.find((track) => track.type === 'midi')!
  keys.name = 'Keys'
  const end = Math.max(4, ...chords.map((chord) => (chord.bar + 1) * 4))
  keys.midiClips = [{
    id: uid('midi'),
    name: 'Chords',
    startBeat: 0,
    durationBeats: end,
    notes: chords.flatMap((chord) => chord.pitches.map((pitch) => note(pitch, chord.bar * 4))),
  }]
  extra?.(project)
  return project
}

function pitchesOf(suggestion: Suggestion, role: string): number[] {
  return suggestion.parts.filter((part) => part.role === role).flatMap((part) => part.notes.map((item) => item.pitch))
}

describe('unstuck context', () => {
  it('reads chords and a melody from MIDI when analysis has not run', () => {
    const project = song([
      { bar: 0, pitches: [60, 64, 67] },
      { bar: 1, pitches: [65, 69, 72] },
    ])
    const melody = makeTrack({ name: 'Melody', type: 'midi', input: 'none' })
    melody.midiClips = [{
      id: uid('midi'),
      name: 'Topline',
      startBeat: 0,
      durationBeats: 8,
      notes: [note(76, 0, 3), note(77, 4, 3)],
    }]
    project.tracks.push(melody)
    const context = deriveSongContext(project, 0)
    expect(context.key).toBe(0)
    expect(context.mode).toBe('major')
    expect(context.chordsByBar.map((chord) => degreeKey(chord.symbol))).toEqual(['I', 'IV'])
    expect(context.melodyNotes.map((item) => item.pitch)).toEqual([76, 77])
    expect(context.sections[0].kind).toBe('verse')
    expect(context.activeRoles).toContain('chords')
    expect(context.activeRoles).toContain('melody')
    expect(context.tempo).toBe(project.tempo)
  })

  it('keeps an explicit key and follows MIDI when the project key does not fit', () => {
    const minor = createEmptyProject()
    minor.scale = { ...minor.scale!, root: 9, scale: 'aeolian' }
    const keys = minor.tracks.find((track) => track.type === 'midi')!
    keys.midiClips = [{
      id: uid('midi'),
      name: 'Chords',
      startBeat: 0,
      durationBeats: 4,
      notes: [57, 60, 64].map((pitch) => note(pitch, 0)),
    }]
    expect(deriveSongContext(minor).key).toBe(9)
    expect(deriveSongContext(minor).mode).toBe('minor')

    const sharp = song([{ bar: 0, pitches: [66, 70, 73] }])
    const found = deriveSongContext(sharp)
    expect(found.key).toBe(6)
    expect(found.mode).toBe('major')
    expect(degreeKey(found.chordsByBar[0].symbol)).toBe('I')
  })

  it('accepts a SongContext from the analysis module', () => {
    const context = normalizeSongContext({
      key: 2,
      scale: 'dorian',
      tempo: 100,
      chordsByBar: [{ bar: 0, symbol: 'i', pitches: [62, 65, 69] }],
      sections: [{ kind: 'chorus', startBar: 0, bars: 4 }],
      melodyNotes: [{ pitch: 74, startBeat: 0, durationBeats: 2 }],
    })
    expect(context.mode).toBe('minor')
    expect(context.beatsPerBar).toBe(4)
    expect(context.sections[0].kind).toBe('chorus')
    const ideas = suggest(context)
    expect(ideas.some((item) => item.kind === 'harmonize')).toBe(true)
    const allowed = new Set(nextWeights('i', 'minor').map(([symbol]) => degreeKey(symbol)))
    for (const item of ideas.filter((idea) => idea.kind === 'progression')) {
      expect(allowed.has(degreeKey(item.line.split('–')[0]))).toBe(true)
    }
    expect(ideas.find((item) => item.id === 'move-modulation')?.modulation).toMatchObject({ key: 5, mode: 'major' })
    expect(ideas.find((item) => item.id === 'section-verse')).toBeTruthy()
  })
})

describe('unstuck suggestions', () => {
  it('treats a drum pattern as music and keeps the next idea to four bars', () => {
    const project = createEmptyProject()
    const pattern = starterPattern()
    project.beats = { activeId: pattern.id, patterns: [pattern] }
    project.patternClips = [{ id: 'pat', patternId: pattern.id, startBeat: 0, lengthBeats: 4, scene: null }]
    const context = deriveSongContext(project)
    const next = suggestionsFor(context, 'progression')
    expect(context.activeRoles).toContain('drums')
    expect(next[0].why.toLowerCase().includes('nothing is written')).toBe(false)
    expect(next.every((item) => item.bars <= 4)).toBe(true)
    expect(suggestionsFor(context, 'arrangement').some((item) => item.id === 'arrange-drop')).toBe(true)
  })

  it('continues a major loop with likely chords, a section, and the five moves', () => {
    const project = song([
      { bar: 0, pitches: [60, 64, 67] },
      { bar: 1, pitches: [67, 71, 74] },
      { bar: 2, pitches: [69, 72, 76] },
      { bar: 3, pitches: [65, 69, 72] },
    ])
    const context = deriveSongContext(project)
    const next = suggestionsFor(context, 'progression')
    expect(next.length).toBeGreaterThanOrEqual(3)
    const allowed = new Set(nextWeights('IV', 'major').map(([symbol]) => degreeKey(symbol)))
    for (const item of next) {
      expect(item.why.includes('\n')).toBe(false)
      expect(item.why.length).toBeGreaterThan(12)
      expect(item.why.length).toBeLessThan(160)
      expect(allowed.has(degreeKey(item.line.split('–')[0]))).toBe(true)
      expect(item.line).not.toBe('I–V–vi–IV')
      expect(item.startBeat).toBe(16)
      expect(pitchesOf(item, 'chords').length).toBeGreaterThan(0)
    }
    expect(suggest(context).map((item) => item.id)).toEqual(suggest(context).map((item) => item.id))

    const sections = suggestionsFor(context, 'section')
    expect(sections.map((item) => item.title)).toContain('Pre-chorus')
    expect(sections.map((item) => item.title)).toContain('Chorus')
    expect(sections[0].parts.some((part) => part.role === 'drums')).toBe(true)

    const moves = suggestionsFor(context, 'transition')
    expect(moves.map((item) => item.id)).toEqual(['move-fill', 'move-riser', 'move-pickup', 'move-modulation', 'move-borrowed'])
    expect(pitchesOf(moves[0], 'fill')).toContain(38)
    expect(moves[3].modulation).toMatchObject({ key: 9, mode: 'minor' })
    expect(moves[4].line).toContain('iv')
    expect(sectionWeights('pre-chorus')[0]).toEqual(['chorus', 6])
  })

  it('names the usual next section after a chorus', () => {
    const project = song([{ bar: 0, pitches: [60, 64, 67] }])
    project.tracks[2].midiClips[0].name = 'Chorus'
    const sections = suggestionsFor(deriveSongContext(project), 'section')
    const titles = sections.map((item) => item.title)
    expect(titles).toContain('Verse')
    expect(titles).toContain('Bridge')
  })

  it('harmonizes a melody so every bar keeps that note', () => {
    const project = createEmptyProject()
    const melody = makeTrack({ name: 'Melody', type: 'midi', input: 'none' })
    const line = [64, 65, 67, 60]
    melody.midiClips = [{
      id: uid('midi'),
      name: 'Melody',
      startBeat: 0,
      durationBeats: 16,
      notes: line.map((pitch, index) => note(pitch, index * 4, 3)),
    }]
    project.tracks.push(melody)
    const context = deriveSongContext(project)
    const chords = suggestionsFor(context, 'harmonize')
    expect(chords.length).toBeGreaterThanOrEqual(2)
    const symbols = chords[0].line.split('–')
    expect(symbols).toHaveLength(4)
    symbols.forEach((symbol, index) => {
      const pcs = spellSymbol(symbol, 'major', 0).pitches.map((pitch) => ((pitch % 12) + 12) % 12)
      expect(pcs).toContain(line[index] % 12)
    })
    expect(degreeKey(symbols[3])).toBe('I')
    expect(chords[0].why.includes('\n')).toBe(false)
  })
})

describe('unstuck apply', () => {
  it('appends a progression without erasing the song, and undo puts it back', () => {
    const store = new ProjectStore(song([{ bar: 0, pitches: [60, 64, 67] }]))
    const before = store.project.tracks[2].midiClips[0].notes.length
    const suggestion = suggestionsFor(deriveSongContext(store.project), 'progression')[0]
    store.applyUnstuck(suggestion)
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const sounding = keys.midiClips.flatMap((clip) => clip.notes).filter((item) => !item.muted)
    expect(sounding.length).toBeGreaterThan(before)
    expect(sounding.some((item) => item.pitch % 12 === 0 && item.startBeat < 4)).toBe(true)
    expect(Math.min(...keys.midiClips.map((clip) => clip.startBeat))).toBe(0)
    const saved = JSON.parse(JSON.stringify(store.project)) as Project
    expect(saved.tracks.find((track) => track.name === 'Keys')!.midiClips.length).toBeGreaterThan(0)
    expect(isUntouchedEmpty(store.project)).toBe(false)
    store.undo()
    expect(store.project.tracks[2].midiClips).toHaveLength(1)
    expect(store.project.tracks[2].midiClips[0].notes).toHaveLength(before)
  })

  it('mutes drums for a drop, writes half-time, and modulates', () => {
    const project = song([{ bar: 0, pitches: [60, 64, 67] }, { bar: 1, pitches: [67, 71, 74] }])
    const drums = makeTrack({ name: 'Drums', type: 'midi', input: 'none' })
    drums.midiClips = [{
      id: uid('midi'),
      name: 'Beat',
      startBeat: 0,
      durationBeats: 8,
      notes: [0, 2, 4, 6].flatMap((beat) => [note(36, beat, 0.2, 0.9), note(38, beat + 1, 0.2, 0.8)]),
    }]
    project.patternClips = [{ id: 'pat', patternId: 'none', startBeat: 0, lengthBeats: 8, scene: null }]
    project.tracks.push(drums)
    const context = deriveSongContext(project)
    expect(context.activeRoles).toContain('drums')
    const drop = suggestionsFor(context, 'arrangement').find((item) => item.id === 'arrange-drop')!
    applySuggestion(project, drop)
    const drumNotes = project.tracks.find((track) => track.name === 'Drums')!.midiClips.flatMap((clip) => clip.notes)
    expect(drumNotes.every((item) => item.muted)).toBe(true)
    expect(project.patternClips).toHaveLength(0)

    const fresh = song([{ bar: 0, pitches: [60, 64, 67] }, { bar: 1, pitches: [67, 71, 74] }, { bar: 2, pitches: [69, 72, 76] }, { bar: 3, pitches: [65, 69, 72] }])
    const half = suggestionsFor(deriveSongContext(fresh), 'arrangement').find((item) => item.id === 'arrange-half')!
    applySuggestion(fresh, half)
    const hats = fresh.tracks.find((track) => track.name === 'Drums')!.midiClips.flatMap((clip) => clip.notes)
    expect(hats.some((item) => item.pitch === 38 && Math.abs((item.startBeat % 4) - 2) < 0.01)).toBe(true)

    const modulated = song([{ bar: 0, pitches: [60, 64, 67] }])
    const change = suggestionsFor(deriveSongContext(modulated), 'transition').find((item) => item.id === 'move-modulation')!
    applySuggestion(modulated, change)
    expect(modulated.scale?.root).toBe(9)
    expect(modulated.scale?.scale).toBe('aeolian')
    const chordNotes = modulated.tracks.find((track) => track.name === 'Keys')!.midiClips.flatMap((clip) => clip.notes)
    expect(chordNotes.some((item) => item.pitch % 12 === 9)).toBe(true)
  })

  it('writes chords under a melody and leaves the melody notes', () => {
    const project = createEmptyProject()
    const melody = makeTrack({ name: 'Melody', type: 'midi', input: 'none' })
    melody.midiClips = [{
      id: uid('midi'),
      name: 'Melody',
      startBeat: 0,
      durationBeats: 8,
      notes: [note(67, 0, 3), note(60, 4, 3)],
    }]
    project.tracks.push(melody)
    const suggestion = suggestionsFor(deriveSongContext(project), 'harmonize')[0]
    applySuggestion(project, suggestion)
    const sung = project.tracks.find((track) => track.name === 'Melody')!.midiClips[0].notes
    expect(sung.map((item) => item.pitch)).toEqual([67, 60])
    expect(sung.every((item) => !item.muted)).toBe(true)
    const chords = project.tracks.find((track) => track.name === 'Chords' || track.name === 'Keys')!
    expect(chords.midiClips.some((clip) => clip.notes.length > 0)).toBe(true)
  })

  it('previews the previous chord before the new one', () => {
    const project = song([{ bar: 0, pitches: [60, 64, 67] }])
    const context = deriveSongContext(project)
    const suggestion = suggestionsFor(context, 'progression')[0]
    const events = audition(context, suggestion)
    const tail = events.filter((event) => event.at === 0 && !event.drum)
    expect(tail.map((event) => event.pitch % 12).sort((a, b) => a - b)).toEqual([0, 4, 7])
    expect(events.some((event) => event.at > 0)).toBe(true)
    const arrange = suggestionsFor(context, 'arrangement').find((item) => item.hear === 'arrange')!
    const bed = audition(context, arrange)
    expect(bed.every((event) => event.at < 30)).toBe(true)
    expect(bed.length).toBeGreaterThan(0)
  })
})

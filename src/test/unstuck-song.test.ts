import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isDrumsPlugin } from '../audio/plugins/ids'
import type { AudioEngine } from '../audio/engine'
import { createEmptyProject, uid, type MidiNote, type Project } from '../model/types'
import { ProjectStore } from '../state/store'
import { composeUnstuck, pickTempo } from '../unstuck/compose'
import { normalizeBrief, type UnstuckBrief } from '../unstuck/brief'
import type { ComposeContext } from '../unstuck/draft'
import { applyUnstuckDraft } from '../unstuck/place'
import { readClip } from '../unstuck/read'
import { varyNotes } from '../unstuck/vary'
import { UnstuckSheet } from '../unstuck/UnstuckSheet'

function brief(patch: Partial<UnstuckBrief> = {}) {
  return normalizeBrief({
    seed: 4,
    genre: 'pop',
    feel: 'straight',
    mood: 'warm',
    energy: 0.8,
    complexity: 0,
    density: 1,
    humanize: 0,
    length: 'short',
    structure: 'pop',
    parts: ['drums', 'bass', 'chords', 'melody', 'pad'],
    locks: [],
    ...patch,
  })
}

function ctx(patch: Partial<ComposeContext> = {}): ComposeContext {
  return { barBeats: 4, startBeat: 0, replace: false, ...patch }
}

function notesOf(draft: ReturnType<typeof composeUnstuck>, role: string) {
  return draft.tracks.find((track) => track.role === role)?.clips.flatMap((clip) => clip.notes.map((note) => ({
    clip: clip.name,
    pitch: note.pitch,
    start: note.startBeat,
    fine: note.fine ?? 0,
  }))) ?? []
}

function chordClip(project: Project) {
  const keys = project.tracks.find((track) => track.type === 'midi')!
  const notes: MidiNote[] = [0, 4, 8, 12].flatMap((beat) => [60, 64, 67].map((pitch) => ({
    id: uid('note'),
    pitch: beat === 12 ? pitch : pitch,
    startBeat: beat,
    durationBeats: 3.5,
    velocity: 0.8,
  })))
  keys.midiClips = [{ id: uid('midi'), name: 'Chords', startBeat: 0, durationBeats: 16, notes }]
  keys.name = 'Chords'
  return keys
}

describe('unstuck songs', () => {
  it('repeats a seed and changes when the seed changes', () => {
    const first = composeUnstuck(brief({ seed: 4 }), { action: 'full' }, ctx())
    const again = composeUnstuck(brief({ seed: 4 }), { action: 'full' }, ctx())
    const other = composeUnstuck(brief({ seed: 11 }), { action: 'full' }, ctx())
    expect(notesOf(again, 'melody')).toEqual(notesOf(first, 'melody'))
    expect(notesOf(again, 'drums')).toEqual(notesOf(first, 'drums'))
    expect(notesOf(other, 'melody')).not.toEqual(notesOf(first, 'melody'))
  })

  it('keeps a part action to that part and puts the full arrangement on its own action', () => {
    const drums = composeUnstuck(brief(), { action: 'part', role: 'drums' }, ctx())
    expect(drums.tracks.map((track) => track.role)).toEqual(['drums'])
    expect(drums.sections).toEqual([])
    expect(drums.summary.toLowerCase()).toContain('drums')
    expect(drums.summary.toLowerCase()).not.toContain('full song')

    const song = composeUnstuck(brief({ structure: 'pop', length: 'medium' }), { action: 'full' }, ctx())
    const kinds = song.sections.map((section) => section.kind)
    expect(kinds).toEqual(expect.arrayContaining(['intro', 'verse', 'pre', 'chorus', 'bridge', 'outro']))
    expect(song.tracks.map((track) => track.role)).toEqual(expect.arrayContaining(['drums', 'bass', 'chords', 'melody']))
    expect(song.sectionMode).toBe('add')
    const drumClips = song.tracks.find((track) => track.role === 'drums')!.clips
    const intro = drumClips.find((clip) => clip.name.includes('Intro'))!
    const chorus = drumClips.find((clip) => clip.name.includes('Chorus') && !clip.name.includes('2') && !clip.name.includes('3'))!
    expect(intro.notes.map((note) => [note.pitch, note.startBeat])).not.toEqual(chorus.notes.map((note) => [note.pitch, note.startBeat]))
    const verseChords = song.tracks.find((track) => track.role === 'chords')!.clips.find((clip) => clip.name.includes('Verse') && !clip.name.includes('2'))!
    const chorusChords = song.tracks.find((track) => track.role === 'chords')!.clips.find((clip) => clip.name.includes('Chorus') && !clip.name.includes('2') && !clip.name.includes('3'))!
    expect(verseChords.notes.map((note) => note.pitch).join()).not.toBe(chorusChords.notes.map((note) => note.pitch).join())
    const stacked = chorusChords.notes.some((note) => chorusChords.notes.filter((other) => Math.abs(other.startBeat - note.startBeat) < 0.02).length >= 2)
    expect(stacked).toBe(true)
  })

  it('follows genre, tempo, scale, and feel constraints', () => {
    const house = composeUnstuck(brief({ genre: 'house', feel: 'straight', tempoMin: 120, tempoMax: 128, seed: 2 }), { action: 'part', role: 'drums' }, ctx())
    expect(house.tempo).toBeGreaterThanOrEqual(120)
    expect(house.tempo).toBeLessThanOrEqual(128)
    expect(pickTempo(brief({ genre: 'house', tempoMin: 120, tempoMax: 128, seed: 2 }))).toBe(house.tempo)
    const kicks = notesOf(house, 'drums').filter((note) => note.pitch === 36 && note.start < 4).map((note) => note.start)
    expect(kicks).toEqual([0, 1, 2, 3])

    const trap = composeUnstuck(brief({ genre: 'trap', feel: 'straight', seed: 6 }), { action: 'part', role: 'drums' }, ctx())
    const snares = notesOf(trap, 'drums').filter((note) => note.pitch === 38)
    expect(snares.some((note) => Math.abs((note.start % 4) - 2) < 0.05)).toBe(true)
    expect(snares.some((note) => Math.abs((note.start % 4) - 1) < 0.05)).toBe(false)

    const line = composeUnstuck(brief({ key: 0, scale: 'ionian', genre: 'pop' }), { action: 'part', role: 'melody' }, ctx())
    const allowed = new Set([0, 2, 4, 5, 7, 9, 11])
    expect(notesOf(line, 'melody').length).toBeGreaterThan(3)
    for (const note of notesOf(line, 'melody')) expect(allowed.has(((note.pitch % 12) + 12) % 12)).toBe(true)

    const maqam = composeUnstuck(brief({ genre: 'maqam', scale: 'maqam-bayati', key: 0, seed: 2, length: 'short' }), { action: 'part', role: 'chords' }, ctx())
    expect(notesOf(maqam, 'chords').some((note) => note.fine === 50 || note.fine === -50)).toBe(true)

    const country = composeUnstuck(brief({ genre: 'country', feel: 'shuffle', seed: 3 }), { action: 'part', role: 'chords' }, ctx())
    expect(country.tracks[0].clips[0].notes.length).toBeGreaterThan(0)
    expect(country.tempo).toBeGreaterThanOrEqual(96)
    expect(country.tempo).toBeLessThanOrEqual(124)
  })

  it('locks a part, and regenerating one section leaves the other sections alone', () => {
    const store = new ProjectStore(createEmptyProject())
    const song = composeUnstuck(brief({ seed: 3, structure: 'pop', length: 'short' }), { action: 'full' }, ctx())
    store.writeUnstuck(song)
    const bass = store.project.tracks.find((track) => track.name === 'Bass')!
    const verse = bass.midiClips.find((clip) => clip.name.includes('Verse'))!
    verse.notes[0].pitch = 40
    const chorus = store.project.sections!.find((section) => section.name === 'Chorus')!
    const rewritten = composeUnstuck(brief({ seed: 9, structure: 'pop', length: 'short' }), {
      action: 'rewrite',
      roles: ['drums', 'bass', 'chords', 'melody', 'pad'],
      kind: 'chorus',
      name: 'Chorus',
      bars: chorus.durationBeats / 4,
      startBeat: chorus.startBeat,
    }, ctx({ startBeat: chorus.startBeat, replace: true, previousEnd: chorus.startBeat + chorus.durationBeats }))
    store.writeUnstuck(rewritten)
    expect(verse.notes[0].pitch).toBe(40)
    expect(bass.midiClips.some((clip) => clip.name.includes('Chorus'))).toBe(true)

    const locked = composeUnstuck(brief({ seed: 12, locks: ['bass'], structure: 'pop', length: 'short' }), { action: 'full' }, ctx({
      replace: true,
      previousEnd: song.sections[song.sections.length - 1].startBeat + song.sections[song.sections.length - 1].durationBeats,
    }))
    expect(locked.tracks.some((track) => track.role === 'bass')).toBe(false)
    expect(locked.replace?.roles ?? []).not.toContain('bass')
    store.writeUnstuck(locked)
    expect(store.project.tracks.find((track) => track.name === 'Bass')!.midiClips.some((clip) => clip.notes.some((note) => note.pitch === 40))).toBe(true)
    store.undo()
    expect(store.project.tracks.find((track) => track.name === 'Bass')!.midiClips.some((clip) => clip.notes.some((note) => note.pitch === 40))).toBe(true)
    store.undo()
    store.undo()
    expect(store.project.tracks.every((track) => track.midiClips.every((clip) => clip.notes.length === 0))).toBe(true)
  })

  it('writes editable tracks, plugins, chord stacks, and markers in one undo', () => {
    const store = new ProjectStore(createEmptyProject())
    const song = composeUnstuck(brief({ seed: 1 }), { action: 'full' }, ctx())
    store.writeUnstuck(song)
    const drums = store.project.tracks.find((track) => track.name === 'Drums')!
    const chords = store.project.tracks.find((track) => track.name === 'Chords')!
    const melody = store.project.tracks.find((track) => track.name === 'Melody')!
    expect(drums.instrument).toBe('pads')
    expect(drums.padKit?.banks.length).toBeGreaterThan(0)
    expect(drums.plugins.some((plugin) => isDrumsPlugin(plugin))).toBe(true)
    expect(chords.instrument).toBe('scaler')
    expect(chords.scaler?.root).toBe(0)
    expect(chords.plugins.some((plugin) => plugin.pluginId === 'scaler')).toBe(true)
    expect(melody.instrument).toBe('synth')
    expect(melody.plugins.some((plugin) => plugin.pluginId === 'synth')).toBe(true)
    expect(drums.plugins.some((plugin) => plugin.pluginId === 'compressor')).toBe(true)
    expect(store.project.sections!.length).toBeGreaterThan(3)
    expect(store.project.sections!.every((section) => section.durationBeats > 0)).toBe(true)
    const chordNotes = chords.midiClips.flatMap((clip) => clip.notes)
    expect(chordNotes.some((note) => chordNotes.filter((other) => other !== note && Math.abs(other.startBeat + chords.midiClips.find((clip) => clip.notes.includes(other))!.startBeat - (note.startBeat + chords.midiClips.find((clip) => clip.notes.includes(note))!.startBeat)) < 0.02).length >= 1)).toBe(true)
    expect(store.project.tempo).toBeGreaterThanOrEqual(100)
    expect(store.project.tempo).toBeLessThanOrEqual(126)
    store.undo()
    expect(store.project.tracks.some((track) => track.name === 'Drums')).toBe(false)
    expect(store.project.sections ?? []).toEqual([])
  })

  it('continues, varies, and complements a selected clip without erasing it', () => {
    const project = createEmptyProject()
    const keys = chordClip(project)
    const picture = readClip(project, keys.midiClips[0].id, 4)!
    expect(picture.role).toBe('chords')
    expect(picture.bars).toBe(4)
    const varied = varyNotes(picture, 'subtle', 5, 'ionian', 0)
    expect(varied.length).toBeGreaterThan(0)
    expect(varied.some((note) => note.pitch % 12 === 0)).toBe(true)
    expect(varied.map((note) => note.pitch)).not.toEqual(picture.notes.map((note) => note.pitch))

    const store = new ProjectStore(project)
    const before = keys.midiClips[0].notes.map((note) => note.pitch)
    store.writeUnstuck(composeUnstuck(brief({ amount: 'subtle', seed: 5 }), { action: 'vary' }, ctx({
      startBeat: picture.startBeat + picture.durationBeats,
      clip: picture,
    })))
    expect(store.project.tracks.find((track) => track.id === keys.id)!.midiClips[0].notes.map((note) => note.pitch)).toEqual(before)
    const variation = store.project.tracks.flatMap((track) => track.midiClips).find((clip) => clip.name.startsWith('Unstuck Variation'))!
    expect(variation.startBeat).toBe(16)

    store.writeUnstuck(composeUnstuck(brief({ seed: 6 }), { action: 'continue', bars: 4 }, ctx({
      startBeat: 16,
      clip: picture,
    })))
    const continued = store.project.tracks.flatMap((track) => track.midiClips).find((clip) => clip.name.startsWith('Unstuck Continue'))!
    expect(continued.startBeat).toBe(16)
    expect(continued.notes.length).toBeGreaterThan(2)

    store.writeUnstuck(composeUnstuck(brief({ seed: 7 }), { action: 'complement' }, ctx({ startBeat: 0, clip: picture })))
    const bass = store.project.tracks.find((track) => track.name === 'Bass')!
    expect(bass.midiClips[0].startBeat).toBe(0)
    expect(bass.midiClips[0].notes.length).toBeGreaterThan(0)
    expect(bass.instrument === 'synth' || bass.instrument === '808').toBe(true)
    expect(store.project.tracks.find((track) => track.id === keys.id)!.midiClips[0].notes).toHaveLength(before.length)
    store.undo()
    expect(store.project.tracks.some((track) => track.name === 'Bass')).toBe(false)
  })

  it('applies a draft as plain MIDI the piano roll can edit', () => {
    const project = createEmptyProject()
    const draft = composeUnstuck(brief({ seed: 8 }), { action: 'part', role: 'bass' }, ctx())
    applyUnstuckDraft(project, draft)
    const bass = project.tracks.find((track) => track.name === 'Bass')!
    const note = bass.midiClips[0].notes[0]
    note.pitch = 36
    note.velocity = 0.4
    note.durationBeats = 1
    expect(bass.midiClips[0].notes[0]).toMatchObject({ pitch: 36, velocity: 0.4, durationBeats: 1 })
    expect(project.scale?.root).toBe(0)
  })

  it('shows part actions first and a separate full song control', () => {
    const store = new ProjectStore(createEmptyProject())
    const engine = { stopPreview() {}, positionSamples: 0 } as AudioEngine
    const html = renderToStaticMarkup(createElement(UnstuckSheet, { store, engine, onClose: () => undefined }))
    expect(html).toContain('data-unstuck="parts"')
    expect(html).toContain('>Drums<')
    expect(html).toContain('>Bass<')
    expect(html).toContain('>Chords<')
    expect(html).toContain('>Melody<')
    expect(html).toContain('>Arpeggio<')
    expect(html).toContain('>Pad<')
    expect(html).toContain('>Fill<')
    expect(html).toContain('>Transition<')
    expect(html).toContain('>Next section<')
    expect(html).toContain('>Full song<')
    expect(html).toContain('>Shuffle again<')
    expect(html).toContain('Include Drums')
    expect(html).toContain('Lock Drums')
    expect(html).toContain('aria-label="Genre"')
    expect(html).toContain('aria-label="Feel"')
    expect(html).toContain('aria-label="Scale"')
    expect(html).toContain('Hijaz')
    expect(html).not.toContain('guide-scrim')
    const css = readFileSync(new URL('../ui/guideSheet.css', import.meta.url), 'utf8')
    expect(css).toMatch(/\.unstuck-sheet button[\s\S]*min-height:\s*44px/)
    expect(store.project.tracks.every((track) => track.midiClips.every((clip) => clip.notes.length === 0))).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { selectLayers } from '../audio/multisample/map'
import { midiVelocity } from '../audio/multisample/types'
import { parseChordToken, parseLooseName } from '../library/looseName'
import { looseGroup, presentSoundEntries, samplerFromNotes } from '../sounds/noteGroups'
import type { SoundEntry } from '../sounds/types'
import { groupInstruments } from '../harbor/program'
import { parseHarborEntry } from '../harbor/parse'

function sound(path: string, extra: Partial<SoundEntry> = {}): SoundEntry {
  const name = path.split('/').pop()?.replace(/\.[^.]+$/, '') || path
  return {
    id: path,
    path,
    name,
    type: 'one-shot',
    tags: [],
    durationSec: 0.4,
    sampleRate: 48000,
    license: 'CC0-1.0',
    source: 'This device',
    origin: 'private',
    pack: extra.pack ?? 'Goldbaby',
    category: extra.category ?? 'bass',
    role: extra.role ?? 'one_shot',
    ...extra,
  }
}

describe('device-local note grouping', () => {
  it('reads the note names from the screenshot and from prefixed files', () => {
    expect(parseLooseName('A')?.pitchClass).toBe(9)
    expect(parseLooseName('C#')?.pitchClass).toBe(1)
    expect(parseLooseName('C#2')?.midi).toBe(37)
    expect(parseLooseName('F#2')?.midi).toBe(42)
    expect(parseLooseName('Db3')?.midi).toBe(49)
    expect(parseLooseName('A bass')?.role).toBe('bass')
    expect(parseLooseName('Bass C#')?.role).toBe('bass')
    expect(parseLooseName('139 Trap Click C')).toBeNull()
  })

  it('lists Goldbaby bass notes as one instrument and keeps a kick', () => {
    const notes = ['A', 'B', 'C#', 'C', 'D#', 'D'].map((note) => sound(`private/Goldbaby/Bass/${note}.wav`))
    const listed = presentSoundEntries([
      ...notes,
      sound('private/Goldbaby/Bass/C#2.wav'),
      sound('private/Goldbaby/Bass/F#2.wav'),
      sound('private/Goldbaby/Bass/Db3.wav'),
      sound('private/Goldbaby/Kicks/kick.wav', { category: 'kick', role: 'drum_one_shot' }),
    ])
    const bass = listed.filter((entry) => /bass/i.test(entry.name))
    expect(bass).toHaveLength(1)
    expect(bass[0]?.type).toBe('instrument')
    expect(listed.some((entry) => entry.name === 'kick')).toBe(true)
    expect(listed.some((entry) => entry.name === 'A')).toBe(false)
  })

  it('plays different pitches from one grouped instrument', () => {
    const program = samplerFromNotes('bass', 'Bass', [
      { midi: 33, bufferId: 'a', sampleRate: 48000 },
      { midi: 45, bufferId: 'c', sampleRate: 48000 },
      { midi: 50, bufferId: 'd', sampleRate: 48000 },
    ])
    const low = selectLayers(program, { note: 33, velocity: midiVelocity(0.8), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    const high = selectLayers(program, { note: 62, velocity: midiVelocity(0.8), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(low.layers[0]?.sample.bufferId).toBe('a')
    expect(high.layers[0]?.sample.bufferId).not.toBe('a')
  })

  it('groups harbor note files that share a folder', () => {
    const rows = ['A.wav', 'B.wav', 'C#.wav', 'D.wav'].map((file) => parseHarborEntry({
      id: file,
      path: `instruments/finger-bass/${file}`,
      name: file.replace('.wav', ''),
      type: 'one-shot',
      license: 'CC0-1.0',
      source: 'Test',
    }))
    expect(rows.every(Boolean)).toBe(true)
    const instruments = groupInstruments(rows.filter((row): row is NonNullable<typeof row> => Boolean(row)))
    expect(instruments).toHaveLength(1)
    expect(instruments[0]?.program.zones.length).toBeGreaterThanOrEqual(4)
    const low = selectLayers(instruments[0]!.program, { note: instruments[0]!.program.zones[0]!.root, velocity: midiVelocity(0.7), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    const highNote = Math.max(...instruments[0]!.program.zones.map((zone) => zone.root))
    const high = selectLayers(instruments[0]!.program, { note: highNote, velocity: midiVelocity(0.7), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(low.layers[0]?.zone.root).not.toBe(high.layers[0]?.zone.root)
  })

  it('groups chord shots that share a pack and a base name', () => {
    const chords = ['Amaj', 'Amin', 'Cmaj', 'Cmin', 'Emaj', 'Emin']
    const listed = presentSoundEntries([
      ...chords.map((chord) => sound(`packs/1 Shot Polys/Ap Shotpolyb ${chord}.wav`, { pack: '1 Shot Polys', category: 'synth', role: 'one_shot' })),
      ...['Amaj', 'Cmaj'].map((chord) => sound(`packs/1 Shot Polys/Ap Shotpolyc ${chord}.wav`, { pack: '1 Shot Polys', category: 'synth', role: 'one_shot' })),
      sound('packs/1 Shot Polys/kick.wav', { pack: '1 Shot Polys', category: 'kick', role: 'drum_one_shot' }),
      sound('packs/1 Shot Polys/Only Bmaj.wav', { pack: '1 Shot Polys', category: 'synth', role: 'one_shot' }),
    ])
    const major = listed.filter((entry) => entry.name === '1 Shot Polys - Ap Shotpolyb Maj')
    const minor = listed.filter((entry) => entry.name === '1 Shot Polys - Ap Shotpolyb Min')
    const polyc = listed.filter((entry) => entry.name === '1 Shot Polys - Ap Shotpolyc Maj')
    expect(major).toHaveLength(1)
    expect(minor).toHaveLength(1)
    expect(major[0]?.type).toBe('instrument')
    expect(polyc).toHaveLength(1)
    expect(listed.some((entry) => entry.name === 'kick')).toBe(true)
    expect(listed.some((entry) => entry.name === 'Only Bmaj')).toBe(true)
    expect(listed.some((entry) => entry.type === 'instrument' && /Amaj/.test(entry.name))).toBe(false)
    const group = looseGroup(major[0]!.id)
    const program = samplerFromNotes(group!.id, group!.name, group!.members.map((member) => ({
      midi: member.midi,
      bufferId: member.entry.id,
      sampleRate: 48000,
      velLo: member.velLo,
      velHi: member.velHi,
    })))
    const loud = selectLayers(program, { note: group!.members.find((member) => member.entry.id.includes('Amaj'))!.midi, velocity: midiVelocity(0.95), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    const quiet = selectLayers(program, { note: group!.members.find((member) => member.entry.id.includes('Amaj'))!.midi, velocity: midiVelocity(0.2), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(loud.layers[0]?.sample.bufferId).toContain('Amaj')
    expect(quiet.layers[0]?.sample.bufferId).toBe(loud.layers[0]?.sample.bufferId)
    expect(program.zones.every((zone) => zone.lovel === 1 && zone.hivel === 127)).toBe(true)
  })

  it('keeps octave-7 note names on the instrument instead of a dominant-7 row', () => {
    expect(parseChordToken('C7')).toBeNull()
    expect(parseChordToken('F#7')).toBeNull()
    expect(parseChordToken('Bb7')).toBeNull()
    expect(parseChordToken('Cmaj7')?.quality).toBe('maj7')
    expect(parseChordToken('Amin3')).toMatchObject({ pitchClass: 9, quality: 'min', octave: 3 })
    const listed = presentSoundEntries([
      sound('keys/Pad_C3.wav', { pack: 'Keys', category: 'keys' }),
      sound('keys/Pad_E4.wav', { pack: 'Keys', category: 'keys' }),
      sound('keys/Pad_C7.wav', { pack: 'Keys', category: 'keys' }),
      sound('keys/Pad_D7.wav', { pack: 'Keys', category: 'keys' }),
    ])
    const instruments = listed.filter((entry) => entry.type === 'instrument')
    expect(instruments).toHaveLength(1)
    expect(instruments[0]?.name.toLowerCase()).not.toMatch(/\b7$/)
    const group = looseGroup(instruments[0]!.id)
    expect(new Set(group?.members.map((member) => member.midi))).toEqual(new Set([48, 64, 96, 98]))
  })
})

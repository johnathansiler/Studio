import { describe, expect, it } from 'vitest'
import { buildLibraryIndex, searchLibrary } from '../library/search'
import {
  compatibleKeys,
  keyFits,
  keyFromFilename,
  libraryDetectKeys,
  loopKeyCoverage,
  parseMusicalKey,
  projectKeyFromScale,
  resolveEntryKey,
  type MusicalKey,
} from '../library/musicalKey'
import type { LibraryEntry } from '../library/types'

const empty = { text: '', type: '', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null }

function entry(partial: Partial<LibraryEntry> & Pick<LibraryEntry, 'key' | 'type'>): LibraryEntry {
  return {
    size: 10,
    format: 'wav',
    pack: '',
    category: '',
    instrument: '',
    genre: [],
    bpm: null,
    bpmAlt: null,
    musicalKey: '',
    root: '',
    note: '',
    mood: [],
    tags: [],
    license: 'private',
    name: partial.key.split('/').pop() || partial.key,
    ...partial,
  }
}

describe('musical keys', () => {
  it('reads catalog keys, including a bare tonic as major', () => {
    expect(parseMusicalKey('C')?.label).toBe('C major')
    expect(parseMusicalKey('A minor')?.short).toBe('Am')
    expect(parseMusicalKey('F#m')?.label).toBe('F# minor')
    expect(parseMusicalKey('Cmin')?.short).toBe('Cm')
    expect(parseMusicalKey('Bb')?.label).toBe('A# major')
    expect(parseMusicalKey('Eb')?.short).toBe('D#')
    expect(parseMusicalKey('Cmaj')?.mode).toBe('major')
    expect(parseMusicalKey('Amin')?.label).toBe('A minor')
  })

  it('does not treat octave notes or ordinary words as keys', () => {
    expect(parseMusicalKey('C4')).toBeNull()
    expect(parseMusicalKey('F#2')).toBeNull()
    expect(parseMusicalKey('ambience')).toBeNull()
    expect(parseMusicalKey('drum')).toBeNull()
    expect(parseMusicalKey('bpm')).toBeNull()
    expect(keyFromFilename('Drums/Kick_C4.wav')).toBeNull()
    expect(keyFromFilename('Loops/room_tone.wav')).toBeNull()
  })

  it('reads a key out of a loop filename', () => {
    expect(keyFromFilename('Guitar/riff_F#m_100.wav')?.label).toBe('F# minor')
    expect(keyFromFilename('Pads/warm_A_minor.wav')?.short).toBe('Am')
    expect(keyFromFilename('Bass/Cmin_sub_140.wav')?.label).toBe('C minor')
    expect(keyFromFilename('Keys/Bb_major_loop.wav')?.label).toBe('A# major')
  })

  it('prefers catalog metadata, then a Detect reading, then the filename on loops', () => {
    const named = entry({ key: 'Guitar/riff_F#m_100.wav', type: 'loop', musicalKey: 'C' })
    const detected = entry({ key: 'Guitar/riff_F#m_100.wav', type: 'loop' })
    const bare = entry({ key: 'Drums/Kick_Cmin.wav', type: 'one-shot' })
    const detect = parseMusicalKey('D minor')
    expect(resolveEntryKey(named, detect ? { ...detect, source: 'detect' } : null)?.label).toBe('C major')
    expect(resolveEntryKey(detected, detect ? { ...detect, source: 'detect' } : null)?.source).toBe('detect')
    expect(resolveEntryKey(detected)?.source).toBe('filename')
    expect(resolveEntryKey(bare)).toBeNull()
  })

  it('keeps the relative major or minor and the parallel key', () => {
    const major = parseMusicalKey('C major')!
    const names = compatibleKeys(major).map((item) => item.label)
    expect(names).toEqual(['C major', 'A minor', 'C minor'])
    expect(keyFits(parseMusicalKey('A minor'), major, true)).toBe(true)
    expect(keyFits(parseMusicalKey('F# minor'), major, true)).toBe(false)
    expect(keyFits(parseMusicalKey('A minor'), major, false)).toBe(false)
    expect(projectKeyFromScale({ root: 9, scale: 'aeolian' }).label).toBe('A minor')
    expect(projectKeyFromScale({ root: 0, scale: 'ionian' }).short).toBe('C')
  })

  it('filters loops by filename and by a stored Detect reading', () => {
    const guitar = entry({ key: 'Guitar/riff_F#m_100.wav', type: 'loop', musicalKey: '' })
    const pad = entry({ key: 'Pads/warm_A_minor.wav', type: 'loop', musicalKey: '' })
    const kick = entry({ key: 'Drums/Cmin_kick.wav', type: 'one-shot', musicalKey: '' })
    const drone = entry({ key: 'Drones/held.wav', type: 'loop', musicalKey: '' })
    const index = buildLibraryIndex([guitar, pad, kick, drone], [[], [], [], []])
    const names = (musicalKey: string, compatible = false, heard?: ReadonlyMap<string, MusicalKey>) => {
      const hits = searchLibrary(index, { ...empty, musicalKey, keyCompatible: compatible }, heard)
      return [...(hits.ids ?? [])].map((id) => index.entries[id].key)
    }
    expect(names('F# minor')).toEqual(['Guitar/riff_F#m_100.wav'])
    expect(names('A minor')).toEqual(['Pads/warm_A_minor.wav'])
    expect(names('C major')).toEqual([])
    expect(names('C major', true).sort()).toEqual(['Pads/warm_A_minor.wav'])
    const heard = new Map<string, MusicalKey>([['Drones/held.wav', { ...parseMusicalKey('D minor')!, source: 'detect' }]])
    expect(names('D minor', false, heard)).toEqual(['Drones/held.wav'])
    const coverage = loopKeyCoverage([guitar, pad, kick, drone], heard)
    expect(coverage.loops).toBe(3)
    expect(coverage.keyed).toBe(3)
    expect(coverage.filename).toBe(2)
    expect(coverage.detect).toBe(1)
    expect(coverage.percent).toBe(100)
  })

  it('reads a Detect key only for the library file stored on that clip', () => {
    const found = libraryDetectKeys({
      tracks: [{ clips: [{ bufferId: 'buf', hearing: { clearKey: true, key: 'F# minor' } }, { bufferId: 'other', hearing: { clearKey: false, key: '' } }] }],
      libraryFiles: [{ bufferId: 'buf', key: 'Guitar/riff_F#m_100.wav' }],
    })
    expect(found.get('Guitar/riff_F#m_100.wav')?.label).toBe('F# minor')
    expect(found.size).toBe(1)
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BROWSE_PLACE_KEY, laneForType, readBrowsePlace, typeForLane, writeBrowsePlace } from '../ui/browsePlace'
import { FastShelf, LibraryLanes } from '../ui/MyLibrary'
import {
  buildFastRows,
  classifyDrum,
  classifyLoop,
  conformPreviewTempo,
  entryGenres,
  fastOffsetForId,
  fastSounds,
  fastVisibleRange,
  isNearSongTempo,
  mergeBrowseHits,
  nearSongWindow,
  textMatchesBrowse,
} from '../library/fastBrowse'
import type { LibraryEntry } from '../library/types'

function entry(patch: Partial<LibraryEntry> & Pick<LibraryEntry, 'key' | 'name'>): LibraryEntry {
  return {
    size: 10,
    format: 'wav',
    pack: '',
    type: 'one-shot',
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
    ...patch,
  }
}

const drums = [
  entry({ key: 'Drums/kick.wav', name: 'Acoustic Kick', category: 'kick' }),
  entry({ key: 'Drums/808.wav', name: '808 Bass C', category: '808', instrument: '808 bass' }),
  entry({ key: 'Drums/snare.wav', name: 'Tight Snare', category: 'snare' }),
  entry({ key: 'Drums/clap.wav', name: 'Room Clap', category: 'clap' }),
  entry({ key: 'Drums/ch.wav', name: 'Closed Hat', category: 'hat' }),
  entry({ key: 'Drums/oh.wav', name: 'Open Hat', category: 'hat-open' }),
  entry({ key: 'Drums/crash.wav', name: 'Crash', category: 'crash' }),
  entry({ key: 'Drums/ride.wav', name: 'Ride', category: 'ride' }),
  entry({ key: 'Drums/tom.wav', name: 'Floor Tom', category: 'tom' }),
  entry({ key: 'Drums/cow.wav', name: 'Cowbell', category: 'perc' }),
  entry({ key: 'Drums/rim.wav', name: 'Rimshot', category: 'rim' }),
  entry({ key: 'Drums/shaker.wav', name: 'Shaker', category: 'shaker' }),
  entry({ key: 'Drums/riser.wav', name: 'Riser', category: 'fx' }),
  entry({ key: 'Bass/C_sharp.wav', name: 'Finger Bass', category: 'bass', instrument: 'electric bass' }),
]

const loops = [
  entry({ key: 'Loops/drums.wav', name: 'Trap Drum Loop', type: 'loop', category: 'drums', genre: ['trap'], bpm: 140 }),
  entry({ key: 'Loops/bass.wav', name: 'Bass Loop', type: 'loop', category: 'bass', musicalKey: 'A minor', bpm: 90 }),
  entry({ key: 'Loops/piano.wav', name: 'Piano Chords', type: 'loop', category: 'piano', musicalKey: 'C major', bpm: 100, genre: ['lo-fi'] }),
  entry({ key: 'Loops/guitar.wav', name: 'Guitar Riff', type: 'loop', category: 'guitar', bpm: 100 }),
  entry({ key: 'Loops/vocal.wav', name: 'Vocal Chop', type: 'loop', category: 'vocal', bpm: 120 }),
  entry({ key: 'Loops/pad.wav', name: 'Warm Pad', type: 'loop', category: 'pad', bpm: 80 }),
]

describe('drum shelves', () => {
  it('reads kick, snare, hats, cymbals, 808, and gives a bass category its own shelf', () => {
    expect(classifyDrum(drums[0])).toEqual({ id: 'kick', sub: '' })
    expect(classifyDrum(drums[1])).toEqual({ id: '808', sub: '' })
    expect(classifyDrum(drums[2])).toEqual({ id: 'snare', sub: '' })
    expect(classifyDrum(drums[4])).toEqual({ id: 'hat', sub: 'closed' })
    expect(classifyDrum(drums[5])).toEqual({ id: 'hat', sub: 'open' })
    expect(classifyDrum(drums[6])).toEqual({ id: 'cymbal', sub: 'crash' })
    expect(classifyDrum(drums[7])).toEqual({ id: 'cymbal', sub: 'ride' })
    expect(classifyDrum(entry({ key: 'k.wav', name: 'BD', tags: ['bd'] }))).toEqual({ id: 'kick', sub: '' })
    expect(classifyDrum(entry({ key: 's.wav', name: 'SNR', tags: ['snr'] }))).toEqual({ id: 'snare', sub: '' })
    expect(classifyDrum(entry({ key: 'h.wav', name: 'HH', tags: ['hh'] }))?.id).toBe('hat')
    expect(classifyDrum(drums[13])).toEqual({ id: 'bass', sub: '' })
    expect(classifyDrum(entry({ key: 'bd.wav', name: 'Bass drum', category: 'kick' }))?.id).toBe('kick')
    expect(classifyDrum(entry({ key: 'kit/hat.wav', name: '808 Hat', category: 'hat', instrument: '808' }))?.id).toBe('hat')
    expect(classifyDrum(entry({ key: 'kit/hat.wav', name: 'Rock Kit Closed Hat', category: 'perc', tags: ['closed_hat'] }))).toEqual({ id: 'hat', sub: 'closed' })
    expect(classifyDrum(entry({ key: 'kit/snare.wav', name: 'Classic 808 Snare', category: 'snare', tags: ['classic-808'] }))?.id).toBe('snare')
    expect(classifyDrum(entry({ key: 'kit/cow.wav', name: 'Classic 808 Cowbell', category: 'cowbell', tags: ['cowbell'] }))?.id).toBe('perc')
    expect(classifyDrum(entry({ key: 'kit/rim.wav', name: 'Classic 808 Rim', category: 'perc', tags: ['rim'] }))?.id).toBe('rim')
    expect(classifyDrum(entry({ key: 'kicks/01 808 - C1.wav', name: '01 808 - C1', category: 'kick', tags: ['kick', '808'] }))?.id).toBe('808')
    expect(classifyDrum(entry({ key: 'kit/03-rimshot.wav', name: 'Room Kit Rimshot', category: 'snare', tags: ['snare', 'rimshot'] }))?.id).toBe('rim')
    expect(classifyDrum(entry({ key: 'kicks/grime.wav', name: '01 909 Grime - C1', category: 'kick', tags: ['kick', 'rim'] }))?.id).toBe('kick')
  })

  it('understands hh, snr, bd, and 808', () => {
    const blob = (item: LibraryEntry) => `${item.name} ${item.tags.join(' ')} ${item.category}`.toLowerCase()
    expect(textMatchesBrowse(blob(entry({ key: 'h.wav', name: 'Closed Hat', tags: ['hat'] })), 'hh', { hh: ['hat', 'hihat'] })).toBe(true)
    expect(textMatchesBrowse('tight snare', 'snr', { snr: ['snare'] })).toBe(true)
    expect(textMatchesBrowse('acoustic kick', 'bd', { bd: ['kick'] })).toBe(true)
    expect(textMatchesBrowse('808 bass', '808', { '808': ['808'] })).toBe(true)
    const primary = drums.filter((item) => item.category === 'kick')
    const found = mergeBrowseHits(primary, drums, 'hh', 'drum')
    expect(found.some((item) => item.name === 'Closed Hat')).toBe(true)
    expect(found.some((item) => item.name === 'Acoustic Kick')).toBe(true)
  })

  it('shows only shelves that have rows, with counts, and jumps in one index', () => {
    const model = buildFastRows({
      entries: drums,
      mode: 'drum',
      category: '',
      sub: '',
      genre: '',
      sort: 'name',
      collapsed: new Set(),
      favoriteKeys: ['Drums/snare.wav'],
      recentKeys: ['Drums/kick.wav'],
    })
    const labels = model.chips.map((chip) => `${chip.label}:${chip.count}`)
    expect(labels).toContain('Kick:1')
    expect(labels).toContain('Snare:1')
    expect(labels).toContain('Hi-hat:2')
    expect(labels).toContain('Cymbal:2')
    expect(labels).toContain('808:1')
    expect(labels).toContain('Bass:1')
    expect(labels.some((label) => label.startsWith('Other:'))).toBe(false)
    expect(model.chips.every((chip) => chip.count > 0)).toBe(true)
    expect(model.rows[0]?.label).toBe('Favorites')
    expect(model.rows[1]?.entry?.name).toBe('Tight Snare')
    expect(model.rows.filter((row) => row.entry?.key === 'Drums/snare.wav')).toHaveLength(1)
    const clap = model.jump.find((item) => item.label === 'Clap')
    expect(clap).toBeTruthy()
    expect(fastOffsetForId(model.rows, model.offsets, clap!.id)).toBeGreaterThan(0)
    const kicked = buildFastRows({ ...blank(), entries: drums, mode: 'drum', category: 'snare' })
    expect(fastSounds(kicked.rows).map((item) => item.name)).toEqual(['Tight Snare'])
    const hats = buildFastRows({ ...blank(), entries: drums, mode: 'drum', category: 'hat' })
    expect(hats.subs.map((chip) => chip.label)).toEqual(['All', 'Closed', 'Open'])
    const closed = buildFastRows({ ...blank(), entries: drums, mode: 'drum', category: 'hat', sub: 'closed' })
    expect(fastSounds(closed.rows).map((item) => item.name)).toEqual(['Closed Hat'])
    const range = fastVisibleRange(model.offsets, model.rows.map((row) => row.height), 0, 80)
    expect(range.end).toBeLessThan(model.rows.length)
    expect(range.start).toBe(0)
  })
})

describe('loop shelves', () => {
  it('groups loops by role and genre without touching the catalog key', () => {
    expect(classifyLoop(loops[0])).toBe('drums')
    expect(classifyLoop(loops[2])).toBe('keys')
    expect(classifyLoop(loops[4])).toBe('vocal')
    expect(classifyLoop(entry({ key: 'Loops/ukulele.wav', name: 'Granular Ukulele', type: 'loop', category: 'ukulele' }))).toBe('guitar')
    expect(classifyLoop(entry({ key: 'Loops/shaker.wav', name: 'SHAKER1', type: 'loop', category: 'nature' }))).toBe('drums')
    expect(classifyLoop(entry({ key: 'Loops/room.wav', name: 'AMBIENCE', type: 'loop', category: 'nature' }))).toBe('fx')
    expect(entryGenres(loops[0])).toEqual(['trap'])
    expect(entryGenres(entry({ key: 'Loops/house_beat.wav', name: 'House Beat', genre: [] }))).toContain('house')
    const model = buildFastRows({ ...blank(), entries: loops, mode: 'loop', genre: 'trap' })
    expect(fastSounds(model.rows).map((item) => item.key)).toEqual(['Loops/drums.wav'])
    expect(model.chips.some((chip) => chip.id === 'drums')).toBe(true)
    const bassShelf = buildFastRows({ ...blank(), entries: loops, mode: 'loop' })
    expect(bassShelf.chips.find((chip) => chip.id === 'bass')?.label).toBe('Bass')
    expect(bassShelf.rows.some((row) => row.entry?.key === 'Loops/bass.wav')).toBe(true)
    expect(classifyLoop(loops[1])).toBe('bass')
    expect(model.genres.some((chip) => chip.id === 'trap' && chip.count === 1)).toBe(true)
    const byBpm = buildFastRows({
      ...blank(),
      entries: [
        entry({ key: 'a.wav', name: 'Fast', type: 'loop', category: 'bass', bpm: 140 }),
        entry({ key: 'b.wav', name: 'Slow', type: 'loop', category: 'bass', bpm: 80 }),
        entry({ key: 'c.wav', name: 'Mid', type: 'loop', category: 'bass', bpm: 100 }),
      ],
      mode: 'loop',
      sort: 'bpm',
      category: 'bass',
    })
    expect(fastSounds(byBpm.rows).map((item) => item.bpm)).toEqual([80, 100, 140])
  })

  it('offers a song-tempo window and a shorter preview when the song is faster', () => {
    expect(nearSongWindow(120)).toEqual({ bpmMin: 110, bpmMax: 130 })
    expect(isNearSongTempo(110, 130, 120)).toBe(true)
    expect(isNearSongTempo(100, 140, 120)).toBe(false)
    const input = new Float32Array(4800)
    for (let i = 0; i < input.length; i++) input[i] = Math.sin(i / 8) * 0.2
    const shaped = conformPreviewTempo([input], 48000, 100, 200, 'beats')
    expect(shaped[0].length).toBeLessThan(input.length)
    expect(shaped[0].length).toBeGreaterThan(2000)
    const same = conformPreviewTempo([input], 48000, 120, 120, 'pro')
    expect(same[0].length).toBe(input.length)
  })
})

describe('fast browse chrome', () => {
  it('renders category chips, jump, and audition controls', () => {
    const model = buildFastRows({ ...blank(), entries: drums, mode: 'drum' })
    const html = renderToStaticMarkup(createElement(FastShelf, {
      mode: 'drum',
      model,
      category: '',
      sub: '',
      genre: '',
      sort: 'name',
      nearTempo: false,
      inKey: false,
      compatible: false,
      songKey: 'C',
      stuck: 'Kick',
      tempoCenter: 120,
      onCategory: () => undefined,
      onSub: () => undefined,
      onGenre: () => undefined,
      onSort: () => undefined,
      onNearTempo: () => undefined,
      onTempo: () => undefined,
      onInKey: () => undefined,
      onCompatible: () => undefined,
      onJump: () => undefined,
      onStep: () => undefined,
      onToggleStuck: () => undefined,
    }))
    expect(html).toContain('Kick 1')
    expect(html).toContain('Snare 1')
    expect(html).toContain('Hi-hat 2')
    expect(html).not.toContain('>Rim 0<')
    expect(html).toContain('Previous')
    expect(html).toContain('Next')
    expect(html).toContain('data-drum-chip="snare"')
    expect(html).toContain('data-drum-chip="bass"')
    expect(html).toContain('Bass 1')
    const loopsHtml = renderToStaticMarkup(createElement(FastShelf, {
      mode: 'loop',
      model: buildFastRows({ ...blank(), entries: loops, mode: 'loop' }),
      category: '',
      sub: '',
      genre: '',
      sort: 'name',
      nearTempo: true,
      inKey: true,
      compatible: false,
      songKey: 'Am',
      stuck: '',
      tempoCenter: 100,
      onCategory: () => undefined,
      onSub: () => undefined,
      onGenre: () => undefined,
      onSort: () => undefined,
      onNearTempo: () => undefined,
      onTempo: () => undefined,
      onInKey: () => undefined,
      onCompatible: () => undefined,
      onJump: () => undefined,
      onStep: () => undefined,
      onToggleStuck: () => undefined,
      filterOpen: true,
    }))
    expect(loopsHtml).toContain('Drums 1')
    expect(loopsHtml).toContain('Bass 1')
    expect(loopsHtml).toContain('data-loop-chip="bass"')
    expect(loopsHtml).toContain('Keys 1')
    expect(loopsHtml).toContain('Vocal 1')
    expect(loopsHtml).toContain('Near tempo')
    expect(loopsHtml).toContain('In Am')
    expect(loopsHtml).toContain('Compatible')
    expect(loopsHtml).toContain('trap')
  })

  it('remembers the shelf, the sort, and the pad browser apart from Arrange', () => {
    const storage = {
      data: new Map<string, string>(),
      getItem(key: string) { return this.data.get(key) ?? null },
      setItem(key: string, value: string) { this.data.set(key, value) },
    }
    writeBrowsePlace({
      drumCategory: 'snare',
      drumSub: 'closed',
      loopCategory: 'bass',
      loopGenre: 'trap',
      loopSort: 'bpm',
      collapsedSections: ['fx'],
      padCategory: 'hat',
      padText: 'hh',
      libraryQuery: { text: '', type: 'loop', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: 110, bpmMax: 130 },
    }, storage)
    const place = readBrowsePlace(storage)
    expect(place.drumCategory).toBe('snare')
    expect(place.loopCategory).toBe('bass')
    expect(place.loopSort).toBe('bpm')
    expect(place.loopGenre).toBe('trap')
    expect(place.collapsedSections).toEqual(['fx'])
    expect(place.padCategory).toBe('hat')
    expect(place.padText).toBe('hh')
    expect(place.libraryQuery.type).toBe('loop')
    expect(place.libraryQuery.bpmMin).toBe(110)
    storage.setItem(BROWSE_PLACE_KEY, JSON.stringify({ libraryQuery: { type: 'loop' }, libraryQuick: 'favorites' }))
    expect(readBrowsePlace(storage).libraryLane).toBe('favorites')
    storage.setItem(BROWSE_PLACE_KEY, JSON.stringify({ libraryQuery: { type: 'one-shot' } }))
    expect(readBrowsePlace(storage).libraryLane).toBe('oneshots')
    writeBrowsePlace({ libraryLane: 'drums', libraryQuery: { text: '', type: 'one-shot', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null } }, storage)
    expect(readBrowsePlace(storage).libraryLane).toBe('drums')
    expect(typeForLane('drums')).toBe('one-shot')
    expect(laneForType('one-shot')).toBe('oneshots')
    expect(typeForLane('loops')).toBe('loop')
  })

  it('puts Loops, Drums, and the other lanes under Search', () => {
    const html = renderToStaticMarkup(createElement(LibraryLanes, { lane: 'drums', onPick: () => undefined }))
    for (const label of ['Loops', 'Drums', 'Instruments', 'One-shots', 'SFX', 'Favorites']) {
      expect(html).toContain(label)
    }
    expect(html).toContain('data-lane="drums"')
    expect(html).toContain('data-lane="loops"')
    expect(html).toContain('aria-pressed="true"')
  })
})

function blank() {
  return {
    category: '',
    sub: '' as const,
    genre: '',
    sort: 'name' as const,
    collapsed: new Set<string>(),
    favoriteKeys: [] as string[],
    recentKeys: [] as string[],
  }
}

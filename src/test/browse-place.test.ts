import { describe, expect, it } from 'vitest'
import { browseIndexForId, browseRowId, emptyBrowsePlace, readBrowsePlace, scrollTopForIndex, writeBrowsePlace } from '../ui/browsePlace'
import { pushRecent, rememberRecent, clearRecent, RECENT_CAP, type RecentSound } from '../library/recent'
import { absorbLegacyFavoriteIds, isFavorite, toggleFavorite, FAVORITES_STORAGE_KEY } from '../library/favorites'
import type { LibraryEntry } from '../library/types'

function memory() {
  const data = new Map<string, string>()
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) },
  }
}

describe('browse place', () => {
  it('restores the tab, filters, search, and the focused row id', () => {
    const storage = memory()
    writeBrowsePlace({
      tab: 'clips',
      libraryText: 'lofi',
      libraryGroup: 'pack',
      libraryQuery: { text: '', type: 'loop', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: 'MusicRadar 587 Lo-Fi', bpmMin: null, bpmMax: null },
      libraryFocus: 'sound:Drums/kick.wav',
      clipText: 'vocal',
    }, storage)
    const place = readBrowsePlace(storage)
    expect(place.tab).toBe('clips')
    expect(place.libraryText).toBe('lofi')
    expect(place.libraryGroup).toBe('pack')
    expect(place.libraryQuery.pack).toBe('MusicRadar 587 Lo-Fi')
    expect(place.libraryQuery.type).toBe('loop')
    expect(place.libraryFocus).toBe('sound:Drums/kick.wav')
    expect(place.clipText).toBe('vocal')
    expect(place.patternText).toBe('')
  })

  it('scrolls by item id, not by a raw pixel guess', () => {
    const ids = ['sound:a', 'sound:b', 'instrument:lib_wobble', 'sound:c']
    expect(browseIndexForId(ids, 'instrument:lib_wobble')).toBe(2)
    expect(browseIndexForId(ids, 'missing')).toBe(-1)
    expect(scrollTopForIndex(2, 48)).toBe(96)
    expect(scrollTopForIndex(0, 48)).toBe(0)
    expect(browseRowId({ kind: 'sound', entry: { key: 'Drums/kick.wav' } as LibraryEntry })).toBe('sound:Drums/kick.wav')
    expect(emptyBrowsePlace().tab).toBe('library')
  })
})

describe('recent sounds', () => {
  it('dedupes, keeps the newest first, and caps the list', () => {
    const first = { id: 'library:a', at: 1, name: 'A', detail: 'loop', kind: 'library' } satisfies RecentSound
    const second = { id: 'library:b', at: 2, name: 'B', detail: 'one-shot', kind: 'library' } satisfies RecentSound
    const again = { ...first, at: 3 }
    const many = Array.from({ length: RECENT_CAP + 5 }, (_, index) => ({ ...second, id: `library:${index}`, at: index }))
    expect(pushRecent([first], second).map((item) => item.id)).toEqual(['library:b', 'library:a'])
    expect(pushRecent([second, first], again).map((item) => item.id)).toEqual(['library:a', 'library:b'])
    expect(pushRecent(many, first)).toHaveLength(RECENT_CAP)
    expect(pushRecent(many, first)[0]?.id).toBe('library:a')
  })

  it('persists on this device and clears', () => {
    const storage = memory()
    clearRecent(storage)
    const kick = {
      id: 'library:Drums/kick.wav',
      name: 'Kick',
      detail: 'one-shot',
      kind: 'library' as const,
      library: {
        key: 'Drums/kick.wav',
        size: 10,
        format: 'wav',
        pack: 'Kit',
        type: 'one-shot',
        category: 'kick',
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
        name: 'Kick',
      },
    }
    rememberRecent(kick, storage)
    rememberRecent(kick, storage)
    const saved = JSON.parse(storage.getItem('cueharbor-recent-sounds') || '[]') as RecentSound[]
    expect(saved).toHaveLength(1)
    expect(saved[0]?.name).toBe('Kick')
    expect(saved[0]?.library?.key).toBe('Drums/kick.wav')
    clearRecent(storage)
    expect(storage.getItem('cueharbor-recent-sounds')).toBeNull()
  })

  it('stars, keeps the star after a reload, and unstars', () => {
    const storage = memory()
    const item = {
      id: 'sound:Drums/kick.wav',
      name: 'Kick',
      detail: 'one-shot',
      kind: 'library' as const,
      legacyId: 'Drums/kick.wav',
    }
    expect(toggleFavorite(item, storage, 10)).toBe(true)
    expect(toggleFavorite({ ...item, id: 'sound:Choir/pad.wav', name: 'Pad', legacyId: 'Choir/pad.wav' }, storage, 20)).toBe(true)
    const saved = JSON.parse(storage.getItem(FAVORITES_STORAGE_KEY) || '[]') as { id: string; at: number }[]
    expect(saved.map((row) => row.id)).toEqual(['sound:Choir/pad.wav', 'sound:Drums/kick.wav'])
    expect(isFavorite('sound:Drums/kick.wav', storage)).toBe(true)
    expect(toggleFavorite(item, storage, 30)).toBe(false)
    expect(isFavorite('sound:Drums/kick.wav', storage)).toBe(false)
    absorbLegacyFavoriteIds(['dust', 'sound:Choir/pad.wav'], storage)
    const merged = JSON.parse(storage.getItem(FAVORITES_STORAGE_KEY) || '[]') as { id: string; legacyId?: string }[]
    expect(merged.some((row) => row.legacyId === 'dust')).toBe(true)
    expect(merged.filter((row) => row.id === 'sound:Choir/pad.wav')).toHaveLength(1)
  })
})

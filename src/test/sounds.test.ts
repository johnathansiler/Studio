import { describe, expect, it } from 'vitest'
import {
  addToCollection,
  analyzeSound,
  buildIndex,
  cacheRemote,
  catalog,
  decodePersonal,
  emptyQuery,
  emptySounds,
  encodePersonal,
  entry,
  matchFilters,
  memoryCache,
  noteUse,
  previewRate,
  searchSounds,
  takeManifest,
  toggleFavorite,
  withUserTag,
  type SoundEntry,
} from '../model/sounds'

function sound(partial: Parameters<typeof entry>[0]): SoundEntry {
  return entry(partial)
}

const sample = [
  sound({ id: 'warm-pad', name: 'Warm Pad', type: 'preset', category: 'synth', character: ['warm', 'evolving'], genres: ['cinematic'], pack: 'Loom', instrument: 'pad', origin: 'synth' }),
  sound({ id: 'warm-bass', name: 'Warm Bass', type: 'preset', category: 'bass', character: ['warm'], genres: ['trap'], pack: 'Loom', instrument: 'bass', origin: 'synth' }),
  sound({ id: 'dark-hit', name: 'Dark Hit', type: 'one-shot', category: 'cinematic', character: ['dark', 'warm'], genres: ['cinematic'], pack: 'Loom', instrument: 'hit', origin: 'generated' }),
  sound({ id: 'trap-hat', name: 'Trap Hat', type: 'one-shot', category: 'drums', character: ['bright'], genres: ['trap'], pack: 'Loom', instrument: 'hat', origin: 'generated' }),
  sound({ id: 'piano', name: 'Concert Piano', type: 'instrument', category: 'keys', character: ['warm'], pack: 'Loom', instrument: 'piano', origin: 'synth' }),
  sound({ id: 'ep', name: 'Suitcase EP', type: 'instrument', category: 'keys', character: ['warm'], pack: 'Loom', instrument: 'ep', origin: 'synth' }),
  sound({ id: 'organ', name: 'Chapel Organ', type: 'instrument', category: 'keys', character: ['airy'], pack: 'Loom', instrument: 'organ', origin: 'synth' }),
  sound({ id: 'kick', name: 'Bass Drum', type: 'one-shot', category: 'drums', character: ['punchy'], pack: 'Loom', instrument: 'bass drum', origin: 'generated' }),
  sound({ id: 'noon', name: 'Noon Loop', type: 'loop', category: 'drums', genres: ['pop'], character: ['bright'], key: 'C', bpm: 120, pack: 'Loom', instrument: 'drums', origin: 'generated' }),
  sound({ id: 'night', name: 'Night Loop', type: 'loop', category: 'drums', genres: ['trap'], character: ['dark'], key: 'Dm', bpm: 140, pack: 'Loom', instrument: 'drums', origin: 'generated' }),
]

const index = buildIndex(sample)

describe('sound browser', () => {
  it('ranks names ahead of partial tag hits and tolerates a typo', () => {
    const found = searchSounds(index, { ...emptyQuery(), text: 'warm pad' }, emptySounds())
    expect(found[0]?.name).toBe('Warm Pad')
    expect(found.some((item) => item.name === 'Warm Bass')).toBe(true)
    const typo = searchSounds(index, { ...emptyQuery(), text: 'paino' }, emptySounds())
    expect(typo.map((item) => item.name)).toContain('Concert Piano')
  })

  it('expands synonyms for keys and kick', () => {
    const keys = searchSounds(index, { ...emptyQuery(), text: 'keys' }, emptySounds()).map((item) => item.instrument)
    expect(keys).toEqual(expect.arrayContaining(['piano', 'ep', 'organ']))
    const kick = searchSounds(index, { ...emptyQuery(), text: 'kick' }, emptySounds())
    expect(kick.map((item) => item.name)).toContain('Bass Drum')
  })

  it('requires every tag inside a group and any group across groups', () => {
    const both = searchSounds(index, { ...emptyQuery(), groups: { character: ['dark', 'warm'] } }, emptySounds())
    expect(both.map((item) => item.id)).toEqual(['dark-hit'])
    const either = searchSounds(index, { ...emptyQuery(), groups: { character: ['dark'], genre: ['trap'] } }, emptySounds()).map((item) => item.id)
    expect(either).toEqual(expect.arrayContaining(['dark-hit', 'warm-bass', 'trap-hat', 'night']))
    expect(either).not.toContain('piano')
    expect(matchFilters(sample[0], { ...emptyQuery(), groups: { character: ['dark', 'warm'] } }, emptySounds())).toBe(false)
  })

  it('filters loops by tempo and key, including the project', () => {
    const ranged = searchSounds(index, { ...emptyQuery(), bpmMin: 110, bpmMax: 125, musicalKey: 'C' }, emptySounds())
    expect(ranged.map((item) => item.id)).toEqual(['noon'])
    const project = searchSounds(index, { ...emptyQuery(120, 'C'), matchProject: true }, emptySounds())
    expect(project.map((item) => item.id)).toEqual(['noon'])
    expect(previewRate(120, 'C', 120, 'C')).toBeCloseTo(1)
    expect(previewRate(100, 'C', 120, 'D')).toBeCloseTo(1.2 * 2 ** (2 / 12))
  })

  it('keeps user tags, favorites, and collections through a save', () => {
    let personal = withUserTag(emptySounds(), 'warm-bass', 'dusty')
    personal = toggleFavorite(personal, 'warm-bass')
    personal = noteUse(personal, 'warm-bass')
    personal = { ...personal, collections: [{ id: 'mine', name: 'Mine', ids: [] }] }
    personal = addToCollection(personal, 'mine', 'warm-bass')
    const restored = decodePersonal(encodePersonal(personal))
    expect(restored.userTags['warm-bass']).toEqual(['dusty'])
    expect(restored.favorite).toEqual(['warm-bass'])
    expect(restored.uses['warm-bass']).toBe(1)
    expect(restored.collections[0]?.ids).toEqual(['warm-bass'])
    const found = searchSounds(index, { ...emptyQuery(), text: 'dusty' }, restored)
    expect(found.map((item) => item.id)).toEqual(['warm-bass'])
  })

  it('reads bpm and key from generated tones', () => {
    const rate = 44100
    const click = new Float32Array(rate * 4)
    for (let i = 0; i < click.length; i += rate / 2) click[i] = 1
    const keyed = new Float32Array(8192)
    for (let i = 0; i < keyed.length; i++) keyed[i] = Math.sin(2 * Math.PI * 440 * (i / rate))
    expect(analyzeSound(click, rate).bpm).toBe(120)
    expect(analyzeSound(keyed, rate).key).toBe('A')
    expect(analyzeSound(keyed.subarray(0, 4000), rate).type).toBe('one-shot')
  })

  it('builds a large index inside the phone budget', () => {
    const rows: SoundEntry[] = []
    for (let i = 0; i < 10_000; i++) {
      rows.push(sound({
        id: `row-${i}`,
        name: `Tone ${i} pad`,
        type: 'preset',
        category: i % 2 ? 'synth' : 'bass',
        character: [i % 3 ? 'warm' : 'dark'],
        genres: [i % 2 ? 'cinematic' : 'trap'],
        pack: 'Bench',
        instrument: i % 5 ? 'pad' : 'piano',
        origin: 'synth',
      }))
    }
    const started = performance.now()
    const large = buildIndex(rows)
    const built = performance.now() - started
    expect(built).toBeLessThan(500)
    const looked = performance.now()
    const hits = searchSounds(large, { ...emptyQuery(), text: 'paino' }, emptySounds())
    const searched = performance.now() - looked
    expect(searched).toBeLessThan(80)
    expect(hits.length).toBeGreaterThan(100)
    expect(catalog().some((item) => item.origin === 'remote')).toBe(false)
  })

  it('refuses a manifest row with no license, a noncommercial license, or a paid host', async () => {
    const good = { id: 'ok', name: 'Ok', license: 'CC0', url: 'https://github.com/example/releases/download/v1/pad.flac', bytes: 10 }
    const result = takeManifest([
      good,
      { ...good, id: 'missing', license: '' },
      { ...good, id: 'nc', license: 'CC-BY-NC' },
      { ...good, id: 'unclear', license: 'ask the owner' },
      { ...good, id: 'paid', license: 'CC0', url: 'https://example.com/pad.flac' },
    ])
    expect(result.ok.map((row) => row.id)).toEqual(['ok'])
    expect(result.rejected).toEqual(['missing', 'nc', 'unclear', 'paid'])
    const cache = memoryCache()
    let called = false
    await expect(cacheRemote({ ...good, id: 'paid', url: 'https://example.com/pad.flac' }, () => {
      called = true
      return Promise.resolve(new Response())
    }, cache)).rejects.toThrow('refused')
    expect(called).toBe(false)
    await cacheRemote(good, async () => new Response(new Uint8Array([1, 2, 3])), cache)
    expect(cache.bytes()).toBe(3)
    cache.delete('ok')
    expect(cache.bytes()).toBe(0)
  })
})

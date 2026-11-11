import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { gunzipText, indexParsedCatalog, parseLibraryCatalog } from '../library/catalog'
import { searchLibrary } from '../library/search'
import { syntheticLibrary } from './libraryCatalogFixture'

const empty = { type: '', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null }

describe('private library at catalog size', () => {
  it('loads, searches, and filters about 92k sounds from a 1.1 MB gzip', async () => {
    const document = syntheticLibrary(91_800)
    const json = JSON.stringify(document)
    const gzip = gzipSync(Buffer.from(json))
    expect(gzip.byteLength).toBeGreaterThan(900_000)
    expect(gzip.byteLength).toBeLessThan(1_200_000)
    const bytes = gzip.buffer.slice(gzip.byteOffset, gzip.byteOffset + gzip.byteLength)
    const started = performance.now()
    const text = await gunzipText(bytes)
    const parsed = parseLibraryCatalog(JSON.parse(text) as unknown)
    expect(parsed).not.toBeNull()
    const index = indexParsedCatalog(parsed!)
    const loadMs = performance.now() - started
    expect(index.entries.length).toBe(91_800)
    expect(loadMs).toBeLessThan(8_000)

    const find = (query: string) => {
      const start = performance.now()
      const hits = searchLibrary(index, { ...empty, text: query })
      return { hits, ms: performance.now() - start }
    }
    const trap = find('trap 808 C')
    const choir = find('choir pad')
    const vinyl = find('vinyl crackle')
    const note = find('C')
    const sharp = find('C#')
    for (const result of [trap, choir, vinyl, note, sharp]) expect(result.ms).toBeLessThan(80)
    const keys = (hits: { ids: Uint32Array | null }) => [...(hits.ids ?? [])].map((id) => index.entries[id].key)
    expect(keys(trap.hits)).toContain('Drums/139_Trap_Click_C.wav')
    expect(keys(trap.hits)).not.toContain('Bass/C_sharp.wav')
    expect(keys(choir.hits)).toContain('Choir/vocal_pad.wav')
    expect(keys(vinyl.hits)).toContain('FX/vinyl_crackle.wav')
    expect(keys(note.hits)).toContain('Drums/139_Trap_Click_C.wav')
    expect(keys(note.hits)).not.toContain('Bass/C_sharp.wav')
    expect(keys(sharp.hits)).toContain('Bass/C_sharp.wav')
    expect(keys(sharp.hits)).not.toContain('Drums/139_Trap_Click_C.wav')

    const filtered = searchLibrary(index, { ...empty, text: 'kick', type: 'one-shot', genre: 'trap', pack: 'Trap Drums' })
    expect(filtered.total).toBeGreaterThan(0)
    expect(index.entries[filtered.ids![0]].type).toBe('one-shot')
    const narrow = searchLibrary(index, { ...empty, text: '', genre: 'trap', bpmMin: 130, bpmMax: 150, type: 'one-shot' })
    expect(narrow.total).toBeGreaterThan(0)
    for (let n = 0; n < narrow.total; n++) {
      const entry = index.entries[narrow.ids![n]]
      expect(entry.genre).toContain('trap')
      expect(entry.type).toBe('one-shot')
    }
  }, 30_000)
})

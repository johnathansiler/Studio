import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'
import { migrateProject } from '../model/schema'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { accessKeyMatches, createLibraryApi, LIBRARY_NOT_READY, libraryClientIp, libraryObjectKey, presignR2Get, type LibraryEnv } from '../../server/library.ts'
import { catalogCacheFields, gunzipText, memoryCatalogCache, parseLibraryCatalog, sameCatalog, type CachedCatalog } from '../library/catalog'
import { clearLibraryAccessKey, LibraryAuthError, readLibraryAccessKey, signLibraryKeys, signedUrlKeepsSecret, writeLibraryAccessKey } from '../library/access'
import { loadLibraryCatalog, memoryAudioCache, setLibraryCaches } from '../library/audio'
import { libraryBufferId, placeLibraryAsset, readLibraryAsset } from '../library/place'
import { cleanLibraryFiles, projectKeepsLibraryKeys, restoreLibraryFiles } from '../library/project'
import { buildLibraryIndex, entryMatchesText, libraryRowWindow, searchLibrary, tokenMatches } from '../library/search'
import type { LibraryEntry } from '../library/types'

const env: LibraryEnv = {
  R2_ACCOUNT_ID: '2001009ff8860d62eac085ee8cce34e2',
  R2_BUCKET: 'cueharbor-private-sounds',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretsecretsecretsecretsecret12',
  LIBRARY_ACCESS_KEY: 'owner-pass',
}

function row(key: string, search: string, extra: Partial<LibraryEntry> = {}): { entry: LibraryEntry; words: string[] } {
  return {
    entry: {
      key,
      size: 128,
      format: 'wav',
      pack: extra.pack ?? 'Pack',
      type: extra.type ?? 'one-shot',
      category: extra.category ?? '',
      instrument: extra.instrument ?? '',
      genre: extra.genre ?? [],
      bpm: extra.bpm ?? null,
      bpmAlt: extra.bpmAlt ?? null,
      musicalKey: extra.musicalKey ?? '',
      root: extra.root ?? '',
      note: extra.note ?? '',
      mood: extra.mood ?? [],
      tags: extra.tags ?? [],
      license: 'private',
      name: key.split('/').pop() || key,
      ...extra,
    },
    words: search.split(/\s+/),
  }
}

const trap = row('Drums/139 Trap Click C.wav', 'trap 808 click c one shot kick', { type: 'one-shot', category: 'kick', instrument: '808 bass', genre: ['trap'], bpm: 140, musicalKey: 'C', root: 'C', mood: ['gritty'], pack: 'Trap Drums' })
const sharp = row('Bass/C#.wav', 'bass electric c# one shot', { type: 'one-shot', category: 'bass', instrument: 'electric bass', root: 'C#', pack: 'Finger Bass' })
const choir = row('Choir/vocal pad.wav', 'choir pad loop vocal ethereal', { type: 'loop', category: 'choir', instrument: 'choir', genre: ['lo-fi'], bpm: 100, musicalKey: 'A minor', mood: ['ethereal'], pack: 'Vocal Pads' })
const vinyl = row('FX/Crackle 01.wav', 'vinyl crackle texture sfx vintage', { type: 'sfx', category: 'fx', instrument: 'vinyl crackle', mood: ['vintage'], pack: 'Special Sauce' })

function indexOf(rows: { entry: LibraryEntry; words: string[] }[]) {
  return buildLibraryIndex(rows.map((item) => item.entry), rows.map((item) => item.words))
}

describe('private library search', () => {
  const index = indexOf([trap, sharp, choir, vinyl])

  it('matches whole words, and prefix only from 3 letters', () => {
    expect(tokenMatches('c', ['c', 'kick'])).toBe(true)
    expect(tokenMatches('c', ['c#'])).toBe(false)
    expect(tokenMatches('c#', ['c#'])).toBe(true)
    expect(tokenMatches('cho', ['choir'])).toBe(true)
    expect(tokenMatches('pad', ['pad'])).toBe(true)
    expect(entryMatchesText('trap 808 click c one shot kick', 'trap 808 C')).toBe(true)
    expect(entryMatchesText('bass electric c# one shot', 'C')).toBe(false)
    expect(entryMatchesText('choir pad loop vocal', 'choir pad')).toBe(true)
    expect(entryMatchesText('vinyl crackle texture sfx', 'vinyl crackle')).toBe(true)
  })

  it('finds trap 808 C, choir pad, and vinyl crackle without matching C#', () => {
    const names = (text: string) => {
      const hits = searchLibrary(index, { text, type: '', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null })
      return [...(hits.ids ?? [])].map((id) => index.entries[id].key)
    }
    expect(names('trap 808 C')).toEqual(['Drums/139 Trap Click C.wav'])
    expect(names('choir pad')).toEqual(['Choir/vocal pad.wav'])
    expect(names('vinyl crackle')).toEqual(['FX/Crackle 01.wav'])
    expect(names('C')).toEqual(['Drums/139 Trap Click C.wav'])
    expect(names('C#')).toEqual(['Bass/C#.wav'])
  })

  it('filters type, instrument, genre, key, mood, pack, and BPM', () => {
    const base = { text: '', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null }
    expect(searchLibrary(index, { ...base, type: 'loop' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', instrument: 'vinyl crackle' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', genre: 'trap' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', musicalKey: 'A minor' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', mood: 'vintage' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', pack: 'Trap Drums' }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', bpmMin: 90, bpmMax: 120 }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: 'one-shot', genre: 'trap', bpmMin: 130, bpmMax: 150 }).total).toBe(1)
    expect(searchLibrary(index, { ...base, type: '', bpmMin: 160, bpmMax: 180 }).total).toBe(0)
  })
})

describe('private library catalog', () => {
  it('reads a gzip catalog and refreshes when the version changes', async () => {
    const document = {
      version: 1,
      generated_at: '2026-11-11T00:00:00Z',
      count: 1,
      pending: 'later',
      entries: [{ key: 'Drums/kick.wav', size: 10, format: 'wav', pack: 'Kit', type: 'one-shot', category: 'kick', instrument: 'kick drum', genre: [], bpm: null, bpm_alt: null, musical_key: null, root: 'C', note: 'C1', chord: null, mood: [], tags: [], license: 'private', search: 'kick c' }],
    }
    const gzip = gzipSync(Buffer.from(JSON.stringify(document)))
    const text = await gunzipText(gzip.buffer.slice(gzip.byteOffset, gzip.byteOffset + gzip.byteLength))
    const parsed = parseLibraryCatalog(JSON.parse(text))
    expect(parsed?.document.count).toBe(1)
    expect(parsed?.document.entries[0].root).toBe('C')
    expect(parsed?.words[0]).toContain('kick')
    const meta = { version: 1, generatedAt: '2026-11-11T00:00:00Z', count: 1 }
    expect(sameCatalog(meta, meta)).toBe(true)
    expect(sameCatalog(meta, { ...meta, count: 2 })).toBe(false)
    expect(sameCatalog(null, meta)).toBe(false)
  })
})

describe('private library auth and signing', () => {
  it('compares the passphrase in constant time and rejects a different length', () => {
    expect(accessKeyMatches('owner-pass', 'owner-pass')).toBe(true)
    expect(accessKeyMatches('owner-pass', 'owner-passx')).toBe(false)
    expect(accessKeyMatches('c', 'owner-pass')).toBe(false)
    expect(libraryObjectKey('../secret.wav')).toBeNull()
    expect(libraryObjectKey('foo/../../secret.wav')).toBeNull()
    expect(libraryObjectKey('foo//bar.wav')).toBeNull()
    expect(libraryObjectKey('a\\b.wav')).toBeNull()
    expect(libraryObjectKey('https://example.com/a.wav')).toBeNull()
    expect(libraryObjectKey('Drums/C#.wav')).toBe('Drums/C#.wav')
  })

  it('hides the feature when a server env var is missing', async () => {
    let signed = 0
    const api = createLibraryApi({ env: () => ({ ...env, R2_SECRET_ACCESS_KEY: '' }), sign: async () => { signed += 1; return 'https://signed.example/a' } })
    const status = await api.handle({ method: 'GET', pathname: '/api/library', ip: '1.1.1.1', accessKey: '', body: null, now: 0 })
    expect(status.status).toBe(200)
    expect(status.body).toEqual({ ready: false, message: LIBRARY_NOT_READY })
    const denied = await api.handle({ method: 'POST', pathname: '/api/library/sign', ip: '1.1.1.1', accessKey: 'owner-pass', body: { keys: ['a.wav'] }, now: 1 })
    expect(denied.status).toBe(503)
    expect(signed).toBe(0)
  })

  it('requires the owner passphrase, rate-limits guesses, and signs with mocked credentials', async () => {
    const signed: string[] = []
    const api = createLibraryApi({
      env: () => env,
      sign: async (key) => {
        signed.push(key)
        return `https://signed.example/${encodeURIComponent(key)}`
      },
    })
    const wrong = await api.handle({ method: 'POST', pathname: '/api/library/sign', ip: '9.9.9.9', accessKey: 'nope', body: { key: 'catalog/catalog.json.gz' }, now: 1_000 })
    expect(wrong.status).toBe(401)
    expect(signed).toEqual([])
    for (let n = 0; n < 7; n++) {
      const again = await api.handle({ method: 'POST', pathname: '/api/library/sign', ip: '9.9.9.9', accessKey: 'nope', body: { key: 'a.wav' }, now: 2_000 + n })
      expect(again.status).toBe(401)
    }
    const locked = await api.handle({ method: 'POST', pathname: '/api/library/sign', ip: '9.9.9.9', accessKey: 'owner-pass', body: { key: 'a.wav' }, now: 3_000 })
    expect(locked.status).toBe(429)
    expect(signed).toEqual([])

    const open = createLibraryApi({
      env: () => env,
      sign: async (key) => {
        signed.push(key)
        return `https://signed.example/${key}`
      },
    })
    const ok = await open.handle({ method: 'POST', pathname: '/api/library/sign', ip: '8.8.8.8', accessKey: 'owner-pass', body: { keys: ['catalog/catalog.json.gz', 'Drums/kick.wav'] }, now: 10_000 })
    expect(ok.status).toBe(200)
    expect(ok.body.expiresIn).toBe(900)
    expect(signed).toEqual(['catalog/catalog.json.gz', 'Drums/kick.wav'])
    expect(JSON.stringify(ok.body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    expect(JSON.stringify(ok.body)).not.toContain('owner-pass')
  })

  it('builds a presigned GET for the private bucket without putting the secret in the URL', async () => {
    const url = new URL(await presignR2Get(env, 'Bass/FreePats Finger Electric Bass/samples/finger/C#.wav'))
    expect(url.host).toBe('2001009ff8860d62eac085ee8cce34e2.r2.cloudflarestorage.com')
    expect(url.pathname).toContain('cueharbor-private-sounds')
    expect(decodeURIComponent(url.pathname)).toContain('C#.wav')
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host')
    expect(url.toString()).not.toContain(env.R2_SECRET_ACCESS_KEY)
    const encoded = new URL(await presignR2Get(env, 'Drums/a?.wav'))
    expect(encoded.pathname).toContain('a%3F.wav')
    expect(encoded.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    const api = createLibraryApi({ env: () => env, sign: async () => 'https://signed.example/nope' })
    const blocked = await api.handle({ method: 'POST', pathname: '/api/library/sign', ip: '1.1.1.1', accessKey: 'owner-pass', body: { method: 'PUT', keys: ['../secret.wav'] }, now: 4_000 })
    expect(blocked.status).toBe(400)
    const removed = await api.handle({ method: 'DELETE', pathname: '/api/library/sign', ip: '1.1.1.1', accessKey: 'owner-pass', body: { keys: ['Drums/kick.wav'] }, now: 4_001 })
    expect(removed.status).toBe(405)
  })
})

describe('private library project refs', () => {
  it('loads a sound onto a pad and stores the object key, not a signed URL', async () => {
    const wav = encodeWav([new Float32Array([0.2, -0.2, 0.2, -0.2])], 48000)
    const cache = memoryAudioCache()
    await cache.put(trap.entry.key, wav)
    setLibraryCaches({ audio: cache })
    const store = new ProjectStore(createEmptyProject(48000))
    const asset = await readLibraryAsset(trap.entry)
    const note = placeLibraryAsset(store, trap.entry, asset, 0)
    expect(note).toContain('pad')
    const files = store.project.libraryFiles ?? []
    expect(files.map((item) => item.key)).toEqual([trap.entry.key])
    expect(projectKeepsLibraryKeys(store.project)).toBe(true)
    const saved = JSON.stringify(store.project)
    expect(saved).not.toContain('X-Amz-')
    expect(saved).not.toContain('r2.cloudflarestorage.com')
    const pad = store.trackKit(store.padsTrackId || '').banks[0]?.find((item) => item.sampleName === trap.entry.name)
    expect(pad?.layers.some((layer) => layer.bufferId && store.buffers.has(layer.bufferId))).toBe(true)
    const migrated = migrateProject(JSON.parse(saved))
    expect(migrated.libraryFiles?.[0].key).toBe(trap.entry.key)
    expect(cleanLibraryFiles([{ bufferId: 'a', key: 'https://example.com/a.wav?X-Amz-Signature=1' }])).toBeUndefined()
  })

  it('restores a missing buffer from the cache and signs only when the bytes are absent', async () => {
    const wav = encodeWav([new Float32Array([0.1, 0.2, 0.1, 0.2])], 48000)
    const cache = memoryAudioCache()
    await cache.put('Drums/cached.wav', wav)
    setLibraryCaches({ audio: cache })
    const store = new ProjectStore(createEmptyProject(48000))
    store.project.libraryFiles = [{ bufferId: 'r2_cached', key: 'Drums/cached.wav' }]
    let calls = 0
    await restoreLibraryFiles(store, async () => { calls += 1; return new Response(null, { status: 500 }) })
    expect(calls).toBe(0)
    expect(store.buffers.get('r2_cached')?.channels[0]?.length).toBe(4)

    store.project.libraryFiles = [
      { bufferId: 'r2_cached', key: 'Drums/cached.wav' },
      { bufferId: 'r2_fresh', key: 'Drums/fresh.wav' },
    ]
    writeLibraryAccessKey('owner-pass')
    const signed: string[] = []
    await restoreLibraryFiles(store, async (input) => {
      const url = String(input)
      if (url === '/api/library/sign') {
        const keys = ['Drums/fresh.wav']
        signed.push(...keys)
        return new Response(JSON.stringify({ expiresIn: 900, urls: [{ key: 'Drums/fresh.wav', url: 'https://library.test/fresh.wav' }] }), { status: 200 })
      }
      return new Response(wav, { status: 200 })
    })
    expect(signed).toEqual(['Drums/fresh.wav'])
    expect(store.buffers.has('r2_fresh')).toBe(true)
    expect(JSON.stringify(store.project)).not.toContain('https://library.test')
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })

  it('keeps a loop on the arrangement, a note on an instrument, and a second hit on the same pads', async () => {
    const wav = encodeWav([new Float32Array([0.2, -0.2, 0.2, -0.2])], 48000)
    const cache = memoryAudioCache()
    await cache.put(trap.entry.key, wav)
    await cache.put(choir.entry.key, wav)
    setLibraryCaches({ audio: cache })
    const store = new ProjectStore(createEmptyProject(48000))
    const asset = await readLibraryAsset(trap.entry)
    placeLibraryAsset(store, trap.entry, asset, 0)
    const snare = { ...trap.entry, key: 'Drums/snare.wav', name: 'Snare' }
    placeLibraryAsset(store, snare, { ...asset, id: libraryBufferId(snare.key), name: 'Snare' }, 0)
    expect(store.project.tracks.filter((track) => track.instrument === 'pads')).toHaveLength(1)

    const note = { ...trap.entry, type: 'multisample note', key: 'Keys/C2.wav', name: 'C2', note: 'C2' }
    placeLibraryAsset(store, note, { ...asset, id: libraryBufferId(note.key), name: 'C2' }, 0)
    expect(store.project.tracks.filter((track) => track.instrument === 'pads')).toHaveLength(1)
    const sampler = store.project.tracks.find((track) => track.instrument === 'sampler')
    expect(sampler?.plugins.find((plugin) => plugin.pluginId === 'sampler')?.sampler?.root).toBe(36)

    const loopAsset = await readLibraryAsset(choir.entry)
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'sampler', input: 'mic', channels: 1, armed: false })
    const pluginId = store.loadSamplerSound(ids[0], { ...loopAsset, id: 'slot-tone', name: 'Tone' }, 60, false)
    store.pluginFocus = { trackId: ids[0], pluginId }
    expect(placeLibraryAsset(store, choir.entry, loopAsset, 48_000)).toContain('sampler')
    store.pluginFocus = null
    expect(placeLibraryAsset(store, choir.entry, { ...loopAsset, id: libraryBufferId('Choir/again.wav') }, 48_000)).toContain('track')
    expect(store.project.tracks.some((track) => track.type === 'audio' && track.clips.length > 0)).toBe(true)
    expect(projectKeepsLibraryKeys(store.project)).toBe(true)
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })
})

describe('private library cache and address', () => {
  function tinyGzip() {
    const document = {
      version: 2,
      generated_at: '2026-11-11T00:00:00Z',
      count: 1,
      pending: '',
      entries: [{ key: 'Drums/kick.wav', size: 10, format: 'wav', pack: 'Kit', type: 'one-shot', category: 'kick', instrument: 'kick', genre: [], bpm: null, musical_key: '', root: 'C', note: 'C1', mood: [], tags: [], license: 'private', search: 'kick c' }],
    }
    const gzip = gzipSync(Buffer.from(JSON.stringify(document)))
    return gzip.buffer.slice(gzip.byteOffset, gzip.byteOffset + gzip.byteLength)
  }

  function fetchCatalog(gzip: ArrayBuffer, signStatus = 200): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/library/sign')) {
        if (signStatus === 401) return new Response(JSON.stringify({ error: 'That passphrase does not unlock the library.' }), { status: 401 })
        return new Response(JSON.stringify({ expiresIn: 900, urls: [{ key: 'catalog/catalog.json.gz', url: 'https://library.test/catalog.json.gz' }] }), { status: 200 })
      }
      return new Response(gzip)
    }) as typeof fetch
  }

  it('stores the catalog hash and skips a second parse when the file is unchanged', async () => {
    const gzip = tinyGzip()
    const slot: { current: CachedCatalog | null } = { current: null }
    const cache = memoryCatalogCache(slot)
    writeLibraryAccessKey('owner-pass')
    const first = await loadLibraryCatalog(fetchCatalog(gzip), cache)
    expect(first.fromCache).toBe(false)
    expect(slot.current?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(catalogCacheFields(slot.current!).sha256).toBe(slot.current?.sha256)
    const second = await loadLibraryCatalog(fetchCatalog(gzip), cache)
    expect(second.fromCache).toBe(true)
    expect(second.document.version).toBe(2)
    if (slot.current) slot.current = { ...slot.current, sha256: undefined }
    const refreshed = await loadLibraryCatalog(fetchCatalog(gzip), cache)
    expect(refreshed.fromCache).toBe(false)
    clearLibraryAccessKey()
    setLibraryCaches({ catalog: null })
  })

  it('does not reveal a cached catalog when the passphrase is wrong', async () => {
    const gzip = tinyGzip()
    const cache = memoryCatalogCache()
    await cache.write({ version: 2, generatedAt: '2026-11-11T00:00:00Z', count: 1, sha256: 'abc', gzip })
    writeLibraryAccessKey('wrong')
    let shown = 0
    await expect(loadLibraryCatalog(fetchCatalog(gzip, 401), cache, () => { shown += 1 })).rejects.toBeInstanceOf(LibraryAuthError)
    expect(shown).toBe(0)
    expect(readLibraryAccessKey()).toBe('')
    await expect(loadLibraryCatalog(fetchCatalog(gzip), cache)).rejects.toThrow(/Unlock/)
    setLibraryCaches({ catalog: null })
  })

  it('keeps a signed URL whose path contains the passphrase', async () => {
    expect(signedUrlKeepsSecret('https://x.example/Drums/wav/kick.wav?X-Amz-Signature=abcd', 'wav')).toBe(true)
    expect(signedUrlKeepsSecret('https://x.example/a.wav?token=wav', 'wav')).toBe(false)
    expect(signedUrlKeepsSecret('https://wav:hidden@x.example/a.wav', 'wav')).toBe(false)
    const signed = await signLibraryKeys(['Drums/wav/kick.wav'], 'wav', (async () => new Response(JSON.stringify({
      expiresIn: 900,
      urls: [{ key: 'Drums/wav/kick.wav', url: 'https://x.example/Drums/wav/kick.wav?X-Amz-Signature=abcd' }],
    }), { status: 200 })) as typeof fetch)
    expect(signed.urls.map((item) => item.key)).toEqual(['Drums/wav/kick.wav'])
  })

  it('rates limits by the Cloudflare client address, not a forged forwarding header', () => {
    expect(libraryClientIp({ 'x-forwarded-for': '1.2.3.4', 'cf-connecting-ip': '5.6.7.8' }, '10.0.0.1')).toBe('5.6.7.8')
    expect(libraryClientIp({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }, '10.0.0.1')).toBe('10.0.0.1')
    expect(libraryClientIp({ 'true-client-ip': '8.8.4.4', 'x-forwarded-for': '1.1.1.1' })).toBe('8.8.4.4')
    const window = libraryRowWindow(91_800, 7000, 390, 70)
    expect(window.end).toBeLessThan(200)
    expect(window.end - window.start).toBeLessThan(40)
    expect(libraryRowWindow(91_800, 0, 5_000_000, 70).end).toBeLessThan(120)
  })
})

import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { browseLibraryRows } from '../library/browse'
import { LIBRARY_ADDITIONS_KEY as CLIENT_ADDITIONS_KEY, LIBRARY_CATALOG_KEY as CLIENT_CATALOG_KEY, indexParsedCatalog, memoryCatalogCache, parseLibraryCatalog } from '../library/catalog'
import { clearLibraryAccessKey, writeLibraryAccessKey } from '../library/access'
import { loadLibraryCatalog, setLibraryCaches } from '../library/audio'
import { buildFastRows, classifyDrum, nearSongWindow } from '../library/fastBrowse'
import { entryMatchesFilters, searchLibrary } from '../library/search'
import { EMPTY_LIBRARY_QUERY } from '../library/types'
import { encodeWav } from '../model/wav'
import { createEmptyProject } from '../model/types'
import { placeSound } from '../sounds/place'
import { createLibraryApi, LIBRARY_ADDITIONS_KEY, LIBRARY_CATALOG_KEY, LIBRARY_NOT_READY, libraryCatalogWriteKey, presignR2Put, type LibraryEnv, type LibraryObjects } from '../../server/library.ts'
import { syntheticLibrary } from './libraryCatalogFixture'
import { LibraryAddSounds } from '../ui/MyLibrary'
import {
  LIBRARY_AUDIO_PREFIX,
  LIBRARY_UPLOAD_MAX_BYTES,
  catalogEntryForUpload,
  libraryAudioKey,
  readWavFacts,
  uploadLibraryWavs,
} from '../library/upload'
// @ts-expect-error the upload script is plain JavaScript and has no declaration file
import { formatCounts, uploadFolder } from '../../scripts/library-upload.mjs'

const env: LibraryEnv = {
  R2_ACCOUNT_ID: '2001009ff8860d62eac085ee8cce34e2',
  R2_BUCKET: 'cueharbor-private-sounds',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretsecretsecretsecretsecret12',
  LIBRARY_ACCESS_KEY: 'owner-pass',
}

function wire(key: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    size: 128,
    format: 'wav',
    pack: 'Uploads',
    type: 'one-shot',
    category: 'bass',
    instrument: 'bass',
    genre: [],
    bpm: null,
    bpm_alt: null,
    musical_key: 'A minor',
    root: null,
    note: null,
    chord: null,
    mood: [],
    tags: ['upload'],
    license: 'upload',
    search: 'bass upload',
    ...extra,
  }
}

function memoryObjects(seed?: Record<string, unknown>, options?: { conflictOnce?: boolean; omitGetEtag?: boolean; headEtag?: boolean }) {
  const objects = new Map<string, Uint8Array>()
  const etags = new Map<string, string>()
  const calls: string[] = []
  let token = 1
  let conflictArmed = Boolean(options?.conflictOnce)
  const mint = () => {
    token += 1
    return `"${token}"`
  }
  if (seed) {
    objects.set('catalog/catalog.json.gz', gzipSync(Buffer.from(JSON.stringify(seed))))
    etags.set('catalog/catalog.json.gz', '"1"')
  }
  const api: LibraryObjects = {
    async get(key) {
      calls.push(`get ${key}`)
      const bytes = objects.get(key)
      if (!bytes) return { status: 404, bytes: null, etag: null }
      return { status: 200, bytes, etag: options?.omitGetEtag ? null : (etags.get(key) ?? null) }
    },
    async put(key, bytes, _contentType, conditions) {
      const match = conditions?.ifMatch ? ` if-match ${conditions.ifMatch}` : ''
      const none = conditions?.ifNoneMatch ? ` if-none-match ${conditions.ifNoneMatch}` : ''
      if (conflictArmed && key === LIBRARY_ADDITIONS_KEY) {
        conflictArmed = false
        calls.push(`put ${key} conflict`)
        const current = objects.has(key)
          ? JSON.parse(Buffer.from(objects.get(key)!).toString('utf8')) as { entries: unknown[]; count: number; version: number }
          : { version: 1, generated_at: '', count: 0, entries: [] as unknown[] }
        current.entries.push(wire('audio/bass/racer.wav', { size: 8 }))
        current.count = current.entries.length
        current.version = 9
        objects.set(key, Buffer.from(JSON.stringify(current)))
        etags.set(key, mint())
        throw new Error('catalog-conflict')
      }
      if (conditions?.ifMatch && etags.get(key) !== conditions.ifMatch) {
        calls.push(`put ${key}${match}${none}`)
        throw new Error('catalog-conflict')
      }
      if (conditions?.ifNoneMatch === '*' && etags.has(key)) {
        calls.push(`put ${key}${match}${none}`)
        throw new Error('catalog-conflict')
      }
      calls.push(`put ${key}${match}${none}`)
      objects.set(key, bytes.slice())
      etags.set(key, mint())
    },
    async copy(from, to, conditions) {
      const match = conditions?.ifMatch ? ` if-match ${conditions.ifMatch}` : ''
      const none = conditions?.ifNoneMatch ? ` if-none-match ${conditions.ifNoneMatch}` : ''
      calls.push(`copy ${from} ${to}${match}${none}`)
      if (conditions?.ifMatch && etags.get(to) !== conditions.ifMatch) throw new Error('catalog-conflict')
      if (conditions?.ifNoneMatch === '*' && etags.has(to)) throw new Error('catalog-conflict')
      const bytes = objects.get(from)
      if (!bytes) throw new Error('missing')
      objects.set(to, bytes.slice())
      etags.set(to, mint())
    },
    async head(key) {
      return objects.has(key)
    },
  }
  if (options?.headEtag != null) {
    api.etag = async (key) => {
      calls.push(`head-etag ${key}`)
      if (!options.headEtag) return null
      return etags.get(key) ?? null
    }
  }
  return { objects, calls, api }
}

function readCatalog(bytes: Uint8Array) {
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as { version: number; generated_at: string; count: number; pending?: string; entries: Record<string, unknown>[]; note?: string }
}

function readJson(bytes: Uint8Array) {
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as { version: number; generated_at: string; count: number; entries: Record<string, unknown>[] }
}

function storedBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function silence(method: 'log' | 'error' | 'warn' | 'info') {
  const lines: string[] = []
  const original = console[method]
  console[method] = (...args: unknown[]) => { lines.push(args.map((item) => String(item)).join(' ')) }
  return {
    lines,
    restore() { console[method] = original },
  }
}

describe('library upload signing', () => {
  it('rejects a bad passphrase and does not sign or read the catalog', async () => {
    const store = memoryObjects()
    let signed = 0
    const api = createLibraryApi({
      env: () => env,
      signPut: async () => { signed += 1; return 'https://signed.example/a.wav' },
      objects: store.api,
    })
    const logs = (['log', 'error', 'warn', 'info'] as const).map((method) => silence(method))
    try {
      const denied = await api.handle({
        method: 'POST',
        pathname: '/api/library/upload-sign',
        ip: '9.9.9.9',
        accessKey: 'nope',
        body: { keys: [{ key: 'audio/bass/a.wav', size: 128 }] },
        now: 1_000,
      })
      const append = await api.handle({
        method: 'POST',
        pathname: '/api/library/catalog-append',
        ip: '9.9.9.9',
        accessKey: 'owner-passx',
        body: { entries: [wire('audio/bass/a.wav')] },
        now: 1_001,
      })
      expect(denied.status).toBe(401)
      expect(append.status).toBe(401)
      expect(signed).toBe(0)
      expect(store.calls).toEqual([])
      const printed = logs.flatMap((item) => item.lines).join('\n')
      expect(printed).not.toContain('owner-pass')
      expect(printed).not.toContain(env.R2_SECRET_ACCESS_KEY)
      expect(JSON.stringify(denied.body)).not.toContain('owner-pass')
      expect(JSON.stringify(append.body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    } finally {
      for (const item of logs) item.restore()
    }
  })

  it('rate-limits guesses against the upload route', async () => {
    const api = createLibraryApi({ env: () => env, signPut: async () => 'https://signed.example/a.wav', objects: memoryObjects().api })
    for (let n = 0; n < 8; n++) {
      const again = await api.handle({ method: 'POST', pathname: '/api/library/upload-sign', ip: '4.4.4.4', accessKey: 'nope', body: { keys: [{ key: 'audio/a.wav', size: 8 }] }, now: 2_000 + n })
      expect(again.status).toBe(401)
    }
    const locked = await api.handle({ method: 'POST', pathname: '/api/library/upload-sign', ip: '4.4.4.4', accessKey: 'owner-pass', body: { keys: [{ key: 'audio/a.wav', size: 8 }] }, now: 3_000 })
    expect(locked.status).toBe(429)
    const appendApi = createLibraryApi({ env: () => env, objects: memoryObjects().api })
    for (let n = 0; n < 8; n++) {
      const again = await appendApi.handle({ method: 'POST', pathname: '/api/library/catalog-append', ip: '5.5.5.5', accessKey: 'wrong-pass', body: { entries: [wire('audio/a.wav')] }, now: 4_000 + n })
      expect(again.status).toBe(401)
      expect(JSON.stringify(again.body)).not.toContain('wrong-pass')
    }
    const appendLocked = await appendApi.handle({ method: 'POST', pathname: '/api/library/catalog-append', ip: '5.5.5.5', accessKey: 'owner-pass', body: { entries: [wire('audio/a.wav')] }, now: 5_000 })
    expect(appendLocked.status).toBe(429)
  })

  it('rejects traversal, other prefixes, non-wav, and files over 60 MB', async () => {
    const signed: string[] = []
    const api = createLibraryApi({
      env: () => env,
      signPut: async (key) => { signed.push(key); return `https://signed.example/${encodeURIComponent(key)}` },
      objects: memoryObjects().api,
    })
    const bad = [
      '../secret.wav',
      'audio/../secret.wav',
      'audio/../../etc/passwd.wav',
      'audio/foo/../../../secret.wav',
      'audio//a.wav',
      '/audio/a.wav',
      'audio\\secret.wav',
      'audio/kick.mp3',
      'Drums/kick.wav',
      'catalog/secret.wav',
      'https://example.com/audio/a.wav',
      'audio/\uFF0E\uFF0E/secret.wav',
      'audio/bass/\uFF0F../secret.wav',
      'audio/%2e%2e/secret.wav',
      'audio/%2f../secret.wav',
      'audio/bass/\u202e.wav',
      'audio/bass/a\u0000.wav',
    ]
    for (const key of bad) {
      const result = await api.handle({
        method: 'POST',
        pathname: '/api/library/upload-sign',
        ip: '1.1.1.1',
        accessKey: 'owner-pass',
        body: { keys: [{ key, size: 128 }] },
        now: 4_000,
      })
      expect(result.status, key).toBe(400)
    }
    const huge = await api.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: [{ key: 'audio/bass/big.wav', size: LIBRARY_UPLOAD_MAX_BYTES + 1 }] },
      now: 4_001,
    })
    expect(huge.status).toBe(400)
    const tooMany = await api.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: Array.from({ length: 51 }, (_, n) => ({ key: `audio/bass/${n}.wav`, size: 8 })) },
      now: 4_002,
    })
    expect(tooMany.status).toBe(400)
    expect(signed).toEqual([])
    const ok = await api.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: [{ key: 'audio/bass/C#.wav', size: LIBRARY_UPLOAD_MAX_BYTES }] },
      now: 4_003,
    })
    expect(ok.status).toBe(200)
    expect(signed).toEqual(['audio/bass/C#.wav'])
    expect(JSON.stringify(ok.body)).not.toContain('owner-pass')
    expect(JSON.stringify(ok.body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    const removed = await api.handle({ method: 'DELETE', pathname: '/api/library/upload-sign', ip: '1.1.1.1', accessKey: 'owner-pass', body: null, now: 4_004 })
    expect(removed.status).toBe(405)
  })

  it('does not sign a PUT when the object exists or the head check fails', async () => {
    const store = memoryObjects()
    store.objects.set('audio/bass/a.wav', new Uint8Array([1, 2, 3]))
    let signed = 0
    const api = createLibraryApi({
      env: () => env,
      signPut: async () => { signed += 1; return 'https://signed.example/new.wav' },
      objects: store.api,
    })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: [{ key: 'audio/bass/a.wav', size: 3 }, { key: 'audio/bass/b.wav', size: 3 }] },
      now: 8_000,
    })
    expect(result.status).toBe(200)
    const urls = result.body.urls as { key: string; url: string; exists: boolean }[]
    expect(urls[0]).toEqual({ key: 'audio/bass/a.wav', url: '', exists: true })
    expect(urls[1]).toMatchObject({ key: 'audio/bass/b.wav', exists: false })
    expect(urls[1].url).toBe('https://signed.example/new.wav')
    expect(signed).toBe(1)
    expect(JSON.stringify(result.body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    let failed = 0
    const blind = createLibraryApi({
      env: () => env,
      signPut: async () => { failed += 1; return 'https://signed.example/nope.wav' },
      objects: { ...store.api, head: async () => { throw new Error('head failed') } },
    })
    const blocked = await blind.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: [{ key: 'audio/bass/b.wav', size: 3 }] },
      now: 8_001,
    })
    expect(blocked.status).toBe(503)
    expect(failed).toBe(0)
    const open = createLibraryApi({
      env: () => env,
      signPut: async () => { failed += 1; return 'https://signed.example/nope.wav' },
      objects: { get: store.api.get, put: store.api.put, copy: store.api.copy },
    })
    const unsigned = await open.handle({
      method: 'POST',
      pathname: '/api/library/upload-sign',
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: [{ key: 'audio/bass/b.wav', size: 3 }] },
      now: 8_002,
    })
    expect(unsigned.status).toBe(503)
    expect(failed).toBe(0)
  })

  it('presigns a PUT that binds content type, size, and create-only, and leaves the secret out of the URL', async () => {
    const put = new URL(await presignR2Put(env, `${LIBRARY_AUDIO_PREFIX}bass/C#.wav`, 128))
    const larger = new URL(await presignR2Put(env, `${LIBRARY_AUDIO_PREFIX}bass/C#.wav`, 256))
    const signedHeaders = put.searchParams.get('X-Amz-SignedHeaders') ?? ''
    expect(put.host).toBe('2001009ff8860d62eac085ee8cce34e2.r2.cloudflarestorage.com')
    expect(decodeURIComponent(put.pathname)).toContain('audio/bass/C#.wav')
    expect(put.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(signedHeaders.split(';')).toEqual(expect.arrayContaining(['content-type', 'content-length', 'if-none-match']))
    expect(put.searchParams.get('X-Amz-Signature')).not.toBe(larger.searchParams.get('X-Amz-Signature'))
    expect(put.toString()).not.toContain(env.R2_SECRET_ACCESS_KEY)
    expect(put.toString()).not.toContain('owner-pass')
    await expect(presignR2Put(env, 'Drums/kick.wav', 128)).rejects.toThrow(LIBRARY_NOT_READY)
    await expect(presignR2Put(env, 'audio/bass/a.wav', LIBRARY_UPLOAD_MAX_BYTES + 1)).rejects.toThrow(LIBRARY_NOT_READY)
    expect(libraryAudioKey('audio/../x.wav')).toBeNull()
    expect(libraryAudioKey('audio/\uFF0E\uFF0E/x.wav')).toBeNull()
    expect(libraryCatalogWriteKey('catalog/catalog.json.gz')).toBe('catalog/catalog.json.gz')
    expect(libraryCatalogWriteKey('audio/bass/a.wav')).toBeNull()
    expect(libraryCatalogWriteKey('catalog/../audio/a.wav')).toBeNull()
  })

  it('hides upload when the server is not configured', async () => {
    let signed = 0
    const api = createLibraryApi({ env: () => ({ ...env, LIBRARY_ACCESS_KEY: '' }), signPut: async () => { signed += 1; return 'https://signed.example/a' } })
    const denied = await api.handle({ method: 'POST', pathname: '/api/library/catalog-append', ip: '1.1.1.1', accessKey: 'owner-pass', body: { entries: [wire('audio/a.wav')] }, now: 1 })
    expect(denied.status).toBe(503)
    expect(denied.body).toEqual({ ready: false, message: LIBRARY_NOT_READY })
    expect(signed).toBe(0)
  })
})

describe('library catalog append', () => {
  const existing = {
    version: 4,
    generated_at: '2026-11-11T00:00:00Z',
    count: 2,
    pending: 'later',
    note: 'keep me',
    entries: [
      { key: 'Drums/kick.wav', size: 10, format: 'wav', pack: 'Kit', type: 'one-shot', category: 'kick', bpm_source: 'label', extra: 'stay', search: 'kick' },
      { key: 'Bass/old.wav', size: 20, format: 'wav', pack: 'Finger Bass', type: 'one-shot', category: 'bass', search: 'bass' },
    ],
  }

  it('appends into the sidecar and leaves the base catalog unread', async () => {
    const store = memoryObjects(existing)
    const base = store.objects.get(LIBRARY_CATALOG_KEY)!
    const baseCopy = base.slice()
    const api = createLibraryApi({ env: () => env, objects: store.api, signPut: async () => 'https://signed.example/nope' })
    const added = wire('audio/bass/new.wav', { size: 64, sample_rate: 48000, bit_depth: 24, channels: 1 })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [added] },
      now: Date.parse('2026-11-24T21:00:00.000Z'),
    })
    expect(result.status).toBe(200)
    expect(result.body.added).toBe(1)
    expect(result.body.skipped).toBe(0)
    expect(result.body.version).toBe(1)
    expect(result.body.count).toBe(1)
    expect(JSON.stringify(result.body)).not.toContain('owner-pass')
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(Buffer.from(baseCopy))).toBe(true)
    const baseDoc = readCatalog(store.objects.get(LIBRARY_CATALOG_KEY)!)
    expect(baseDoc.pending).toBe('later')
    expect(baseDoc.note).toBe('keep me')
    expect(baseDoc.entries).toHaveLength(2)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.generated_at).toBe('2026-11-24T21:00:00.000Z')
    expect(sidecar.count).toBe(1)
    expect(sidecar.entries[0]).toMatchObject({ key: 'audio/bass/new.wav', bit_depth: 24, category: 'bass' })
    const backupKey = [...store.objects.keys()].find((key) => key.startsWith('catalog/backups/'))
    const tempKey = [...store.objects.keys()].find((key) => key.startsWith('catalog/tmp/'))
    expect(backupKey).toBeTruthy()
    expect(tempKey).toBeTruthy()
    expect(readJson(store.objects.get(backupKey!)!).entries).toHaveLength(1)
    expect(store.calls).toEqual([
      `get ${LIBRARY_ADDITIONS_KEY}`,
      `put ${tempKey}`,
      `copy ${tempKey} ${backupKey}`,
      `put ${LIBRARY_ADDITIONS_KEY} if-none-match *`,
    ])
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
  })

  it('keeps a row written by someone else when the sidecar etag moves', async () => {
    const store = memoryObjects(existing, { conflictOnce: true })
    const base = store.objects.get(LIBRARY_CATALOG_KEY)!.slice()
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/new.wav', { size: 64 })] },
      now: Date.parse('2026-11-24T21:10:00.000Z'),
    })
    expect(result.status).toBe(200)
    expect(result.body.added).toBe(1)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual(['audio/bass/racer.wav', 'audio/bass/new.wav'])
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(Buffer.from(base))).toBe(true)
    expect(store.calls.some((call) => call.includes('conflict'))).toBe(true)
    expect(store.calls.filter((call) => call.includes(`${LIBRARY_ADDITIONS_KEY} if-match`)).length).toBe(1)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
  })

  it('serializes two appends so neither row disappears', async () => {
    const store = memoryObjects(existing)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const [first, second] = await Promise.all([
      api.handle({ method: 'POST', pathname: '/api/library/catalog-append', ip: '8.8.8.8', accessKey: 'owner-pass', body: { entries: [wire('audio/bass/a.wav', { size: 8 })] }, now: 6_000 }),
      api.handle({ method: 'POST', pathname: '/api/library/catalog-append', ip: '8.8.8.8', accessKey: 'owner-pass', body: { entries: [wire('audio/bass/b.wav', { size: 8 })] }, now: 6_001 }),
    ])
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect((first.body.added as number) + (second.body.added as number)).toBe(2)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual(['audio/bass/a.wav', 'audio/bass/b.wav'])
    expect(readCatalog(store.objects.get(LIBRARY_CATALOG_KEY)!).entries).toHaveLength(2)
  })

  it('creates a missing sidecar only when nothing else landed first', async () => {
    const store = memoryObjects()
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/first.wav', { size: 8 })] },
      now: Date.parse('2026-11-24T21:12:00.000Z'),
    })
    expect(result.status).toBe(200)
    expect(result.body.added).toBe(1)
    expect(store.calls.some((call) => call.includes('if-none-match *'))).toBe(true)
    expect(store.objects.has(LIBRARY_CATALOG_KEY)).toBe(false)
    expect(readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!).entries).toHaveLength(1)
  })

  it('leaves the sidecar untouched when neither GET nor HEAD yields an etag', async () => {
    const store = memoryObjects(existing, { omitGetEtag: true, headEtag: false })
    const base = Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!)
    const prior = Buffer.from(JSON.stringify({
      version: 2,
      generated_at: '2026-11-11T00:00:00.000Z',
      count: 1,
      entries: [wire('audio/bass/kept.wav', { size: 8 })],
    }))
    store.objects.set(LIBRARY_ADDITIONS_KEY, prior)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/new.wav', { size: 64 })] },
      now: Date.parse('2026-11-24T21:14:00.000Z'),
    })
    expect(result.status).toBe(503)
    expect(Buffer.from(store.objects.get(LIBRARY_ADDITIONS_KEY)!).equals(prior)).toBe(true)
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(base)).toBe(true)
    expect(readJson(prior).entries.map((entry) => entry.key)).toEqual(['audio/bass/kept.wav'])
    expect(store.calls.some((call) => call.startsWith('put'))).toBe(false)
    expect(store.calls.some((call) => call.startsWith('head-etag'))).toBe(true)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
  })

  it('appends a second and third time when GET omits the etag and HEAD still has it', async () => {
    const store = memoryObjects(existing, { omitGetEtag: true, headEtag: true })
    const base = Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const now = Date.parse('2026-11-24T21:20:00.000Z')
    const first = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/one.wav', { size: 8 })] },
      now,
    })
    const second = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/two.wav', { size: 8 })] },
      now: now + 1,
    })
    const third = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/three.wav', { size: 8 })] },
      now: now + 2,
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(200)
    expect(first.body.added).toBe(1)
    expect(second.body.added).toBe(1)
    expect(third.body.added).toBe(1)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual(['audio/bass/one.wav', 'audio/bass/two.wav', 'audio/bass/three.wav'])
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(base)).toBe(true)
    const livePuts = store.calls.filter((call) => call.startsWith(`put ${LIBRARY_ADDITIONS_KEY}`))
    expect(livePuts[0]).toContain('if-none-match *')
    expect(livePuts.slice(1).every((call) => /if-match "[^"]+"/.test(call))).toBe(true)
    expect(livePuts.slice(1).some((call) => call.includes('if-none-match'))).toBe(false)
    expect(store.calls.some((call) => call.startsWith('head-etag'))).toBe(true)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
    expect(JSON.stringify([first.body, second.body, third.body])).not.toContain('owner-pass')
  })

  it('retries a 412 after recovering the etag from HEAD', async () => {
    const store = memoryObjects(existing, { conflictOnce: true, omitGetEtag: true, headEtag: true })
    const base = Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/new.wav', { size: 64 })] },
      now: Date.parse('2026-11-24T21:22:00.000Z'),
    })
    expect(result.status).toBe(200)
    expect(result.body.added).toBe(1)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual(['audio/bass/racer.wav', 'audio/bass/new.wav'])
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(base)).toBe(true)
    expect(store.calls.some((call) => call.includes('conflict'))).toBe(true)
    expect(store.calls.filter((call) => call.includes(`${LIBRARY_ADDITIONS_KEY} if-match`)).length).toBe(1)
    expect(store.calls.some((call) => call.startsWith('head-etag'))).toBe(true)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
  })

  it('reads a missing R2 etag from HEAD and still conditions the second and third append', async () => {
    const bucket = env.R2_BUCKET!
    const objects = new Map<string, Uint8Array>()
    const etags = new Map<string, string>()
    const calls: string[] = []
    let token = 1
    let conflict = true
    const mint = () => {
      token += 1
      return `"${token}"`
    }
    const keyFromPath = (path: string) => {
      const decoded = decodeURIComponent(path).replace(/^\/+/, '')
      const slash = decoded.indexOf('/')
      return slash === -1 ? decoded : decoded.slice(slash + 1)
    }
    const fetchImpl: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(String(input))
      const key = keyFromPath(new URL(request.url).pathname)
      const method = request.method
      if (request.url.includes(env.R2_SECRET_ACCESS_KEY!) || request.url.includes('owner-pass')) {
        return new Response('secret', { status: 500 })
      }
      if (method === 'GET' || method === 'HEAD') {
        calls.push(`${method} ${key} encoding ${request.headers.get('accept-encoding') ?? ''}`)
        const tag = etags.get(key) ?? null
        if (!objects.has(key)) return new Response('missing', { status: 404 })
        if (method === 'HEAD') {
          return new Response(null, { status: tag ? 200 : 404, headers: tag ? { etag: tag } : undefined })
        }
        // The stored object has an ETag, but this GET drops it the way R2 did.
        return new Response(storedBody(objects.get(key)!), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if (method === 'PUT') {
        const copy = request.headers.get('x-amz-copy-source')
        const ifMatch = request.headers.get('if-match')
        const ifNone = request.headers.get('if-none-match')
        calls.push(`PUT ${key}${ifMatch ? ` if-match ${ifMatch}` : ''}${ifNone ? ` if-none-match ${ifNone}` : ''}${copy ? ' copy' : ''}`)
        if (copy) {
          const source = keyFromPath(copy)
          const bytes = objects.get(source)
          if (!bytes) return new Response('missing', { status: 404 })
          objects.set(key, bytes.slice())
          etags.set(key, mint())
          return new Response('<CopyObjectResult/>', { status: 200 })
        }
        const body = new Uint8Array(await request.arrayBuffer())
        if (conflict && key === LIBRARY_ADDITIONS_KEY && ifMatch) {
          conflict = false
          const current = JSON.parse(Buffer.from(objects.get(key)!).toString('utf8')) as { entries: unknown[]; count: number; version: number }
          current.entries.push(wire('audio/bass/racer.wav', { size: 8 }))
          current.count = current.entries.length
          current.version += 1
          objects.set(key, Buffer.from(JSON.stringify(current)))
          etags.set(key, mint())
          return new Response(null, { status: 412 })
        }
        if (ifMatch && etags.get(key) !== ifMatch) return new Response(null, { status: 412 })
        if (ifNone === '*' && objects.has(key)) return new Response(null, { status: 412 })
        objects.set(key, body)
        etags.set(key, mint())
        return new Response(null, { status: 200, headers: { etag: etags.get(key)! } })
      }
      return new Response('no', { status: 405 })
    }
    const api = createLibraryApi({ env: () => env, fetch: fetchImpl })
    const now = Date.parse('2026-11-24T21:30:00.000Z')
    const append = (name: string, at: number) => api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire(`audio/bass/${name}.wav`, { size: 8 })] },
      now: at,
    })
    const first = await append('one', now)
    const second = await append('two', now + 1)
    const third = await append('three', now + 2)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(third.status).toBe(200)
    expect(first.body.added).toBe(1)
    expect(second.body.added).toBe(1)
    expect(third.body.added).toBe(1)
    const sidecar = readJson(objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual([
      'audio/bass/one.wav',
      'audio/bass/racer.wav',
      'audio/bass/two.wav',
      'audio/bass/three.wav',
    ])
    const live = calls.filter((call) => call.startsWith(`PUT ${LIBRARY_ADDITIONS_KEY}`))
    expect(live[0]).toContain('if-none-match *')
    expect(live.filter((call) => call.includes('if-match')).length).toBeGreaterThanOrEqual(2)
    expect(live.slice(1).every((call) => call.includes('if-match'))).toBe(true)
    expect(calls.some((call) => call.startsWith(`HEAD ${LIBRARY_ADDITIONS_KEY} encoding identity`))).toBe(true)
    expect(calls.some((call) => call.startsWith(`GET ${LIBRARY_ADDITIONS_KEY} encoding identity`))).toBe(true)
    expect(calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
    expect(calls.join('\n')).not.toContain(env.R2_SECRET_ACCESS_KEY)
    expect(JSON.stringify([first.body, second.body, third.body])).not.toContain('owner-pass')
    expect(bucket).toBe('cueharbor-private-sounds')
  })

  it('keeps a strong GET etag and replaces a weak one with the HEAD etag', async () => {
    const objects = new Map<string, Uint8Array>()
    const etags = new Map<string, string>()
    const calls: string[] = []
    let token = 1
    const mint = () => `"${token += 1}"`
    let weak = false
    const keyFromPath = (path: string) => {
      const decoded = decodeURIComponent(path).replace(/^\/+/, '')
      const slash = decoded.indexOf('/')
      return slash === -1 ? decoded : decoded.slice(slash + 1)
    }
    const fetchImpl: typeof fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(String(input))
      const key = keyFromPath(new URL(request.url).pathname)
      const method = request.method
      calls.push(`${method} ${key}`)
      if (method === 'HEAD') {
        const tag = etags.get(key)
        if (!tag) return new Response(null, { status: 404 })
        return new Response(null, { status: 200, headers: { ETag: tag } })
      }
      if (method === 'GET') {
        const bytes = objects.get(key)
        if (!bytes) return new Response('missing', { status: 404 })
        const headers = new Headers({ 'content-type': 'application/json' })
        const tag = etags.get(key)
        if (tag) headers.set('etag', weak ? `W/${tag}` : tag)
        return new Response(storedBody(bytes), { status: 200, headers })
      }
      if (method === 'PUT') {
        const copy = request.headers.get('x-amz-copy-source')
        const ifMatch = request.headers.get('if-match')
        const ifNone = request.headers.get('if-none-match')
        if (copy) {
          const source = keyFromPath(copy)
          const bytes = objects.get(source)
          if (!bytes) return new Response('missing', { status: 404 })
          objects.set(key, bytes.slice())
          etags.set(key, mint())
          return new Response(null, { status: 200 })
        }
        const body = new Uint8Array(await request.arrayBuffer())
        if (ifMatch && etags.get(key) !== ifMatch) return new Response(null, { status: 412 })
        if (ifNone === '*' && objects.has(key)) return new Response(null, { status: 412 })
        objects.set(key, body)
        etags.set(key, mint())
        calls.push(`stored ${key} ${ifMatch ?? ifNone ?? 'open'}`)
        return new Response(null, { status: 200 })
      }
      return new Response('no', { status: 405 })
    }
    const api = createLibraryApi({ env: () => env, fetch: fetchImpl })
    const now = Date.parse('2026-11-24T21:40:00.000Z')
    const created = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/strong.wav', { size: 8 })] },
      now,
    })
    expect(created.status).toBe(200)
    const beforeHead = calls.filter((call) => call.startsWith('HEAD')).length
    const matched = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/next.wav', { size: 8 })] },
      now: now + 1,
    })
    expect(matched.status).toBe(200)
    expect(calls.filter((call) => call.startsWith('HEAD')).length).toBe(beforeHead)
    const strongPut = calls.find((call) => call.startsWith('stored catalog/catalog-additions.json "'))
    expect(strongPut).toBeTruthy()
    expect(strongPut).not.toContain('W/')
    weak = true
    const weakened = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/after-weak.wav', { size: 8 })] },
      now: now + 2,
    })
    expect(weakened.status).toBe(200)
    expect(calls.filter((call) => call.startsWith('HEAD')).length).toBeGreaterThan(beforeHead)
    const sidecar = readJson(objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries.map((entry) => entry.key)).toEqual([
      'audio/bass/strong.wav',
      'audio/bass/next.wav',
      'audio/bass/after-weak.wav',
    ])
    expect(calls.join('\n')).not.toContain('owner-pass')
  })

  it('dedupes by key and leaves the stored row untouched', async () => {
    const store = memoryObjects(existing)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const first = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/new.wav', { size: 64 }), wire('audio/bass/new.wav', { size: 99 })] },
      now: Date.parse('2026-11-24T21:05:00.000Z'),
    })
    expect(first.body.added).toBe(1)
    expect(first.body.skipped).toBe(1)
    const again = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/bass/new.wav', { size: 999, pack: 'Replaced' })] },
      now: Date.parse('2026-11-24T21:06:00.000Z'),
    })
    expect(again.status).toBe(200)
    expect(again.body.added).toBe(0)
    expect(again.body.skipped).toBe(1)
    expect(again.body.version).toBe(1)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries).toHaveLength(1)
    expect(sidecar.entries[0]).toMatchObject({ key: 'audio/bass/new.wav', size: 64, pack: 'Uploads' })
    expect(readCatalog(store.objects.get(LIBRARY_CATALOG_KEY)!).entries[0]).toMatchObject({ key: 'Drums/kick.wav', extra: 'stay' })
    expect(store.calls.filter((call) => call.startsWith('put catalog/tmp/'))).toHaveLength(1)
    expect(store.calls.filter((call) => call.startsWith(`put ${LIBRARY_ADDITIONS_KEY}`))).toHaveLength(1)
  })

  it('refuses a catalog row that escapes the audio prefix and does not write', async () => {
    const store = memoryObjects(existing)
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const blocked = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: [wire('audio/../../secret.wav'), wire('audio/bass/ok.wav')] },
      now: 5_000,
    })
    expect(blocked.status).toBe(400)
    expect(store.calls).toEqual([])
    expect(store.objects.size).toBe(1)
  })

  it('appends 110 rows onto a 100k catalog without reading or rewriting the base', async () => {
    const store = memoryObjects(syntheticLibrary(100_000))
    const base = store.objects.get(LIBRARY_CATALOG_KEY)!
    const baseCopy = base.slice()
    const api = createLibraryApi({ env: () => env, objects: store.api })
    const rows = Array.from({ length: 110 }, (_, index) => wire(`audio/bass/add-${index}.wav`, { size: 32 + index, type: 'loop', bpm: 100 }))
    rows.push(wire('audio/bass/add-0.wav', { size: 999 }))
    const result = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: rows },
      now: Date.parse('2026-11-24T22:00:00.000Z'),
    })
    expect(result.status).toBe(200)
    expect(result.body.added).toBe(110)
    expect(result.body.skipped).toBe(1)
    expect(result.body.count).toBe(110)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
    expect(store.calls.filter((call) => call.startsWith('get '))).toEqual([`get ${LIBRARY_ADDITIONS_KEY}`])
    expect(Buffer.from(store.objects.get(LIBRARY_CATALOG_KEY)!).equals(Buffer.from(baseCopy))).toBe(true)
    const sidecar = readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!)
    expect(sidecar.entries).toHaveLength(110)
    expect(sidecar.entries[0]).toMatchObject({ key: 'audio/bass/add-0.wav', size: 32 })
    const again = await api.handle({
      method: 'POST',
      pathname: '/api/library/catalog-append',
      ip: '8.8.8.8',
      accessKey: 'owner-pass',
      body: { entries: rows.slice(0, 110) },
      now: Date.parse('2026-11-24T22:05:00.000Z'),
    })
    expect(again.status).toBe(200)
    expect(again.body.added).toBe(0)
    expect(again.body.skipped).toBe(110)
    expect(readJson(store.objects.get(LIBRARY_ADDITIONS_KEY)!).entries).toHaveLength(110)
    expect(store.calls.some((call) => call.includes(LIBRARY_CATALOG_KEY))).toBe(false)
  }, 60_000)
})

describe('phone wav upload', () => {
  it('sends the original 24-bit bytes and builds a bass row', async () => {
    const wav = encodeWav([new Float32Array([0.25, -0.5, 0.25])], 48000, { bits: 24 })
    expect(readWavFacts(wav)?.bits).toBe(24)
    const puts: { url: string; bytes: ArrayBuffer }[] = []
    let appended: unknown[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/library/upload-sign')) {
        const body = JSON.parse(String(init?.body)) as { keys: { key: string; size: number }[] }
        expect(init?.headers).toMatchObject({ 'x-library-key': 'owner-pass' })
        return new Response(JSON.stringify({ urls: body.keys.map((item) => ({ key: item.key, url: `https://signed.example/${encodeURIComponent(item.key)}`, exists: false })) }), { status: 200 })
      }
      if (url.startsWith('https://signed.example/')) {
        expect(new Headers(init?.headers).get('content-type')).toBe('audio/wav')
        expect(new Headers(init?.headers).get('content-length')).toBe(String((init?.body as ArrayBuffer).byteLength))
        expect(new Headers(init?.headers).get('if-none-match')).toBe('*')
        puts.push({ url, bytes: init?.body as ArrayBuffer })
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/api/library/catalog-append')) {
        appended = (JSON.parse(String(init?.body)) as { entries: unknown[] }).entries
        return new Response(JSON.stringify({ added: appended.length, skipped: 0 }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }) as typeof fetch
    const counts = await uploadLibraryWavs({
      files: [{ name: 'Finger Bass.wav', size: wav.byteLength, bytes: wav }],
      category: 'Bass',
      bpm: null,
      musicalKey: 'A minor',
      accessKey: 'owner-pass',
      fetchImpl,
    })
    expect(counts).toEqual({ uploaded: 1, skipped: 0, added: 1, failed: 0 })
    expect(puts).toHaveLength(1)
    expect(puts[0].bytes.byteLength).toBe(wav.byteLength)
    expect(new Uint8Array(puts[0].bytes)).toEqual(new Uint8Array(wav))
    expect(readWavFacts(puts[0].bytes)?.bits).toBe(24)
    expect(appended[0]).toMatchObject({ key: 'audio/bass/Finger Bass.wav', bit_depth: 24, category: 'bass', type: 'one-shot', license: 'upload' })
    const floatWav = encodeWav([new Float32Array([0.25, -0.5, 0.125])], 48000, { bits: 32 })
    expect(readWavFacts(floatWav)?.bits).toBe(32)
    const floatCounts = await uploadLibraryWavs({
      files: [{ name: 'Float Bass.wav', size: floatWav.byteLength, bytes: floatWav }],
      category: 'bass',
      bpm: 120,
      musicalKey: 'C major',
      accessKey: 'owner-pass',
      fetchImpl,
    })
    expect(floatCounts.uploaded).toBe(1)
    expect(new Uint8Array(puts.at(-1)!.bytes)).toEqual(new Uint8Array(floatWav))
    expect(readWavFacts(puts.at(-1)!.bytes)?.bits).toBe(32)
    expect(appended.at(-1)).toMatchObject({ key: 'audio/bass/Float Bass.wav', bit_depth: 32, category: 'bass', type: 'loop' })
    const mp3 = await uploadLibraryWavs({
      files: [{ name: 'nope.mp3', size: 4, bytes: new Uint8Array([1, 2, 3, 4]).buffer }],
      category: 'bass',
      bpm: null,
      musicalKey: '',
      accessKey: 'owner-pass',
      fetchImpl,
    })
    expect(mp3.failed).toBe(1)
    expect(mp3.uploaded).toBe(0)
    const skippedPuts: string[] = []
    let appendedKeys: string[] = []
    const skipFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/library/upload-sign')) {
        return new Response(JSON.stringify({ urls: [
          { key: 'audio/bass/Finger Bass.wav', url: '', exists: true },
          { key: 'audio/bass/Other.wav', url: 'https://huggingface.co/datasets/cueharbor/sound-library/resolve/main/x.wav', exists: false },
        ] }), { status: 200 })
      }
      if (url.endsWith('/api/library/catalog-append')) {
        appendedKeys = (JSON.parse(String(init?.body)) as { entries: { key: string }[] }).entries.map((entry) => entry.key)
        return new Response(JSON.stringify({ added: appendedKeys.length, skipped: 0 }), { status: 200 })
      }
      skippedPuts.push(`${init?.method ?? 'GET'} ${url}`)
      return new Response('no', { status: 500 })
    }) as typeof fetch
    const skipped = await uploadLibraryWavs({
      files: [
        { name: 'Finger Bass.wav', size: wav.byteLength, bytes: wav },
        { name: 'Other.wav', size: wav.byteLength, bytes: wav },
      ],
      category: 'bass',
      bpm: 90,
      musicalKey: '',
      accessKey: 'owner-pass',
      fetchImpl: skipFetch,
    })
    expect(skipped.uploaded).toBe(0)
    expect(skipped.skipped).toBe(1)
    expect(skipped.failed).toBe(1)
    expect(skipped.added).toBe(1)
    expect(appendedKeys).toEqual(['audio/bass/Finger Bass.wav'])
    expect(skippedPuts.some((line) => line.startsWith('PUT'))).toBe(false)
    expect(appendedKeys.join(' ')).not.toContain('huggingface')
  })

  it('shows a small Add sounds control with category, BPM, and key', () => {
    const html = renderToStaticMarkup(createElement(LibraryAddSounds, {
      open: true,
      category: 'bass',
      bpm: '90',
      musicalKey: 'A minor',
      message: '',
      busy: false,
      fileRef: createRef<HTMLInputElement>(),
      onToggle: () => undefined,
      onCategory: () => undefined,
      onBpm: () => undefined,
      onKey: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(html).toContain('Add sounds')
    expect(html).toContain('library-add-btn')
    expect(html).toContain('aria-label="Sound category"')
    expect(html).toContain('placeholder="BPM"')
    expect(html).toContain('aria-label="Sound key"')
    expect(html).toContain('accept=".wav,audio/wav,audio/wave,audio/x-wav"')
    expect(html).toContain('value="bass"')
    const closed = renderToStaticMarkup(createElement(LibraryAddSounds, {
      open: false,
      category: '',
      bpm: '',
      musicalKey: '',
      message: '',
      busy: false,
      fileRef: createRef<HTMLInputElement>(),
      onToggle: () => undefined,
      onCategory: () => undefined,
      onBpm: () => undefined,
      onKey: () => undefined,
      onSubmit: () => undefined,
    }))
    expect(closed).toContain('Add sounds')
    expect(closed).not.toContain('aria-label="Sound category"')
    expect(catalogEntryForUpload({
      key: 'audio/bass/a.wav',
      size: 32,
      category: 'bass',
      bpm: 100,
      musicalKey: 'C',
      name: 'a',
      bits: 24,
      sampleRate: 48000,
      channels: 2,
    })?.type).toBe('loop')
  })
})

describe('bass shelves for uploaded loops and one-shots', () => {
  const document = {
    version: 1,
    generated_at: '2026-11-24T00:00:00Z',
    count: 3,
    pending: '',
    entries: [
      wire('audio/bass/Sub_120_C.wav', { size: 64, type: 'loop', bpm: 120, musical_key: 'C major', search: 'bass loop 120 c' }),
      wire('audio/bass/Sub_80_Am.wav', { size: 64, type: 'loop', bpm: 80, musical_key: 'A minor', search: 'bass loop 80 a' }),
      wire('audio/bass/Hit.wav', { size: 32, type: 'one-shot', bpm: null, musical_key: null, search: 'bass hit' }),
    ],
  }

  function sounds(type: 'loop' | 'one-shot') {
    const parsed = parseLibraryCatalog(document)
    expect(parsed).toBeTruthy()
    const index = indexParsedCatalog(parsed!)
    const query = { ...EMPTY_LIBRARY_QUERY, type }
    const rows = browseLibraryRows(index, searchLibrary(index, query), [], query)
    return rows.flatMap((row) => row.kind === 'sound' ? [row.entry] : [])
  }

  it('puts bass loops on the Loops shelf and bass hits on the one-shot shelf', () => {
    const loops = sounds('loop')
    const shots = sounds('one-shot')
    expect(loops.map((entry) => entry.key)).toEqual(['audio/bass/Sub_120_C.wav', 'audio/bass/Sub_80_Am.wav'])
    const loopShelf = buildFastRows({
      entries: loops,
      mode: 'loop',
      category: 'bass',
      sub: '',
      genre: '',
      sort: 'name',
      collapsed: new Set(),
      favoriteKeys: [],
      recentKeys: [],
    })
    expect(loopShelf.chips.find((chip) => chip.id === 'bass')).toMatchObject({ label: 'Bass', count: 2 })
    expect(loopShelf.rows.flatMap((row) => row.entry ? [row.entry.key] : [])).toEqual(['audio/bass/Sub_120_C.wav', 'audio/bass/Sub_80_Am.wav'])
    const shotShelf = buildFastRows({
      entries: shots,
      mode: 'drum',
      category: '',
      sub: '',
      genre: '',
      sort: 'name',
      collapsed: new Set(),
      favoriteKeys: [],
      recentKeys: [],
    })
    expect(shotShelf.chips.find((chip) => chip.id === 'bass')).toMatchObject({ label: 'Bass', count: 1 })
    const shotBass = buildFastRows({
      entries: shots,
      mode: 'drum',
      category: 'bass',
      sub: '',
      genre: '',
      sort: 'name',
      collapsed: new Set(),
      favoriteKeys: [],
      recentKeys: [],
    })
    expect(shotBass.rows.flatMap((row) => row.entry ? [row.entry.key] : [])).toEqual(['audio/bass/Hit.wav'])
    const drums = shots.filter((entry) => {
      const drum = classifyDrum(entry)
      return !!drum && drum.id !== 'bass'
    })
    expect(drums).toEqual([])
    const band = nearSongWindow(120)
    expect(loops.filter((entry) => entryMatchesFilters(entry, { ...EMPTY_LIBRARY_QUERY, type: 'loop', bpmMin: band.bpmMin, bpmMax: band.bpmMax })).map((entry) => entry.bpm)).toEqual([120])
    expect(loops.filter((entry) => entryMatchesFilters(entry, { ...EMPTY_LIBRARY_QUERY, type: 'loop', musicalKey: 'C major' })).map((entry) => entry.musicalKey)).toEqual(['C major'])
    const project = createEmptyProject(48000)
    const loop = placeSound({
      entry: { id: 'loop', path: loops[0].key, name: loops[0].name, type: 'loop', tags: loops[0].tags, bpm: loops[0].bpm ?? undefined, key: loops[0].musicalKey, durationSec: 1, sampleRate: 48000, license: 'upload', source: 'My Library', category: 'bass' },
      channels: [new Float32Array(4800)],
      fileRate: 48000,
      project,
      startSample: 0,
    })
    expect(loop?.clip.stretch?.followTempo).toBe(true)
    expect(loop?.clip.stretch?.tempoMode).toBe('follow')
    const shot = placeSound({
      entry: { id: 'shot', path: shots[0].key, name: shots[0].name, type: 'one-shot', tags: [], bpm: undefined, durationSec: 1, sampleRate: 48000, license: 'upload', source: 'My Library', category: 'bass' },
      channels: [new Float32Array(480)],
      fileRate: 48000,
      project,
      startSample: 0,
    })
    expect(shot?.clip.stretch?.followTempo).toBe(false)
  })
})

describe('merged catalog browse', () => {
  it('shows appended rows and lets an addition replace the same key', async () => {
    const base = {
      version: 4,
      generated_at: '2026-11-11T00:00:00Z',
      count: 2,
      pending: '',
      entries: [
        wire('audio/bass/Old_100_C.wav', { size: 64, type: 'loop', bpm: 100, musical_key: 'C major', search: 'bass loop old' }),
        wire('audio/bass/Hit.wav', { size: 32, type: 'one-shot', bpm: null, musical_key: null, search: 'bass hit' }),
      ],
    }
    const additions = {
      version: 1,
      generated_at: '2026-11-24T22:00:00.000Z',
      count: 2,
      entries: [
        wire('audio/bass/Old_100_C.wav', { size: 80, type: 'loop', bpm: 120, musical_key: 'C major', pack: 'Uploads', search: 'bass loop replaced' }),
        wire('audio/bass/Sub_90_Am.wav', { size: 70, type: 'loop', bpm: 90, musical_key: 'A minor', search: 'bass loop new' }),
      ],
    }
    expect(CLIENT_CATALOG_KEY).toBe(LIBRARY_CATALOG_KEY)
    expect(CLIENT_ADDITIONS_KEY).toBe(LIBRARY_ADDITIONS_KEY)
    const parsed = parseLibraryCatalog(base, additions)
    expect(parsed).toBeTruthy()
    expect(parsed!.document.entries.map((entry) => entry.key)).toEqual(['audio/bass/Old_100_C.wav', 'audio/bass/Hit.wav', 'audio/bass/Sub_90_Am.wav'])
    expect(parsed!.document.entries[0]).toMatchObject({ size: 80, bpm: 120, pack: 'Uploads' })
    expect(parsed!.document.count).toBe(3)
    const index = indexParsedCatalog(parsed!)
    const query = { ...EMPTY_LIBRARY_QUERY, type: 'loop' as const }
    const rows = browseLibraryRows(index, searchLibrary(index, query), [], query)
    const sounds = rows.flatMap((row) => row.kind === 'sound' ? [row.entry] : [])
    expect(sounds.map((entry) => entry.key)).toEqual(['audio/bass/Old_100_C.wav', 'audio/bass/Sub_90_Am.wav'])
    expect(sounds[0]?.bpm).toBe(120)
    expect(sounds[1]?.bpm).toBe(90)

    const gzip = gzipSync(Buffer.from(JSON.stringify(base)))
    const extra = Buffer.from(JSON.stringify(additions))
    const cache = memoryCatalogCache()
    writeLibraryAccessKey('owner-pass')
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/library/sign')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { keys?: string[] }
        expect(body.keys).toEqual([CLIENT_CATALOG_KEY, CLIENT_ADDITIONS_KEY])
        return new Response(JSON.stringify({
          expiresIn: 900,
          urls: [
            { key: CLIENT_CATALOG_KEY, url: 'https://library.test/catalog.json.gz' },
            { key: CLIENT_ADDITIONS_KEY, url: 'https://library.test/catalog-additions.json' },
          ],
        }), { status: 200 })
      }
      if (url.endsWith('catalog-additions.json')) return new Response(extra)
      return new Response(gzip)
    }) as typeof fetch
    try {
      const loaded = await loadLibraryCatalog(fetchImpl, cache)
      const loadedRows = browseLibraryRows(loaded.index, searchLibrary(loaded.index, query), [], query)
      expect(loadedRows.flatMap((row) => row.kind === 'sound' ? [row.entry.key] : [])).toEqual(['audio/bass/Old_100_C.wav', 'audio/bass/Sub_90_Am.wav'])
      expect(loaded.document.entries.find((entry) => entry.key === 'audio/bass/Old_100_C.wav')?.bpm).toBe(120)
      expect(loaded.document.count).toBe(3)
    } finally {
      clearLibraryAccessKey()
      setLibraryCaches({ catalog: null })
    }
  })

  it('opens the base catalog when the sidecar is missing, not JSON, or the wrong shape', async () => {
    const base = {
      version: 2,
      generated_at: '2026-11-11T00:00:00Z',
      count: 1,
      pending: '',
      entries: [wire('audio/bass/Hit.wav', { size: 32, type: 'one-shot', search: 'bass hit' })],
    }
    const gzip = gzipSync(Buffer.from(JSON.stringify(base)))
    const warned: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { warned.push(args.map((item) => String(item)).join(' ')) }
    const cases: { name: string; additions: Response | null; warn: boolean }[] = [
      { name: 'missing', additions: new Response('', { status: 404 }), warn: false },
      { name: 'status', additions: new Response('no', { status: 500 }), warn: true },
      { name: 'riff', additions: new Response(new Uint8Array([82, 73, 70, 70])), warn: true },
      { name: 'shape', additions: new Response(JSON.stringify({ nope: true })), warn: true },
      { name: 'network', additions: null, warn: true },
    ]
    try {
      for (const item of cases) {
        warned.length = 0
        writeLibraryAccessKey('owner-pass')
        const cache = memoryCatalogCache()
        const fetchImpl = (async (input: RequestInfo | URL) => {
          const url = String(input)
          if (url.endsWith('/api/library/sign')) {
            return new Response(JSON.stringify({
              expiresIn: 900,
              urls: [
                { key: CLIENT_CATALOG_KEY, url: 'https://library.test/catalog.json.gz' },
                { key: CLIENT_ADDITIONS_KEY, url: 'https://library.test/catalog-additions.json' },
              ],
            }), { status: 200 })
          }
          if (url.endsWith('catalog-additions.json')) {
            if (!item.additions) throw new Error('offline')
            return item.additions
          }
          return new Response(gzip)
        }) as typeof fetch
        const loaded = await loadLibraryCatalog(fetchImpl, cache)
        expect(loaded.document.entries.map((entry) => entry.key), item.name).toEqual(['audio/bass/Hit.wav'])
        expect(loaded.document.count, item.name).toBe(1)
        expect(warned.join('\n'), item.name).not.toContain('owner-pass')
        expect(warned.length > 0, item.name).toBe(item.warn)
        if (item.warn) expect(warned.join('\n'), item.name).toContain('My Library additions were skipped')
        clearLibraryAccessKey()
        setLibraryCaches({ catalog: null })
      }
    } finally {
      console.warn = original
      clearLibraryAccessKey()
      setLibraryCaches({ catalog: null })
    }
  })
})

describe('library upload script', () => {
  it('uploads new wavs, skips a second run, and prints counts only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'library-upload-'))
    const wav = Buffer.from(encodeWav([new Float32Array([0.2, -0.2])], 44100, { bits: 24 }))
    writeFileSync(join(dir, 'Sub.wav'), wav)
    writeFileSync(join(dir, 'catalog-entries.json'), JSON.stringify({
      entries: [wire('audio/bass/Sub.wav', { size: 1 })],
    }))
    const puts: Buffer[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/library/upload-sign')) {
        expect(new Headers(init?.headers).get('x-library-key')).toBe('owner-pass')
        const body = JSON.parse(String(init?.body)) as { keys: { key: string; size: number }[] }
        expect(body.keys[0].size).toBe(wav.byteLength)
        return new Response(JSON.stringify({ urls: [{ key: body.keys[0].key, url: 'https://bucket.test/put', exists: false }] }), { status: 200 })
      }
      if (url === 'https://bucket.test/put') {
        puts.push(Buffer.from(init?.body as Uint8Array))
        return new Response(null, { status: 200 })
      }
      if (url.endsWith('/api/library/catalog-append')) {
        expect(new Headers(init?.headers).get('x-library-key')).toBe('owner-pass')
        return new Response(JSON.stringify({ added: 1 }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }) as typeof fetch
    const first = await uploadFolder({ folder: dir, baseUrl: 'https://cueharbor.test/', accessKey: 'owner-pass', fetchImpl, attempts: 1 })
    expect(first).toEqual({ uploaded: 1, skipped: 0, added: 1, failed: 0 })
    expect(puts[0].equals(wav)).toBe(true)
    expect(readWavFacts(puts[0].buffer.slice(puts[0].byteOffset, puts[0].byteOffset + puts[0].byteLength) as ArrayBuffer)?.bits).toBe(24)
    const printed = formatCounts(first)
    expect(printed).toBe('uploaded 1\nskipped 0\nadded 1\nfailed 0\n')
    expect(printed).not.toContain('owner-pass')
    expect(printed).not.toContain('audio/bass/Sub.wav')
    const second = await uploadFolder({ folder: dir, baseUrl: 'https://cueharbor.test', accessKey: 'owner-pass', fetchImpl, attempts: 1 })
    expect(second.uploaded).toBe(0)
    expect(second.skipped).toBe(1)
    expect(puts).toHaveLength(1)
    const progress = readFileSync(join(dir, '.library-upload-progress.json'), 'utf8')
    expect(progress).not.toContain('owner-pass')
  })

  it('appends catalog rows in batches of 50', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'library-upload-batch-'))
    const wav = Buffer.from(encodeWav([new Float32Array([0.1, -0.1])], 44100))
    const entries = Array.from({ length: 51 }, (_, index) => wire(`audio/bass/n${index}.wav`, { size: wav.byteLength }))
    for (const entry of entries) writeFileSync(join(dir, `${entry.key.split('/').pop()}`), wav)
    writeFileSync(join(dir, 'catalog-entries.json'), JSON.stringify({ entries }))
    const batches: number[] = []
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/library/upload-sign')) {
        const body = JSON.parse(String(init?.body)) as { keys: { key: string }[] }
        return new Response(JSON.stringify({ urls: body.keys.map((item) => ({ key: item.key, url: `https://bucket.test/${encodeURIComponent(item.key)}`, exists: false })) }), { status: 200 })
      }
      if (url.startsWith('https://bucket.test/')) return new Response(null, { status: 200 })
      if (url.endsWith('/api/library/catalog-append')) {
        const body = JSON.parse(String(init?.body)) as { entries: unknown[] }
        batches.push(body.entries.length)
        return new Response(JSON.stringify({ added: body.entries.length, skipped: 0 }), { status: 200 })
      }
      return new Response('no', { status: 404 })
    }) as typeof fetch
    const counts = await uploadFolder({ folder: dir, baseUrl: 'https://cueharbor.test', accessKey: 'owner-pass', fetchImpl, attempts: 1 })
    expect(counts).toEqual({ uploaded: 51, skipped: 0, added: 51, failed: 0 })
    expect(batches).toEqual([50, 1])
  })
})

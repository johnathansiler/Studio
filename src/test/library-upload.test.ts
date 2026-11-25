import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { browseLibraryRows } from '../library/browse'
import { indexParsedCatalog, parseLibraryCatalog } from '../library/catalog'
import { buildFastRows, classifyDrum, nearSongWindow } from '../library/fastBrowse'
import { entryMatchesFilters, searchLibrary } from '../library/search'
import { EMPTY_LIBRARY_QUERY } from '../library/types'
import { encodeWav } from '../model/wav'
import { createEmptyProject } from '../model/types'
import { placeSound } from '../sounds/place'
import { createLibraryApi, LIBRARY_NOT_READY, libraryCatalogWriteKey, presignR2Put, type LibraryEnv, type LibraryObjects } from '../../server/library.ts'
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

function memoryObjects(seed?: Record<string, unknown>, options?: { conflictOnce?: boolean }) {
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
      return bytes ? { status: 200, bytes, etag: etags.get(key) ?? null } : { status: 404, bytes: null, etag: null }
    },
    async put(key, bytes, _contentType, conditions) {
      const match = conditions?.ifMatch ? ` if-match ${conditions.ifMatch}` : ''
      const none = conditions?.ifNoneMatch ? ` if-none-match ${conditions.ifNoneMatch}` : ''
      if (conflictArmed && key === 'catalog/catalog.json.gz') {
        conflictArmed = false
        calls.push(`put ${key} conflict`)
        const current = JSON.parse(gunzipSync(objects.get(key)!).toString('utf8')) as { entries: unknown[]; count: number; version: number }
        current.entries.push(wire('audio/bass/racer.wav', { size: 8 }))
        current.count = current.entries.length
        current.version = 9
        objects.set(key, gzipSync(Buffer.from(JSON.stringify(current))))
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
  return { objects, calls, api }
}

function readCatalog(bytes: Uint8Array) {
  return JSON.parse(gunzipSync(bytes).toString('utf8')) as { version: number; generated_at: string; count: number; pending?: string; entries: Record<string, unknown>[]; note?: string }
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

  it('appends without dropping existing rows and writes a temp, a backup, then the live catalog', async () => {
    const store = memoryObjects(existing)
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
    expect(result.body.version).toBe(5)
    expect(result.body.count).toBe(3)
    expect(JSON.stringify(result.body)).not.toContain('owner-pass')
    const live = store.objects.get('catalog/catalog.json.gz')
    expect(live).toBeTruthy()
    const document = readCatalog(live!)
    expect(document.pending).toBe('later')
    expect(document.note).toBe('keep me')
    expect(document.count).toBe(3)
    expect(document.generated_at).toBe('2026-11-24T21:00:00.000Z')
    expect(document.entries[0]).toMatchObject({ key: 'Drums/kick.wav', size: 10, bpm_source: 'label', extra: 'stay' })
    expect(document.entries[1]).toMatchObject({ key: 'Bass/old.wav', size: 20 })
    expect(document.entries[2]).toMatchObject({ key: 'audio/bass/new.wav', bit_depth: 24, category: 'bass' })
    const backupKey = [...store.objects.keys()].find((key) => key.startsWith('catalog/backups/'))
    const tempKey = [...store.objects.keys()].find((key) => key.startsWith('catalog/tmp/'))
    expect(backupKey).toBeTruthy()
    expect(tempKey).toBeTruthy()
    expect(readCatalog(store.objects.get(backupKey!)!).entries).toHaveLength(3)
    expect(store.calls).toEqual([
      'get catalog/catalog.json.gz',
      `put ${tempKey}`,
      `copy ${tempKey} ${backupKey}`,
      'put catalog/catalog.json.gz if-match "1"',
    ])
  })

  it('keeps a row written by someone else when the catalog etag moves', async () => {
    const store = memoryObjects(existing, { conflictOnce: true })
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
    const document = readCatalog(store.objects.get('catalog/catalog.json.gz')!)
    const keys = document.entries.map((entry) => entry.key)
    expect(keys).toEqual(['Drums/kick.wav', 'Bass/old.wav', 'audio/bass/racer.wav', 'audio/bass/new.wav'])
    expect(store.calls.some((call) => call.includes('conflict'))).toBe(true)
    expect(store.calls.filter((call) => call.includes('catalog/catalog.json.gz if-match')).length).toBe(1)
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
    const document = readCatalog(store.objects.get('catalog/catalog.json.gz')!)
    expect(document.entries.map((entry) => entry.key)).toEqual(['Drums/kick.wav', 'Bass/old.wav', 'audio/bass/a.wav', 'audio/bass/b.wav'])
  })

  it('creates a missing catalog only when nothing else landed first', async () => {
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
    expect(readCatalog(store.objects.get('catalog/catalog.json.gz')!).entries).toHaveLength(1)
  })

  it('leaves the live catalog untouched when the read has no etag', async () => {
    const store = memoryObjects(existing)
    const before = Buffer.from(store.objects.get('catalog/catalog.json.gz')!)
    store.api.get = async (key) => {
      store.calls.push(`get ${key}`)
      const bytes = store.objects.get(key)
      return bytes ? { status: 200, bytes, etag: null } : { status: 404, bytes: null, etag: null }
    }
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
    expect(Buffer.from(store.objects.get('catalog/catalog.json.gz')!).equals(before)).toBe(true)
    expect(readCatalog(before).entries.map((entry) => entry.key)).toEqual(['Drums/kick.wav', 'Bass/old.wav'])
    expect(store.calls.some((call) => call.startsWith('put'))).toBe(false)
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
    expect(again.body.version).toBe(5)
    const document = readCatalog(store.objects.get('catalog/catalog.json.gz')!)
    expect(document.entries).toHaveLength(3)
    expect(document.entries[0]).toMatchObject({ key: 'Drums/kick.wav', extra: 'stay' })
    expect(document.entries[2]).toMatchObject({ key: 'audio/bass/new.wav', size: 64, pack: 'Uploads' })
    expect(store.calls.filter((call) => call.startsWith('put catalog/tmp/'))).toHaveLength(1)
    expect(store.calls.filter((call) => call.startsWith('put catalog/catalog.json.gz'))).toHaveLength(1)
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
})

import { gzipSync, gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { encodeWav } from '../model/wav'
import { createLibraryApi, LIBRARY_NOT_READY, presignR2Put, type LibraryEnv, type LibraryObjects } from '../../server/library.ts'
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

function memoryObjects(seed?: Record<string, unknown>) {
  const objects = new Map<string, Uint8Array>()
  const calls: string[] = []
  if (seed) objects.set('catalog/catalog.json.gz', gzipSync(Buffer.from(JSON.stringify(seed))))
  const api: LibraryObjects = {
    async get(key) {
      calls.push(`get ${key}`)
      const bytes = objects.get(key)
      return bytes ? { status: 200, bytes } : { status: 404, bytes: null }
    },
    async put(key, bytes) {
      calls.push(`put ${key}`)
      objects.set(key, bytes.slice())
    },
    async copy(from, to) {
      calls.push(`copy ${from} ${to}`)
      const bytes = objects.get(from)
      if (!bytes) throw new Error('missing')
      objects.set(to, bytes.slice())
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

  it('presigns a PUT without putting the secret in the URL', async () => {
    const put = new URL(await presignR2Put(env, `${LIBRARY_AUDIO_PREFIX}bass/C#.wav`))
    expect(put.host).toBe('2001009ff8860d62eac085ee8cce34e2.r2.cloudflarestorage.com')
    expect(decodeURIComponent(put.pathname)).toContain('audio/bass/C#.wav')
    expect(put.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(put.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(put.toString()).not.toContain(env.R2_SECRET_ACCESS_KEY)
    expect(put.toString()).not.toContain('owner-pass')
    await expect(presignR2Put(env, 'Drums/kick.wav')).rejects.toThrow(LIBRARY_NOT_READY)
    expect(libraryAudioKey('audio/../x.wav')).toBeNull()
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
      `copy ${tempKey} catalog/catalog.json.gz`,
    ])
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
    expect(store.calls.filter((call) => call.startsWith('put'))).toHaveLength(1)
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

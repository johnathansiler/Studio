import { createHash } from 'node:crypto'
import { describe, expect, it, afterEach } from 'vitest'
import { encodeWav } from '../model/wav'
import { zipFiles } from '../model/zip'
import { fetchCatalogSound, filterSounds, loadSoundCatalog } from '../sounds/catalog'
import { PRIVATE_CATALOG_VERSION, PRIVATE_LICENSE, importPrivateLibrary, memoryPrivateStore, parsePrivateCatalog, setPrivateLibraryStore, type PrivateSourceFile } from '../sounds/private'
import { chopLoops, soundsForRole } from '../sounds/roles'
import { soundFileUrl } from '../sounds/source'
import { placeSound } from '../sounds/place'
import { createEmptyProject } from '../model/types'

function sha(bytes: ArrayBuffer) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

function tone(seconds = 0.05) {
  const data = new Float32Array(Math.round(48000 * seconds))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.2
  return data
}

function entry(hash: string, patch: Record<string, unknown> = {}) {
  return {
    id: `local-${hash.slice(0, 8)}`,
    name: 'Local hit',
    type: 'one-shot',
    role: 'drum_one_shot',
    category: 'kick',
    tags: ['one-shot', 'kick'],
    path: `private/local/${hash.slice(0, 8)}.wav`,
    localBlobId: `blob:sha256:${hash}`,
    localRelPath: `assets/${hash.slice(0, 2)}/${hash}.wav`,
    bytes: 8,
    sha256: hash,
    sampleRate: 48000,
    bitDepth: 16,
    channels: 1,
    durationSec: 0.05,
    packId: 'LocalPack',
    publisher: 'local',
    license: PRIVATE_LICENSE,
    licenseClass: 'PERSONAL_SONG_USE_NO_RAW_REDISTRIBUTION',
    redistributionAllowed: false,
    factoryUploadAllowed: false,
    crossFactoryShaMatch: false,
    visibility: 'private-local-only',
    collection: 'private-song-making-2026-11-09',
    version: PRIVATE_CATALOG_VERSION,
    ...patch,
  }
}

function document(entries: unknown[]) {
  return {
    version: PRIVATE_CATALOG_VERSION,
    visibility: 'private-local-only',
    factoryUploadAllowed: false,
    entries,
  }
}

function source(hash: string, bytes: ArrayBuffer): PrivateSourceFile {
  return { name: `${hash}.wav`, relativePath: `root/assets/${hash.slice(0, 2)}/${hash}.wav`, bytes }
}

afterEach(() => setPrivateLibraryStore(null))

describe('private library import', () => {
  it('keeps private audio on the device and out of the factory catalog', async () => {
    const wav = encodeWav([tone()], 48000)
    const hash = sha(wav)
    const row = entry(hash)
    const store = memoryPrivateStore()
    setPrivateLibraryStore(store)
    const result = await importPrivateLibrary([
      { name: 'PRIVATE_CATALOG.json', bytes: new TextEncoder().encode(JSON.stringify(document([row]))).buffer },
      source(hash, wav),
    ])
    expect(result.keptPrevious).toBe(false)
    expect(result.installed).toBe(1)
    const saved = await store.catalog()
    expect(saved[0].origin).toBe('private')
    expect(saved[0].license).toBe(PRIVATE_LICENSE)
    expect(saved[0].path.startsWith('private/')).toBe(true)
    expect(saved[0].path.includes('huggingface')).toBe(false)
    expect(() => soundFileUrl(saved[0].path)).toThrow(/Hugging Face|library/)
    let fetches = 0
    const bytes = await fetchCatalogSound(saved[0], { fetchImpl: async () => { fetches += 1; return new Response() } })
    expect(fetches).toBe(0)
    expect(bytes.byteLength).toBe(wav.byteLength)

    const listed = await loadSoundCatalog(async () => new Response('missing', { status: 404 }))
    expect(listed.entries.map((item) => item.id)).toEqual([row.id])
    expect(soundsForRole(listed.entries, 'step').map((item) => item.id)).toEqual([row.id])
    expect(chopLoops(listed.entries)).toEqual([])
    expect(filterSounds(listed.entries, { text: 'goldbaby', type: 'all', bpm: 'any', key: '', favoritesOnly: false, projectBpm: 120, favorites: [], tag: 'kick' })).toEqual([])
    expect(filterSounds(listed.entries, { text: '', type: 'drum', bpm: 'any', key: '', favoritesOnly: false, projectBpm: 120, favorites: [], tag: 'kick' }).map((item) => item.id)).toEqual([row.id])
  })

  it('rejects a factory upload flag and keeps a failed import from replacing files', async () => {
    const wav = encodeWav([tone()], 48000)
    const hash = sha(wav)
    const good = entry(hash)
    expect(parsePrivateCatalog(document([{ ...good, factoryUploadAllowed: true }]))).toEqual([])
    expect(parsePrivateCatalog(document([{ ...good, path: 'https://huggingface.co/datasets/cueharbor/sound-library/resolve/main/x.wav' }]))).toEqual([])
    expect(parsePrivateCatalog({ version: PRIVATE_CATALOG_VERSION, visibility: 'public', factoryUploadAllowed: false, entries: [good] })).toEqual([])

    const store = memoryPrivateStore()
    setPrivateLibraryStore(store)
    await importPrivateLibrary([
      { name: 'PRIVATE_CATALOG.json', bytes: new TextEncoder().encode(JSON.stringify(document([good]))).buffer },
      source(hash, wav),
    ])
    const other = encodeWav([tone(0.08)], 48000)
    const otherHash = sha(other)
    const bad = entry(otherHash, { id: 'local-bad', name: 'Bad' })
    const originalWrite = store.writeSha.bind(store)
    store.writeSha = async () => { throw new DOMException('quota', 'QuotaExceededError') }
    const failed = await importPrivateLibrary([
      { name: 'PRIVATE_CATALOG.json', bytes: new TextEncoder().encode(JSON.stringify(document([bad]))).buffer },
      source(otherHash, other),
    ])
    expect(failed.keptPrevious).toBe(true)
    expect(failed.cancelled).toBe(false)
    expect(failed.message).toMatch(/room|kept/)
    expect((await store.catalog()).map((item) => item.id)).toEqual([good.id])
    expect(await store.readSha(hash)).not.toBeNull()
    store.writeSha = originalWrite

    const signal = new AbortController()
    signal.abort()
    const cancelled = await importPrivateLibrary([
      { name: 'PRIVATE_CATALOG.json', bytes: new TextEncoder().encode(JSON.stringify(document([bad]))).buffer },
      source(otherHash, other),
    ], { signal: signal.signal })
    expect(cancelled.cancelled).toBe(true)
    expect((await store.catalog()).map((item) => item.id)).toEqual([good.id])
  })

  it('installs a zip bundle and leaves a loop at its natural tempo when no BPM is recorded', async () => {
    const wav = encodeWav([tone()], 48000)
    const hash = sha(wav)
    const loop = entry(hash, { type: 'loop', role: 'loop', category: 'perc', tags: ['loop', 'perc'], name: 'Local loop', bpm: undefined, key: undefined })
    delete (loop as { bpm?: number }).bpm
    const catalog = new TextEncoder().encode(JSON.stringify(document([loop])))
    const zip = await zipFiles([
      { name: 'PRIVATE_CATALOG.json', data: new Uint8Array(catalog) },
      { name: `assets/${hash.slice(0, 2)}/${hash}.wav`, data: new Uint8Array(wav) },
    ])
    const store = memoryPrivateStore()
    setPrivateLibraryStore(store)
    const result = await importPrivateLibrary([{ name: 'bundle.zip', bytes: zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer }])
    expect(result.installed).toBe(1)
    const saved = (await store.catalog())[0]
    expect(saved.bpm).toBeUndefined()
    const placed = placeSound({
      entry: saved,
      channels: [tone()],
      fileRate: 48000,
      project: createEmptyProject(48000),
      startSample: 0,
    })
    expect(placed?.clip.stretch?.followTempo).toBe(false)
    expect(chopLoops([saved]).map((item) => item.id)).toEqual([saved.id])
    expect(soundsForRole([saved], 'step')).toEqual([])
    expect(filterSounds([saved], { text: '', type: 'drum', bpm: 'any', key: '', favoritesOnly: false, projectBpm: 100, favorites: [] })).toEqual([])
  })
})

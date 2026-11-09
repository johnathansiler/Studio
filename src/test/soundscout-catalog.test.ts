import { readFileSync } from 'node:fs'
import { decodeWavPCM } from '../model/wav'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createEmptyProject } from '../model/types'
import { SoundCache, fetchSoundBytes, memoryByteStore, sha256Hex } from '../sounds/cache'
import {
  browserSounds,
  filterSounds,
  loadSoundCatalog,
  parseSoundScoutCatalog,
} from '../sounds/catalog'
import { LEGACY_INDEX_URL, SOUND_CATALOG_URL, SOUND_DATASET_BASE, SOUND_DATASET_COMMIT, SOUND_VERSION_PREFIX } from '../sounds/contract'
import { licenseAllowed } from '../sounds/license'
import { legacySoundFileUrl, soundCatalogUrl, soundFileUrl } from '../sounds/source'
import { placeSound, previewChannelsFor } from '../sounds/place'
import { libraryMatchesCategory, soundsForRole } from '../sounds/roles'
import { ensureDefaultKit } from '../instruments/pads/load'
import { pickDefaultKit } from '../instruments/pads/record'
import { ProjectStore } from '../state/store'
import { SoundBrowser } from '../ui/SoundBrowser'

const rawText = readFileSync(new URL('./fixtures/soundscout-2026-11-09.json', import.meta.url), 'utf8')
const document = JSON.parse(rawText) as {
  version: string
  counts: { entries: number; uniqueWav: number; byLicense: Record<string, number>; byPack: Record<string, number>; byType: Record<string, number> }
  urlContract: { exampleAudio: string }
  entries: Array<Record<string, unknown>>
}

const catalog = parseSoundScoutCatalog(document)

describe('SoundScout catalog', () => {
  it('keeps the prepared 776-row document exact, including the informal grant', () => {
    expect(document.version).toBe('soundscout-2026-11-09')
    expect(catalog).toHaveLength(776)
    expect(new Set(catalog.map((entry) => entry.sha256)).size).toBe(770)
    expect(catalog.filter((entry) => entry.license === 'CC0-1.0')).toHaveLength(285)
    expect(catalog.filter((entry) => entry.license === 'Informal-creator-grant')).toHaveLength(491)
    expect(catalog.filter((entry) => entry.isContentAlias)).toHaveLength(6)
    expect(catalog.filter((entry) => entry.licenseClass === 'INFORMAL_CREATOR_GRANT_NOT_CC0')).toHaveLength(491)
    expect(catalog.some((entry) => entry.pack?.startsWith('ORG-') && entry.license === 'CC0-1.0')).toBe(false)
    expect(licenseAllowed('Informal-creator-grant')).toBe(true)
    expect(licenseAllowed('Informal-creator-grant', true)).toBe(false)
    expect(licenseAllowed('CC-BY-4.0')).toBe(false)
    expect(licenseAllowed('unlicensed')).toBe(false)

    for (const raw of document.entries) {
      const parsed = catalog.find((entry) => entry.id === raw.id)
      expect(parsed?.name).toBe(raw.name)
      expect(parsed?.path).toBe(raw.path)
      expect(parsed?.license).toBe(raw.license)
      expect(parsed?.type).toBe(raw.type)
      expect(parsed?.bpm).toBe(typeof raw.bpm === 'number' ? raw.bpm : undefined)
      expect(parsed?.key).toBe(typeof raw.key === 'string' ? raw.key : undefined)
      expect(String(parsed?.path)).toMatch(new RegExp(`^${SOUND_VERSION_PREFIX}`))
      expect(String(parsed?.path).startsWith('loops/') || String(parsed?.path).startsWith('one-shots/')).toBe(false)
    }

    expect(catalog.filter((entry) => entry.pack === 'HW-MBASE' && entry.bpm != null)).toHaveLength(0)
    expect(catalog.filter((entry) => entry.pack === 'LEN-ZIP' && (entry.bpm != null || entry.key != null))).toHaveLength(0)
    expect(catalog.filter((entry) => entry.pack === 'ORG-MEAD-NATURE' && entry.bpm != null)).toHaveLength(0)
    expect(catalog.filter((entry) => entry.pack === 'ORG-MEAD-PERC' && entry.bpm == null)).toHaveLength(0)
    expect(catalog.filter((entry) => entry.pack === 'HW-MBASE' && entry.key == null)).toHaveLength(0)
    expect(document.counts.byPack['HW-MBASE']).toBe(250)
    expect(document.counts.byType.loop).toBe(526)
  })

  it('does not treat a kick pitch as a musical key or revive the old stock index', async () => {
    const kick = catalog.find((entry) => entry.key === 'C1' && entry.pack === 'HW-MBASE')!
    const query = { text: '', type: 'all' as const, bpm: 'any' as const, key: '', favoritesOnly: false, projectBpm: 120, favorites: [] as string[] }
    expect(filterSounds([kick], { ...query, key: 'C' })).toEqual([])
    expect(filterSounds([kick], { ...query, key: 'C1' }).map((entry) => entry.id)).toEqual([kick.id])
    expect(soundFileUrl(kick.path)).toBe(document.urlContract.exampleAudio.replace('/resolve/main/', `/resolve/${SOUND_DATASET_COMMIT}/`))
    expect(soundFileUrl(kick.path)).toContain(SOUND_DATASET_COMMIT)
    const hashed = catalog.filter((entry) => entry.path.includes('#'))
    expect(hashed.length).toBeGreaterThan(1)
    for (const entry of hashed) {
      const url = new URL(soundFileUrl(entry.path))
      expect(url.hash).toBe('')
      expect(url.href.includes('#')).toBe(false)
      expect(url.href.includes('%23')).toBe(true)
      expect(url.href.includes('%2523')).toBe(false)
      expect(decodeURIComponent(url.pathname).endsWith(entry.path.slice(entry.path.lastIndexOf('/')))).toBe(true)
    }
    const natural = catalog.find((entry) => entry.type === 'loop' && entry.bpm == null)!
    const naturalPlaced = placeSound({
      entry: natural,
      channels: [new Float32Array(480)],
      fileRate: 48000,
      project: createEmptyProject(48000),
      startSample: 0,
    })
    expect(naturalPlaced?.clip.stretch?.followTempo).toBe(false)
    expect(naturalPlaced?.clip.durationSamples).toBe(480)
    const naturalPreview = previewChannelsFor(natural, [new Float32Array(480)], 48000, createEmptyProject(48000), 0)
    expect(naturalPreview[0]?.length).toBe(480)
    const timed = catalog.find((entry) => entry.type === 'loop' && entry.bpm)!
    const timedPlaced = placeSound({
      entry: timed,
      channels: [new Float32Array(480)],
      fileRate: 48000,
      project: createEmptyProject(48000),
      startSample: 0,
    })
    expect(timedPlaced?.clip.stretch?.followTempo).toBe(true)
    expect(timedPlaced?.clip.stretch?.sourceBpm).toBe(timed.bpm)
    expect(() => soundFileUrl('loops/dust.wav')).toThrow(/Hugging Face|library/)
    expect(() => soundFileUrl('one-shots/drums/kick.wav')).toThrow(/Hugging Face|library/)
    expect(legacySoundFileUrl('loops/dust.wav')).toBe(`${SOUND_DATASET_BASE}/loops/dust.wav`)
    expect(() => legacySoundFileUrl(kick.path)).toThrow(/Hugging Face|library/)
    expect(soundCatalogUrl()).toBe(SOUND_CATALOG_URL)

    const requested: string[] = []
    const loaded = await loadSoundCatalog(async (url) => {
      requested.push(String(url))
      return new Response(rawText)
    })
    expect(requested).toEqual([SOUND_CATALOG_URL])
    expect(loaded.entries).toHaveLength(776)

    const legacy = await loadSoundCatalog(async (url) => {
      requested.push(String(url))
      return new Response(JSON.stringify([{ id: 'dust', path: 'loops/dust.wav', name: 'Dusty loop', type: 'loop', license: 'CC0', source: 'old' }]), { status: 200 })
    })
    expect(legacy).toEqual({ entries: [], status: 'missing' })
    expect(requested.filter((url) => url === LEGACY_INDEX_URL)).toEqual([])

    const cache = new SoundCache([memoryByteStore()])
    const encoded = new TextEncoder().encode(JSON.stringify([{ id: 'dust', path: 'loops/dust.wav', name: 'Dust', type: 'loop', license: 'CC0', source: 'old' }]))
    await cache.put(LEGACY_INDEX_URL, encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength))
    const ignored = await loadSoundCatalog(async () => { throw new Error('offline') }, cache)
    expect(ignored).toEqual({ entries: [], status: 'missing' })

    const versioned = new TextEncoder().encode(rawText)
    await cache.put(SOUND_CATALOG_URL, versioned.buffer.slice(versioned.byteOffset, versioned.byteOffset + versioned.byteLength))
    const restored = await loadSoundCatalog(async () => { throw new Error('offline') }, cache)
    expect(restored.entries).toHaveLength(776)
    expect(restored.entries.some((entry) => entry.id === 'dust' || entry.name === 'Dusty loop')).toBe(false)
  })

  it('feeds the same rows to browse, loops, chop, and drum defaults without the wrong kind', () => {
    expect(soundsForRole(catalog, 'loop').every((entry) => entry.type === 'loop')).toBe(true)
    expect(soundsForRole(catalog, 'chop').map((entry) => entry.id)).toEqual(soundsForRole(catalog, 'loop').map((entry) => entry.id))
    const steps = soundsForRole(catalog, 'step')
    expect(steps.length).toBeGreaterThan(0)
    expect(steps.every((entry) => entry.type === 'one-shot' && entry.category === 'kick')).toBe(true)
    const percussion = catalog.find((entry) => entry.category === 'percussion')!
    expect(soundsForRole([percussion], 'step')).toEqual([])
    expect(libraryMatchesCategory(percussion, 'Kicks')).toBe(false)
    expect(libraryMatchesCategory(steps[0], 'Snares')).toBe(false)
    expect(libraryMatchesCategory(steps[0], 'Kicks')).toBe(true)
    const picks = pickDefaultKit(catalog)
    expect(picks.map((pick) => pick.index)).toEqual([0])
    expect(catalog.find((entry) => entry.id === picks[0].id)?.type).toBe('one-shot')

    const loop = catalog.find((entry) => entry.pack === 'LEN-ZIP')!
    const nature = catalog.find((entry) => entry.pack === 'ORG-MEAD-NATURE')!
    const store = new ProjectStore(createEmptyProject())
    const engine = { unlock() {}, stopPreview() {}, previewPcm() {}, currentTimelineSample: () => 0 }
    const loopsOnly = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine,
      onClose: () => undefined,
      lockType: 'loop',
      initial: { entries: [steps[0], loop, nature], status: 'ok' },
    }))
    expect(loopsOnly).toContain(loop.name)
    expect(loopsOnly).toContain(nature.name)
    expect(loopsOnly).toContain('Informal-creator-grant')
    expect(loopsOnly).not.toContain(steps[0].name)
    expect(loopsOnly).toContain('Organic nature')
    expect(loopsOnly).toContain('Lentikula')

    const all = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine,
      onClose: () => undefined,
      initial: { entries: [steps[0], nature], status: 'ok' },
    }))
    expect(all).toContain(steps[0].name)
    expect(all).toContain('One-shot')
    expect(all).toContain('MBase kicks')
    expect(all).toContain('Loop')

    const grime = catalog.find((entry) => entry.tags.includes('grime') && entry.tags.includes('rim'))!
    expect(grime.role).toBe('drum_one_shot')
    expect(libraryMatchesCategory(grime, 'Kicks')).toBe(true)
    expect(libraryMatchesCategory(grime, 'Snares')).toBe(false)
    expect(libraryMatchesCategory(grime, 'Perc')).toBe(false)
    expect(soundsForRole([grime], 'step').map((entry) => entry.id)).toEqual([grime.id])
    expect(percussion.role).toBe('loop')
    const open = { text: '', type: 'all' as const, bpm: 'any' as const, key: '', favoritesOnly: false, projectBpm: 120, favorites: [] as string[] }
    expect(filterSounds(catalog, { ...open, role: 'drum_one_shot' }).every((entry) => entry.type === 'one-shot' && entry.category === 'kick')).toBe(true)
    expect(filterSounds(catalog, { ...open, role: 'loop' }).every((entry) => entry.type === 'loop')).toBe(true)
    expect(filterSounds(catalog, { ...open, text: 'mbase' }).every((entry) => entry.pack === 'HW-MBASE')).toBe(true)
    expect(browserSounds(catalog, { ...open, type: 'instrument' })).toHaveLength(776)
    expect(browserSounds(catalog, { ...open, type: 'instrument' }).some((entry) => /xylophone|upright piano|nylon/i.test(entry.name))).toBe(false)
    const chopList = soundsForRole(catalog, 'chop')
    expect(chopList.length).toBeGreaterThan(40)
    expect(chopList[39]?.type).toBe('loop')
    const forty = Array.from({ length: 40 }, (_, index) => ({
      id: `chop-loop-${index + 1}`,
      path: `soundscout-2026-11-09/loops/chop-loop-${index + 1}.wav`,
      name: `Chop loop ${index + 1}`,
      type: 'loop' as const,
      tags: ['loop'],
      durationSec: 1,
      sampleRate: 48000,
      license: 'CC0-1.0',
      source: 'test',
      role: 'loop',
    }))
    const chopped = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine,
      onClose: () => undefined,
      lockType: 'loop',
      initial: { entries: forty, status: 'ok' },
    }))
    expect(chopped).toContain('Chop loop 40')
    expect(chopped).not.toContain('Xylophone')
    const keys = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: false,
      engine,
      onClose: () => undefined,
      lockType: 'instrument',
      initial: { entries: [forty[39], steps[0]], status: 'ok' },
      instruments: [{ id: 'xylophone', name: 'Xylophone', license: 'CC0-1.0', path: 'xylophone/instrument.sfz', bytes: 1, description: 'old starter' }],
    }))
    expect(keys).toContain('Chop loop 40')
    expect(keys).toContain(steps[0].name)
    expect(keys).toContain('one sample on the keyboard')
    expect(keys).not.toContain('Xylophone')
    expect(keys).not.toContain('starterCatalog')
  })

  it('loads one file on demand, retries, and does not keep a bad download', async () => {
    const target = catalog[0]
    const url = soundFileUrl(target.path)
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    const hash = await sha256Hex(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength))
    let calls = 0
    const cache = new SoundCache([memoryByteStore()], 6)
    const fetchImpl = async () => {
      calls += 1
      if (calls === 1) return new Response('busy', { status: 503 })
      return new Response(payload)
    }
    const bytes = await fetchSoundBytes(url, fetchImpl, cache, { attempts: 2, delayMs: 0, sha256: hash, onProgress: () => undefined })
    expect(calls).toBe(2)
    expect(new Uint8Array(bytes)).toEqual(payload)
    const again = await fetchSoundBytes(url, async () => { throw new Error('should use the cache') }, cache, { sha256: hash })
    expect(new Uint8Array(again)).toEqual(payload)

    const other = new Uint8Array([9, 9, 9, 9, 9, 9, 9])
    await cache.put(legacySoundFileUrl('loops/dust.wav'), other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength))
    expect(await cache.get(url)).toBeNull()

    await expect(fetchSoundBytes(url, async () => new Response(new Uint8Array([3, 3, 3, 3])), cache, { sha256: hash, attempts: 1 })).rejects.toThrow(/match the SoundScout catalog/)
    expect(calls).toBe(2)
  })

  it('leaves project audio in place when the catalog is not published yet', async () => {
    const store = new ProjectStore(createEmptyProject())
    const id = store.project.tracks.find((track) => track.type === 'midi')!.id
    store.insertPads(id)
    store.assignTrackPad(id, 0, 1, { name: 'Saved snare', samples: new Float32Array([0.2, -0.2, 0.2]), sampleRate: 48000 })
    const pad = store.trackKit(id).banks[0][1]
    const bufferId = pad.layers[0].bufferId!
    const before = store.buffers.get(bufferId)?.channels[0]?.slice()
    const original = globalThis.fetch
    globalThis.fetch = async () => new Response('missing', { status: 404 })
    try {
      await ensureDefaultKit(store, id)
    } finally {
      globalThis.fetch = original
    }
    expect(store.trackKit(id).banks[0][1].sampleName).toBe('Saved snare')
    expect(store.buffers.get(bufferId)?.channels[0]).toEqual(before)
  })

  it('downloads a hosted file whose name contains a hash and checks the catalog hash', async () => {
    const entry = catalog.filter((item) => item.path.includes('#') && item.sha256).sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0))[0]
    const url = soundFileUrl(entry.path)
    const response = await fetch(url)
    expect(response.status).toBe(200)
    const bytes = await response.arrayBuffer()
    expect(await sha256Hex(bytes)).toBe(entry.sha256)
    const wav = decodeWavPCM(bytes)
    expect(wav.sampleRate).toBe(entry.sampleRate)
    expect(wav.channels.length).toBeGreaterThan(0)
  }, 60000)

  it('heads every previously broken hash name on the pinned dataset', async () => {
    const hashed = catalog.filter((entry) => entry.path.includes('#'))
    expect(hashed).toHaveLength(121)
    const extras = [
      catalog.find((entry) => entry.path.includes('(')),
      catalog.find((entry) => entry.path.includes(' ') && !entry.path.includes('#') && !entry.path.includes('(')),
    ].filter((entry): entry is (typeof catalog)[number] => Boolean(entry))
    const catalogHead = await fetch(SOUND_CATALOG_URL, { method: 'HEAD' })
    expect(catalogHead.status).toBe(200)
    expect(SOUND_CATALOG_URL).toContain(SOUND_DATASET_COMMIT)
    const failures: string[] = []
    const queue = [...hashed, ...extras]
    async function worker() {
      for (;;) {
        const entry = queue.pop()
        if (!entry) return
        const url = soundFileUrl(entry.path)
        if (url.includes('#') || !url.includes('%23') && entry.path.includes('#')) failures.push(`encode ${entry.path}`)
        if (!url.includes(SOUND_DATASET_COMMIT)) failures.push(`pin ${entry.path}`)
        const response = await fetch(url, { method: 'HEAD' })
        if (response.status !== 200) failures.push(`${response.status} ${entry.path}`)
        const length = Number(response.headers.get('content-length'))
        if (length > 0 && entry.bytes && length !== entry.bytes) failures.push(`length ${length} ${entry.path}`)
      }
    }
    await Promise.all(Array.from({ length: 6 }, () => worker()))
    expect(failures).toEqual([])
  }, 120000)
})

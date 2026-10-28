import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { yinPitch } from '../audio/stretch/voice'
import { encodeWav } from '../model/wav'
import { createEmptyProject, type Project } from '../model/types'
import { SoundCache, fetchSoundBytes, memoryByteStore } from '../sounds/cache'
import {
  bpmMatchesProject,
  catalogMessage,
  filterSounds,
  licenseAllowed,
  loadSoundCatalog,
  parseCatalog,
} from '../sounds/catalog'
import { audioTrackFor, decodeSoundBytes, placeSound, previewChannelsFor, trackIdFromDrop } from '../sounds/place'
import { assertSoundUrl, soundFileUrl, soundIndexUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import { isUntouchedEmpty } from '../model/launchProject'
import { selectSounds } from '../state/select'
import { ProjectStore } from '../state/store'
import { SoundBrowser } from '../ui/SoundBrowser'

const fixture: SoundEntry[] = [
  {
    id: 'dust',
    path: 'loops/dust.wav',
    name: 'Dusty loop',
    type: 'loop',
    tags: ['drum', 'dusty'],
    bpm: 120,
    key: 'Am',
    durationSec: 2,
    sampleRate: 48000,
    license: 'CC0',
    source: 'Acoustic Commons',
  },
  {
    id: 'pad',
    path: 'loops/pad.wav',
    name: 'Soft pad',
    type: 'loop',
    tags: ['pad', 'warm'],
    bpm: 80,
    key: 'C',
    durationSec: 4,
    sampleRate: 44100,
    license: 'Public Domain',
    source: 'Unlicense archive',
  },
  {
    id: 'hat',
    path: 'ones/hat.wav',
    name: 'Closed hat',
    type: 'one-shot',
    tags: ['hat'],
    durationSec: 0.2,
    sampleRate: 48000,
    license: 'Unlicense',
    source: 'Public domain kit',
  },
]

function rawIndex() {
  return [
    ...fixture,
    { id: 'paid', path: 'loops/paid.wav', name: 'Paid loop', type: 'loop', tags: ['bass'], bpm: 100, durationSec: 1, sampleRate: 48000, license: 'CC-BY-4.0', source: 'A label' },
    { id: 'broken', path: '', name: 'Broken', type: 'loop', license: 'CC0', source: 'Nowhere' },
  ]
}

function utf8(text: string) {
  const encoded = new TextEncoder().encode(text)
  return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength)
}

function sine(freq: number, seconds: number, sampleRate: number) {
  const data = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5
  return data
}

function cents(hz: number, ref: number) {
  return 1200 * Math.log2(hz / ref)
}

describe('sound library', () => {
  it('keeps only free sounds and ignores a missing index', async () => {
    expect(licenseAllowed('CC0-1.0')).toBe(true)
    expect(licenseAllowed('Public Domain')).toBe(true)
    expect(licenseAllowed('Unlicense')).toBe(true)
    expect(licenseAllowed('CC-BY-4.0')).toBe(false)
    const parsed = parseCatalog(rawIndex())
    expect(parsed.map((entry) => entry.id)).toEqual(['dust', 'pad', 'hat'])
    expect(parseCatalog({ sounds: fixture })).toEqual([])

    const missing = await loadSoundCatalog(async () => new Response('missing', { status: 404 }))
    expect(missing).toEqual({ entries: [], status: 'missing' })
    expect(catalogMessage(missing, 0, false)).toBe('The sound library is not online yet.')

    const cache = new SoundCache([memoryByteStore()])
    await cache.put(soundIndexUrl(), utf8(JSON.stringify(rawIndex())))
    const offline = await loadSoundCatalog(async () => { throw new Error('offline') }, cache)
    expect(offline.status).toBe('ok')
    expect(offline.entries.map((entry) => entry.id)).toEqual(['dust', 'pad', 'hat'])
  })

  it('filters by tag, kind, tempo, key, and favorites', () => {
    expect(bpmMatchesProject(120, 60)).toBe(true)
    expect(bpmMatchesProject(124, 120)).toBe(true)
    expect(bpmMatchesProject(120, 90)).toBe(false)
    const favorites = ['hat']
    expect(filterSounds(fixture, { text: 'dusty', type: 'all', bpm: 'any', key: '', favoritesOnly: false, projectBpm: 120, favorites }).map((entry) => entry.id)).toEqual(['dust'])
    expect(filterSounds(fixture, { text: '', type: 'one-shot', bpm: 'any', key: '', favoritesOnly: false, projectBpm: 120, favorites }).map((entry) => entry.id)).toEqual(['hat'])
    expect(filterSounds(fixture, { text: '', type: 'loop', bpm: 'project', key: '', favoritesOnly: false, projectBpm: 60, favorites }).map((entry) => entry.id)).toEqual(['dust'])
    expect(filterSounds(fixture, { text: '', type: 'all', bpm: 'any', key: 'C', favoritesOnly: false, projectBpm: 120, favorites }).map((entry) => entry.id)).toEqual(['pad'])
    expect(filterSounds(fixture, { text: '', type: 'all', bpm: 'any', key: '', favoritesOnly: true, projectBpm: 120, favorites }).map((entry) => entry.id)).toEqual(['hat'])
  })

  it('fetches library files from Hugging Face and replays them from storage', async () => {
    const url = soundFileUrl('loops/dust.wav')
    expect(url).toBe('https://huggingface.co/datasets/cueharbor/sound-library/resolve/main/loops/dust.wav')
    expect(() => soundFileUrl('../secret.wav')).toThrow(/Hugging Face/)
    expect(() => soundFileUrl('https://cueharbor.onrender.com/loops/dust.wav')).toThrow(/Hugging Face|library/)
    expect(() => assertSoundUrl('https://cueharbor.onrender.com/api/sounds/dust.wav')).toThrow(/Hugging Face/)

    const durable = memoryByteStore()
    const first = new SoundCache([memoryByteStore(), durable])
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return new Response(new Uint8Array([9, 8, 7, 6]))
    }
    const bytes = await fetchSoundBytes(url, fetchImpl, first)
    const refreshed = new SoundCache([memoryByteStore(), durable])
    const again = await fetchSoundBytes(url, fetchImpl, refreshed)
    expect(calls).toBe(1)
    expect([...new Uint8Array(again)]).toEqual([...new Uint8Array(bytes)])

    let proxied = false
    await expect(fetchSoundBytes('https://cueharbor.onrender.com/api/sounds/dust.wav', async () => {
      proxied = true
      return new Response(new Uint8Array([1]))
    }, first)).rejects.toThrow(/Hugging Face/)
    expect(proxied).toBe(false)
  })

  it('conforms loops to the project tempo and keeps the pitch', () => {
    const project = createEmptyProject(48000)
    project.tempo = 90
    const loop = new Float32Array(48000)
    const placed = placeSound({
      entry: fixture[0],
      channels: [loop],
      fileRate: 48000,
      project,
      startSample: 24000,
      bufferId: 'lib_dust',
      clipId: 'clip_dust',
    })
    expect(placed?.clip.stretch?.followTempo).toBe(true)
    expect(placed?.clip.stretch?.sourceBpm).toBe(120)
    expect(placed?.clip.stretch?.mode).toBe('beats')
    expect(placed?.clip.durationSamples).toBe(64000)
    expect(placed?.clip.startSample).toBe(24000)
    expect(placed?.asset.sampleRate).toBe(48000)

    const shot = placeSound({
      entry: fixture[2],
      channels: [loop],
      fileRate: 48000,
      project,
      startSample: 0,
    })
    expect(shot?.clip.stretch?.followTempo).toBe(false)
    expect(shot?.clip.durationSamples).toBe(48000)

    const store = new ProjectStore(project)
    const track = store.project.tracks.find((item) => item.type === 'audio')!
    store.addAsset(placed!.asset)
    store.addAudioClip(track.id, placed!.clip)
    store.setTempo(60)
    expect(track.clips[0].durationSamples).toBe(96000)

    const tone = sine(440, 0.5, 48000)
    const slow = createEmptyProject(48000)
    slow.tempo = 60
    const preview = previewChannelsFor(fixture[1], [tone], 48000, slow, 0)
    expect(preview[0].length).toBeGreaterThan(tone.length * 1.2)
    const start = Math.floor(preview[0].length * 0.35)
    const hz = yinPitch(preview[0].subarray(start, start + 4096), 48000, 220, 880).hz
    expect(Math.abs(cents(hz, 440))).toBeLessThan(20)
  })

  it('shares favorites through the project journal', () => {
    const host = new ProjectStore(createEmptyProject(48000, 'Sounds'))
    const guest = new ProjectStore(structuredClone(host.project) as Project)
    host.toggleSoundFavorite('dust')
    const ops = host.sync.drain()
    expect(ops.map((op) => op.p)).toContain('soundFavorites')
    guest.applyRemoteOps(ops)
    expect(selectSounds(guest).favorites).toEqual(['dust'])
    expect(selectSounds(host).trackName).toBe('Vocal')
    host.toggleSoundFavorite('dust')
    guest.applyRemoteOps(host.sync.drain())
    expect(selectSounds(guest).favorites).toEqual([])
    const fresh = createEmptyProject()
    expect(isUntouchedEmpty(fresh)).toBe(true)
    fresh.soundFavorites = ['dust']
    expect(isUntouchedEmpty(fresh)).toBe(false)

    const midi = host.project.tracks.find((track) => track.type === 'midi')!
    expect(audioTrackFor(host.project, midi.id, midi.id)).toBe(host.project.tracks.find((track) => track.type === 'audio')!.id)
    expect(trackIdFromDrop({ closest: () => ({ getAttribute: () => 'trk_drop' }) })).toBe('trk_drop')
    expect(trackIdFromDrop(null)).toBeNull()
  })

  it('decodes a wav without a server and shows license and source', async () => {
    const tone = sine(220, 0.05, 8000)
    const decoded = await decodeSoundBytes(encodeWav([tone], 8000))
    expect(decoded.sampleRate).toBe(8000)
    expect(decoded.channels[0].length).toBe(tone.length)

    const store = new ProjectStore(createEmptyProject())
    const markup = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine: {
        unlock() {},
        stopPreview() {},
        previewPcm() {},
        currentTimelineSample: () => 0,
      },
      onClose: () => undefined,
      initial: { entries: fixture, status: 'ok' },
    }))
    expect(markup).toContain('CC0 · Acoustic Commons')
    expect(markup).toContain('Unlicense · Public domain kit')
    expect(markup).toContain('Play on the speakers at the song tempo.')
    expect(markup).toContain('Adds to Vocal at the playhead.')
    expect(markup).not.toContain('CC-BY')

    const missing = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: false,
      engine: {
        unlock() {},
        stopPreview() {},
        previewPcm() {},
        currentTimelineSample: () => 0,
      },
      onClose: () => undefined,
      initial: { entries: [], status: 'missing' },
    }))
    expect(missing).toContain('The sound library is not online yet.')
    expect(missing).toContain('Drag a sound onto a track')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { MemoryBank, SampleCache } from '../audio/multisample/cache'
import { renderSampler } from '../audio/multisample/engine'
import { LibraryHost } from '../audio/multisample/host'
import { fetchCatalog } from '../audio/multisample/library'
import { makeProgram, makeSample, makeZone, midiVelocity } from '../audio/multisample/types'
import type { LibraryEntry } from '../audio/multisample/library'
import { createEmptyProject } from '../model/types'
import { encodeWav } from '../model/wav'
import { filterSounds, parseCatalog } from '../sounds/catalog'
import { boundLibraryHost, filterStarters, loadStarterOnto, placeholderInstrumentName, playableAudition, playablePitch } from '../sounds/instruments'
import {
  SOUND_PANEL_DEFAULT,
  SOUND_PANEL_MAX,
  SOUND_PANEL_MIN,
  clampSoundWidth,
  matchCountLabel,
  readSoundWidth,
  soundWidthFromDrag,
  writeSoundWidth,
  type SoundWidthMemory,
} from '../sounds/panel'
import { soundFileUrl } from '../sounds/source'
import type { SoundEntry } from '../sounds/types'
import { ProjectStore } from '../state/store'
import { PatchSheet } from '../ui/PatchSheet'
import { SoundBrowser } from '../ui/SoundBrowser'

const loops: SoundEntry[] = [
  {
    id: 'loops-drums-boom-bap-88bpm',
    path: 'loops/drums/boom-bap_88bpm.wav',
    name: 'Boom Bap 88 BPM (2 bars)',
    type: 'loop',
    tags: ['drums', 'loop', 'boom-bap'],
    bpm: 88,
    durationSec: 5.455,
    sampleRate: 44100,
    license: 'CC0-1.0',
    source: 'https://github.com/sfzinstruments/karoryfer.gogodze-phu-vol-ii',
  },
  {
    id: 'loops-keys-felt-piano-g-120',
    path: 'loops/keys/felt-piano-g-120.wav',
    name: 'Felt Piano Arpeggio in G major 120 BPM',
    type: 'loop',
    tags: ['piano', 'loop'],
    bpm: 120,
    key: 'G major',
    durationSec: 4,
    sampleRate: 44100,
    license: 'Public Domain',
    source: 'https://github.com/sgossner/VCSL',
  },
  {
    id: 'ones-agogo',
    path: 'oneshots/agogo.wav',
    name: 'Agogo Bells',
    type: 'one-shot',
    tags: ['bell'],
    durationSec: 0.4,
    sampleRate: 44100,
    license: 'CC0-1.0',
    source: 'https://github.com/sgossner/VCSL/tree/master/Idiophones',
  },
]

const xylophone: LibraryEntry = {
  id: 'xylophone',
  name: 'Xylophone',
  license: 'CC0-1.0',
  path: 'xylophone/instrument.sfz',
  bytes: 10,
  description: 'CC0 xylophone',
  category: 'mallets',
  tags: ['mallet', 'wood'],
}

function memory(): SoundWidthMemory {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
  }
}

function engineStub() {
  return {
    unlock() {},
    stopPreview() {},
    previewPcm() {},
    currentTimelineSample: () => 0,
    previewPatch() {},
    holdLibraryPack() {},
    holdLibraryAudio() {},
    auditionLibrary: async () => undefined,
  }
}

describe('library access', () => {
  it('keeps the loops in the sound index and does not treat credit links as audio', () => {
    const parsed = parseCatalog(loops)
    expect(parsed.map((entry) => entry.id)).toEqual(loops.map((entry) => entry.id))
    const query = { text: '', type: 'loop' as const, bpm: 'any' as const, key: '', favoritesOnly: false, projectBpm: 120, favorites: [] as string[] }
    expect(filterSounds(parsed, query).map((entry) => entry.id)).toEqual([
      'loops-drums-boom-bap-88bpm',
      'loops-keys-felt-piano-g-120',
    ])
    expect(filterSounds(parsed, { ...query, type: 'instrument' })).toEqual([])
    const file = soundFileUrl(loops[0].path)
    expect(file).toBe('https://huggingface.co/datasets/cueharbor/sound-library/resolve/main/loops/drums/boom-bap_88bpm.wav')
    expect(file).not.toContain('github.com')
    expect(() => soundFileUrl(loops[0].source)).toThrow(/Hugging Face/)
    expect(() => soundFileUrl('https://cueharbor.onrender.com/loops/a.wav')).toThrow(/Hugging Face/)
    expect(() => soundFileUrl('https://cdn.cloudflare.com/loops/a.wav')).toThrow(/Hugging Face/)
  })

  it('lists starter instruments when the sound index has none', async () => {
    expect(playablePitch({ zones: [{ trigger: 'attack', root: 67, lokey: 63, hikey: 69 }] })).toBe(67)
    expect(playablePitch({ zones: [] })).toBe(60)
    expect(filterStarters([xylophone], { text: 'wood', type: 'instrument', favoritesOnly: false, favorites: [] }).map((entry) => entry.id)).toEqual(['xylophone'])
    expect(filterStarters([xylophone], { text: '', type: 'loop', favoritesOnly: false, favorites: [] })).toEqual([])
    expect(filterStarters([xylophone], { text: '', type: 'all', favoritesOnly: true, favorites: [] })).toEqual([])
    const catalog = await fetchCatalog('https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main', async () => new Response(JSON.stringify({
      instruments: [
        xylophone,
        { id: 'paid', name: 'Paid', license: 'CC-BY-4.0', path: 'paid/a.sfz', bytes: 1, description: '' },
      ],
    })))
    expect(catalog.map((entry) => entry.id)).toEqual(['xylophone'])
    expect(catalog[0].tags).toEqual(['mallet', 'wood'])
    expect(catalog[0].category).toBe('mallets')
  })

  it('remembers a panel width inside the min and max', () => {
    const store = memory()
    expect(readSoundWidth(store, 1440)).toBe(SOUND_PANEL_DEFAULT)
    expect(clampSoundWidth(900, 1440)).toBe(SOUND_PANEL_MAX)
    expect(clampSoundWidth(10, 1440)).toBe(SOUND_PANEL_MIN)
    expect(clampSoundWidth(400, 600)).toBe(SOUND_PANEL_MIN)
    expect(soundWidthFromDrag(360, 80, 1440)).toBe(440)
    expect(soundWidthFromDrag(360, -400, 1440)).toBe(SOUND_PANEL_MIN)
    expect(writeSoundWidth(480, store, 1440)).toBe(480)
    expect(readSoundWidth(store, 1440)).toBe(480)
    expect(readSoundWidth(store, 700)).toBe(380)
    expect(clampSoundWidth(520, 1200, 400)).toBe(480)
    expect(clampSoundWidth(900, 1200, 700)).toBe(SOUND_PANEL_MIN)
    expect(matchCountLabel(1647, 200)).toBe('1647 matches. Showing the first 200.')
    expect(matchCountLabel(34, 34)).toBe('34 matches.')
    expect(matchCountLabel(0, 0)).toBe('')
  })

  it('shows starter instruments, loop totals, and credit text that is not a download link', () => {
    const store = new ProjectStore(createEmptyProject())
    const markup = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: false,
      engine: engineStub(),
      onClose: () => undefined,
      initial: { entries: loops, status: 'ok' },
      instruments: [xylophone],
    }))
    expect(markup).toContain('Xylophone')
    expect(markup).toContain('Boom Bap 88 BPM')
    expect(markup).toContain('4 matches.')
    expect(markup).toContain('Hugging Face')
    expect(markup).toContain('https://github.com/sgossner/VCSL')
    expect(markup).not.toContain('href="https://github.com')
    expect(markup).toContain('data-sound-panel')
    expect(markup).toContain('Adds to Vocal at the playhead. Loads onto Keys.')

    const phone = renderToStaticMarkup(createElement(SoundBrowser, {
      store,
      phone: true,
      engine: engineStub(),
      onClose: () => undefined,
      initial: { entries: loops, status: 'ok' },
      instruments: [xylophone],
    }))
    expect(phone).toContain('sound-back sheet')
    expect(phone).toContain('sound-dismiss')
    expect(phone).not.toContain('sound-resize')
    expect(phone).toContain('Close')
    expect(phone).toContain('Load. Load it on this track and play a note.')
    expect(phone).toContain('>Drums</option>')
    expect(phone).not.toContain('role="dialog"')
  })

  it('fills the patch Load menu and plays a starter instrument from Hugging Face audio', async () => {
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.openPatch(keys.id)
    const sheet = renderToStaticMarkup(createElement(PatchSheet, {
      store,
      engine: engineStub() as unknown as AudioEngine,
      trackId: keys.id,
      initialCatalog: [xylophone],
    }))
    expect(sheet).toContain('Starter instruments')
    expect(sheet).toContain('Xylophone')
    expect(sheet).toContain('starter:xylophone')
    expect(sheet).not.toContain('>Load</option></select>')

    const urls: string[] = []
    const tone = new Float32Array(4800)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.5
    const wav = encodeWav([tone], 48000)
    const sfz = '<region> sample=samples/c4.wav key=c4\n'
    const fetchImpl = async (url: string) => {
      urls.push(url)
      expect(url.startsWith('https://huggingface.co/datasets/cueharbor/')).toBe(true)
      expect(url).not.toMatch(/github\.com|onrender\.com|cloudflare/)
      if (url.endsWith('.sfz')) return new Response(sfz)
      return new Response(wav)
    }
    const pitches: number[] = []
    await loadStarterOnto(xylophone, keys.id, {
      setLibrary: (id, program) => store.setLibrary(id, program),
      auditionLibrary: async (_id, pitch) => { pitches.push(pitch ?? 0) },
    }, { fetchImpl })
    const program = store.track(keys.id)!.library!
    expect(store.track(keys.id)!.instrument).toBe('library')
    expect(program.name).toBe('Xylophone')
    expect(program.id).toBe('xylophone')
    expect(program.samples[0].url).toBe('https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main/xylophone/samples/c4.wav')
    expect(pitches).toEqual([60])
    expect(store.track(keys.id)!.name).toBe('Xylophone')
    expect(placeholderInstrumentName('Keys')).toBe(true)
    expect(placeholderInstrumentName('Sampler')).toBe(true)
    expect(placeholderInstrumentName('Sampler 2')).toBe(true)
    expect(placeholderInstrumentName('Verse')).toBe(false)
    store.updateTrack(keys.id, { name: 'Verse' })
    store.setLibrary(keys.id, { ...program, name: 'Clarinet' })
    expect(store.track(keys.id)!.name).toBe('Verse')
    expect(store.track(keys.id)!.instrument).toBe('library')
    store.updateTrack(keys.id, { name: 'Clarinet' })
    store.setLibrary(keys.id, { ...store.track(keys.id)!.library!, name: 'Bassoon' })
    expect(store.track(keys.id)!.name).toBe('Bassoon')
    expect(urls.every((url) => url.includes('huggingface.co/datasets/cueharbor/'))).toBe(true)

    const cache = new SampleCache(fetchImpl)
    const decoded = await cache.load(program.samples[0])
    const bank = new MemoryBank()
    bank.put(program.samples[0].id, decoded!)
    const played = renderSampler(program, [{ sample: 0, pitch: 60, vel: 0.9 }], 48000, 24000, bank)
    let sum = 0
    for (const sample of played[0]) sum += sample * sample
    expect(Math.sqrt(sum / played[0].length)).toBeGreaterThan(0.02)
  })

  it('keeps unlock on the engine when a starter instrument is loaded or played', async () => {
    class Engine {
      hits = 0
      unlock() {
        this.hits += 1
      }
      holdLibraryPack() {
        this.unlock()
      }
      async auditionLibrary() {
        this.unlock()
      }
    }
    const engine = new Engine()
    const bare = {
      setLibrary() {},
      holdLibraryPack: engine.holdLibraryPack,
      auditionLibrary: engine.auditionLibrary,
    }
    await expect(bare.auditionLibrary()).rejects.toThrow('this.unlock is not a function')

    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    const tone = new Float32Array(480)
    const wav = encodeWav([tone], 48000)
    const fetchImpl = async (url: string) => (url.endsWith('.sfz') ? new Response('<region> sample=samples/c4.wav key=c4\n') : new Response(wav))
    await loadStarterOnto(xylophone, keys.id, boundLibraryHost(engine, (id, program) => store.setLibrary(id, program)), { fetchImpl })
    expect(engine.hits).toBeGreaterThan(0)
    expect(store.track(keys.id)!.instrument).toBe('library')
    expect(store.track(keys.id)!.name).toBe('Xylophone')
    expect(store.track(keys.id)!.library?.id).toBe('xylophone')
  })

  it('picks a note the velocity layers can sound and loads every round-robin before playback', async () => {
    const base = 'https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main'
    const quiet = makeProgram({
      name: 'Quiet',
      samples: [makeSample({ id: 'low', url: `${base}/quiet/low.wav` })],
      zones: [makeZone({ id: 'z', sampleId: 'low', lokey: 40, hikey: 40, root: 40, lovel: 1, hivel: 20 })],
    })
    const quietNote = playableAudition(quiet)
    expect(quietNote.pitch).toBe(40)
    expect(midiVelocity(quietNote.velocity)).toBeLessThanOrEqual(20)
    expect(midiVelocity(quietNote.velocity)).toBeGreaterThan(0)

    const split = makeProgram({
      name: 'Split',
      samples: [
        makeSample({ id: 'low', url: `${base}/split/low.wav` }),
        makeSample({ id: 'high', url: `${base}/split/high.wav` }),
      ],
      zones: [
        makeZone({ id: 'low', sampleId: 'low', lokey: 40, hikey: 40, root: 40, lovel: 1, hivel: 20 }),
        makeZone({ id: 'high', sampleId: 'high', lokey: 67, hikey: 67, root: 67, lovel: 21, hivel: 127 }),
      ],
    })
    expect(playablePitch(split)).toBe(67)
    expect(playableAudition(split).velocity).toBe(0.9)

    const urls: string[] = []
    const tone = new Float32Array(480)
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 48000) * 0.4
    const wav = encodeWav([tone], 48000)
    const host = new LibraryHost(async (url) => {
      urls.push(url)
      if (url.endsWith('rr2.wav')) return new Response('missing', { status: 404 })
      return new Response(wav)
    })
    const store = new ProjectStore(createEmptyProject())
    const keys = store.project.tracks.find((track) => track.name === 'Keys')!
    store.setLibrary(keys.id, makeProgram({
      name: 'Rounds',
      samples: [
        makeSample({ id: 'rr1', url: `${base}/rounds/rr1.wav` }),
        makeSample({ id: 'rr2', url: `${base}/rounds/rr2.wav` }),
      ],
      zones: [
        makeZone({ id: 'a', sampleId: 'rr1', lokey: 60, hikey: 60, root: 60, seq: 1, seqLength: 2, rrGroup: 1 }),
        makeZone({ id: 'b', sampleId: 'rr2', lokey: 60, hikey: 60, root: 60, seq: 2, seqLength: 2, rrGroup: 1 }),
      ],
    }))
    const ready = await host.prepare(keys.id, store.track(keys.id)!, [
      { sample: 0, pitch: 60, vel: 0.9 },
      { sample: 4800, pitch: 60, vel: 0.9 },
    ], 48000)
    expect(urls.filter((url) => url.endsWith('rr1.wav'))).toHaveLength(1)
    expect(urls.some((url) => url.endsWith('rr2.wav'))).toBe(true)
    expect(ready.sounding).toBe(2)
    expect(ready.missing).toBe(1)
    const outside = await host.prepare(keys.id, store.track(keys.id)!, [{ sample: 0, pitch: 10, vel: 0.9 }], 48000)
    expect(outside).toEqual({ missing: 0, sounding: 0 })

    let fetches = 0
    const cache = new SampleCache(async () => {
      fetches += 1
      return new Response(wav)
    })
    const shared = makeSample({ id: 'shared', url: `${base}/rounds/shared.wav` })
    const [first, second] = await Promise.all([cache.load(shared), cache.load(shared)])
    expect(fetches).toBe(1)
    expect(first?.channels[0].length).toBeGreaterThan(0)
    expect(second).toBe(first)
  })
})

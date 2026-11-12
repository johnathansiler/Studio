import { afterEach, describe, expect, it, vi } from 'vitest'
import { selectLayers } from '../audio/multisample/map'
import { midiVelocity } from '../audio/multisample/types'
import { browseLibraryRows } from '../library/browse'
import { groupLibraryInstruments, layersForNotes, midiName, noteMidi, planSignKeys, playbackKeys, searchInstruments, tokenizeStem } from '../library/group'
import { programFromLibraryInstrument } from '../library/instrumentProgram'
import { createLibraryApi, type LibraryEnv } from '../../server/library.ts'
import { clearLibraryAccessKey, writeLibraryAccessKey } from '../library/access'
import { memoryAudioCache, setLibraryCaches } from '../library/audio'
import { rememberInstrumentLayers } from '../library/instrumentsApi'
import { librarySampleUrl, loadLibrarySampleBytes } from '../library/samples'
import { buildLibraryIndex } from '../library/search'
import type { LibraryEntry } from '../library/types'

const env: LibraryEnv = {
  R2_ACCOUNT_ID: '2001009ff8860d62eac085ee8cce34e2',
  R2_BUCKET: 'cueharbor-private-sounds',
  R2_ACCESS_KEY_ID: 'AKIDEXAMPLE',
  R2_SECRET_ACCESS_KEY: 'secretsecretsecretsecretsecret12',
  LIBRARY_ACCESS_KEY: 'owner-pass',
}

function row(key: string, extra: Partial<LibraryEntry> = {}): LibraryEntry {
  return {
    key,
    size: extra.size ?? 100,
    format: 'wav',
    pack: extra.pack ?? 'Philharmonia Orchestra All Samples',
    type: extra.type ?? 'multisample note',
    category: extra.category ?? 'brass',
    instrument: extra.instrument ?? 'french horn',
    genre: [],
    bpm: null,
    bpmAlt: null,
    musicalKey: '',
    root: extra.root ?? '',
    note: extra.note ?? '',
    mood: [],
    tags: [],
    license: 'private',
    name: key.split('/').pop() || key,
  }
}

describe('multisample grouping', () => {
  it('reads note, velocity, round-robin, and flat names out of a filename', () => {
    expect(tokenizeStem('french-horn_A4_15_mezzo-forte_normal').map((token) => token.kind === 'note' ? token.midi : token.kind === 'vel' ? token.id : token.kind === 'word' ? token.raw : token.kind)).toEqual(['french-horn', noteMidi('A4'), 'num', 'mezzo-forte', 'normal'])
    expect(noteMidi('Db2')).toBe(noteMidi('C#2'))
    expect(noteMidi('As4')).toBe(noteMidi('A#4'))
    expect(tokenizeStem('A0v1').some((token) => token.kind === 'note' && token.midi === noteMidi('A0'))).toBe(true)
    expect(tokenizeStem('A0v1').some((token) => token.kind === 'vel' && token.id === 'v1')).toBe(true)
    expect(tokenizeStem('db2_vl1_rr3_1').some((token) => token.kind === 'note' && token.midi === noteMidi('Db2'))).toBe(true)
    expect(tokenizeStem('twang_g6_mf_rr1').some((token) => token.kind === 'rr' && token.n === 1)).toBe(true)
    expect(midiName(60)).toBe('C4')
    expect(noteMidi('D#3')).toBe(51)
    const sharp = tokenizeStem('harmLD#3').filter((token) => token.kind === 'note' || token.kind === 'word')
    expect(sharp.some((token) => token.kind === 'note' && token.midi === noteMidi('D#3'))).toBe(true)
    expect(tokenizeStem('5_F').some((token) => token.kind === 'note' && token.midi === noteMidi('F5'))).toBe(true)
    expect(tokenizeStem('5_A-PB').some((token) => token.kind === 'note' && token.midi === noteMidi('A5'))).toBe(true)
    expect(tokenizeStem('039-D#').some((token) => token.kind === 'word' && token.raw === 'D#')).toBe(true)
    expect(tokenizeStem('OneShot_07_VRC6_Saw_Lead_F4').some((token) => token.kind === 'note' && token.midi === noteMidi('C6'))).toBe(false)
    expect(tokenizeStem('OneShot_07_VRC6_Saw_Lead_F4').some((token) => token.kind === 'note' && token.midi === noteMidi('F4'))).toBe(true)
    expect(tokenizeStem('twang_c4_f_rr1').some((token) => token.kind === 'vel' && token.id === 'f')).toBe(true)
  })

  it('turns notes into one instrument per articulation and keeps dynamics as layers', () => {
    const folder = 'Orchestral/Philharmonia Orchestra All Samples/french horn'
    const entries = [
      row(`${folder}/french-horn_A4_15_mezzo-forte_normal.mp3`, { note: 'A4', size: 10 }),
      row(`${folder}/french-horn_A4_1_piano_normal.mp3`, { note: 'A4', size: 4 }),
      row(`${folder}/french-horn_C4_very-long_forte_normal.mp3`, { note: 'C4', size: 20 }),
      row(`${folder}/french-horn_C3_05_piano_staccato.mp3`, { note: 'C3', size: 8 }),
      row(`${folder}/french-horn_C4_15_forte_staccato.mp3`, { note: 'C4', size: 9 }),
      row('Instruments/Salamander/44.1khz16bit/A0v1.wav', { pack: 'Salamander', category: 'piano', note: 'A0' }),
      row('Instruments/Salamander/44.1khz16bit/A0v16.wav', { pack: 'Salamander', category: 'piano', note: 'A0', size: 30 }),
      row('Instruments/Salamander/44.1khz16bit/C4v8.wav', { pack: 'Salamander', category: 'piano', note: 'C4' }),
      row('Guitars/black/ord/twang_g6_mf_rr1.wav', { pack: 'Karoryfer', category: 'guitar', note: 'G6' }),
      row('Guitars/black/ord/twang_g6_mf_rr2.wav', { pack: 'Karoryfer', category: 'guitar', note: 'G6' }),
      row('Guitars/black/ord/twang_a3_f_rr1.wav', { pack: 'Karoryfer', category: 'guitar', note: 'A3' }),
      row('Guitars/shiny/db2_vl1_rr3_1.wav', { pack: 'Shiny', category: 'guitar', note: 'C#2' }),
      row('Guitars/shiny/db2_vl2_rr1_1.wav', { pack: 'Shiny', category: 'guitar', note: 'C#2' }),
      row('Singles/solo.wav', { pack: 'Solo', type: 'multisample note', category: 'keys', note: 'C3' }),
      row('Drums/kick.wav', { pack: 'Kit', type: 'one-shot', category: 'kick', note: 'C1' }),
    ]
    const instruments = groupLibraryInstruments(entries)
    const names = instruments.map((item) => item.name)
    expect(names).toContain('French Horn - Normal')
    expect(names).toContain('French Horn - Staccato')
    expect(names).not.toContain('French Horn - Mezzo Forte')
    const horn = instruments.find((item) => item.name === 'French Horn - Normal')!
    expect(horn.notes).toBe(2)
    expect(horn.velocities).toBeGreaterThan(1)
    expect(horn.previewMidi).toBe(noteMidi('C4'))
    expect(horn.layers.filter((layer) => layer.midi === noteMidi('A4'))).toHaveLength(2)
    const salamander = instruments.find((item) => item.pack === 'Salamander')!
    expect(salamander.notes).toBe(2)
    expect(salamander.velocities).toBe(3)
    const twang = instruments.find((item) => item.name.includes('Twang'))!
    expect(twang.roundRobins).toBe(2)
    const shiny = instruments.find((item) => item.pack === 'Shiny')!
    expect(new Set(shiny.layers.map((layer) => layer.midi))).toEqual(new Set([noteMidi('Db2')]))
    expect(new Set(shiny.layers.map((layer) => layer.rr)).size).toBeGreaterThan(1)
    const solo = instruments.find((item) => item.pack === 'Solo')!
    expect(solo.samples).toBe(1)
    expect(instruments.some((item) => item.name === 'kick')).toBe(false)

    const program = programFromLibraryInstrument(horn)
    const low = selectLayers(program, { note: 40, velocity: midiVelocity(0.2), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    const mid = selectLayers(program, { note: 60, velocity: midiVelocity(0.95), keyswitch: null, roundRobin: {}, trigger: 'attack' })
    expect(low.layers[0]?.zone.root).toBe(noteMidi('A4'))
    expect(mid.layers[0]?.zone.root).toBe(noteMidi('C4'))
    expect(low.layers[0]?.sample.id).not.toBe(mid.layers[0]?.sample.id)
    const one = programFromLibraryInstrument(solo)
    expect(one.zones.every((zone) => zone.lokey === 0 && zone.hikey === 127)).toBe(true)
    expect(one.zones[0]?.root).toBe(noteMidi('C3'))

    const page = searchInstruments(instruments, { text: 'staccato', category: '', pack: '', offset: 0, limit: 10 })
    expect(page.total).toBe(1)
    expect(page.instruments[0]?.name).toBe('French Horn - Staccato')
    expect(page.instruments[0]).not.toHaveProperty('layers')
    const signed = layersForNotes(horn, { notes: [60] })
    expect(signed.every((layer) => layer.midi === 60)).toBe(true)
    expect(layersForNotes(horn, { notes: [60] }).length).toBeLessThanOrEqual(24)

    const organ = groupLibraryInstruments([
      row('Organ/great-bourdon16ft/036-C.flac', { pack: 'Sonatina', note: '' }),
      row('Organ/great-bourdon16ft/039-D#.flac', { pack: 'Sonatina', note: '' }),
      row('Organ/great-bourdon16ft/042-F#.flac', { pack: 'Sonatina', note: '' }),
      row('Organ/great-bourdon16ft/060-C.flac', { pack: 'Sonatina', note: '' }),
    ])
    expect(organ).toHaveLength(1)
    expect(organ[0]?.name.toLowerCase()).not.toContain('organ d')
    expect(new Set(organ[0]?.layers.map((layer) => layer.midi))).toEqual(new Set([36, 39, 42, 60]))

    const vib = groupLibraryInstruments([
      row('Violin/PizzicatoVib/5_A-PB.wav', { pack: 'VPO', note: '' }),
      row('Violin/PizzicatoVib/5_F-PB.wav', { pack: 'VPO', note: '' }),
      row('Violin/PizzicatoVib/5_Bb-PB.wav', { pack: 'VPO', note: '' }),
      row('Violin/PizzicatoVib/4_C-PB.wav', { pack: 'VPO', note: '' }),
    ])
    expect(vib).toHaveLength(1)
    expect(new Set(vib[0]?.layers.map((layer) => layer.midi))).toEqual(new Set([
      noteMidi('A5'), noteMidi('F5'), noteMidi('Bb5'), noteMidi('C4'),
    ]))

    const harm = groupLibraryInstruments([
      row('Piano/harmLA0.wav', { pack: 'Salamander', note: 'A0' }),
      row('Piano/harmLC4.wav', { pack: 'Salamander', note: 'C4' }),
      row('Piano/harmLD#3.wav', { pack: 'Salamander', note: '' }),
      row('Piano/harmSA0.wav', { pack: 'Salamander', note: 'A0' }),
    ])
    const harmL = harm.find((item) => item.name.toLowerCase().includes('l') && !item.name.toLowerCase().includes('s'))
    const harmMidis = [noteMidi('A0'), noteMidi('D#3'), noteMidi('C4')].flatMap((midi) => midi == null ? [] : [midi]).sort((a, b) => a - b)
    expect(harmL?.layers.map((layer) => layer.midi).sort((a, b) => a - b)).toEqual(harmMidis)
    expect(harm.find((item) => item.layers.some((layer) => layer.key.endsWith('harmSA0.wav')))?.layers).toHaveLength(1)

    const rhodes = groupLibraryInstruments([
      row('Rhodes/jRhodes3d-mono-wav/A_029__F1_1.wav', { pack: 'Rhodes', note: 'F1' }),
      row('Rhodes/jRhodes3d-mono-wav/A_045__A2_1.wav', { pack: 'Rhodes', note: 'A2' }),
      row('Rhodes/jRhodes3d-mono-wav/A_081__A5_1.wav', { pack: 'Rhodes', note: 'A5' }),
    ])
    expect(rhodes).toHaveLength(1)
    expect(new Set(rhodes[0]?.layers.map((layer) => layer.midi))).toEqual(new Set([noteMidi('F1'), noteMidi('A2'), noteMidi('A5')]))

    const xylo = groupLibraryInstruments([
      ...[1, 2, 3, 4, 5, 6, 7, 44].flatMap((n) => ['A', 'B', 'C'].map((letter) => row(`Mallets/Xylophone/Xylophone Samples Pack/${letter} (${n}).wav`, { pack: 'Xylophone', note: '' }))),
    ])
    expect(xylo).toHaveLength(1)
    expect(xylo[0]?.notes).toBe(8)
    expect(xylo[0]?.roundRobins).toBe(3)
    expect(xylo[0]?.layers.find((layer) => layer.key.includes('A (1)'))?.midi).toBe(60)
    expect(xylo[0]?.layers.find((layer) => layer.key.includes('A (44)'))?.midi).toBe(103)
    expect(xylo[0]?.layers.find((layer) => layer.key.includes('C (1)'))?.rr).toBe(3)

    const near = playbackKeys(horn.layers, horn.layers.find((layer) => layer.midi === 60)!.key)
    expect(near.length).toBeLessThanOrEqual(24)
    expect(near[0]).toBe(horn.layers.find((layer) => layer.midi === 60)!.key)
    const planned = planSignKeys(horn.layers, [near[0]!], true)
    expect(planned.length).toBeLessThanOrEqual(24)
    expect(planned[0]).toBe(near[0])
    expect(planSignKeys(undefined, ['Only/one.wav', 'Only/two.wav'], false)).toEqual(['Only/one.wav', 'Only/two.wav'])
  })

  it('hides individual notes in browse and lists the instrument', () => {
    const note = row('Orchestral/Philharmonia Orchestra All Samples/french horn/french-horn_A4_15_piano_normal.mp3', { note: 'A4' })
    const kick = row('Drums/kick.wav', { type: 'one-shot', category: 'kick', pack: 'Kit', note: 'C1' })
    const index = buildLibraryIndex([note, kick], [['french', 'horn', 'a4'], ['kick']])
    const instruments = groupLibraryInstruments([note, kick]).map(({ layers: _layers, ...summary }) => summary)
    const rows = browseLibraryRows(index, { total: 2, ids: null }, instruments, { text: '', type: '', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null })
    expect(rows.some((item) => item.kind === 'sound' && item.entry.key.endsWith('A4_15_piano_normal.mp3'))).toBe(false)
    expect(rows.some((item) => item.kind === 'instrument' && item.instrument.name === 'French Horn - Normal')).toBe(true)
    expect(rows.some((item) => item.kind === 'sound' && item.entry.key === 'Drums/kick.wav')).toBe(true)
    const only = browseLibraryRows(index, { total: 2, ids: null }, instruments, { text: '', type: 'instrument', category: '', instrument: '', genre: '', musicalKey: '', mood: '', pack: '', bpmMin: null, bpmMax: null })
    expect(only.every((item) => item.kind === 'instrument')).toBe(true)
  })
})

describe('lazy note signing', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    clearLibraryAccessKey()
    setLibraryCaches({ audio: null })
  })

  it('batches a fast chord into one request and keeps the cap at 24', async () => {
    vi.useFakeTimers()
    writeLibraryAccessKey('owner-pass')
    setLibraryCaches({ audio: memoryAudioCache() })
    const layers = Array.from({ length: 40 }, (_, index) => ({
      key: `Piano/n${index}.wav`,
      midi: 40 + index,
      velLo: 1,
      velHi: 127,
      rr: 1,
      release: false,
      size: 10,
    }))
    rememberInstrumentLayers('lib_piano', layers)
    const bodies: { keys?: string[] }[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/notes')) {
        const body = JSON.parse(String(init?.body || '{}')) as { keys?: string[] }
        bodies.push(body)
        return new Response(JSON.stringify({
          urls: (body.keys ?? []).map((key) => ({ key, url: `https://signed.example/${encodeURIComponent(key)}` })),
        }))
      }
      return new Response(Uint8Array.from([82, 73, 70, 70]).buffer)
    }))
    const first = loadLibrarySampleBytes(librarySampleUrl('lib_piano', layers[10]!.key), true)
    const second = loadLibrarySampleBytes(librarySampleUrl('lib_piano', layers[12]!.key), true)
    await vi.advanceTimersByTimeAsync(40)
    const [a, b] = await Promise.all([first, second])
    expect(a.byteLength).toBeGreaterThan(0)
    expect(b.byteLength).toBeGreaterThan(0)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.keys?.length).toBeGreaterThan(2)
    expect(bodies[0]?.keys?.length).toBeLessThanOrEqual(24)
    expect(bodies[0]?.keys).toContain(layers[10]!.key)
    expect(bodies[0]?.keys).toContain(layers[12]!.key)
    const again = await loadLibrarySampleBytes(librarySampleUrl('lib_piano', layers[10]!.key), true)
    expect(again.byteLength).toBeGreaterThan(0)
    expect(bodies).toHaveLength(1)
  })
})

describe('instrument api', () => {
  it('lists instruments and presigns only the notes that were asked for', async () => {
    const folder = 'Orchestral/Horns/french horn'
    const entries = [48, 60, 72].flatMap((midi) => ['piano', 'forte'].map((dynamic) => row(`${folder}/french-horn_${midiName(midi)}_1_${dynamic}_normal.mp3`, { note: midiName(midi) })))
    const instruments = groupLibraryInstruments(entries)
    const horn = instruments[0]!
    let signed: string[] = []
    const api = createLibraryApi({
      env: () => env,
      sign: async (key) => {
        signed.push(key)
        return `https://library.example/signed?key=${encodeURIComponent(key)}`
      },
      instruments: {
        async search(query) {
          return searchInstruments(instruments, query)
        },
        async get(id) {
          return instruments.find((item) => item.id === id) ?? null
        },
      },
    })
    const denied = await api.handle({ method: 'GET', pathname: '/api/library/instruments', search: '', ip: '1.1.1.1', accessKey: 'nope', body: null, now: 1 })
    expect(denied.status).toBe(401)
    const page = await api.handle({ method: 'GET', pathname: '/api/library/instruments', search: '?q=french&limit=10', ip: '1.1.1.1', accessKey: 'owner-pass', body: null, now: 2 })
    expect(page.status).toBe(200)
    expect(page.body.total).toBe(1)
    expect(JSON.stringify(page.body)).not.toContain('layers')
    expect(JSON.stringify(page.body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    const map = await api.handle({ method: 'GET', pathname: `/api/library/instruments/${horn.id}`, ip: '1.1.1.1', accessKey: 'owner-pass', body: null, now: 3 })
    expect(map.status).toBe(200)
    expect(JSON.stringify(map.body)).toContain(horn.layers[0]!.key)
    expect(JSON.stringify(map.body)).not.toContain('https://')
    signed = []
    const urls = await api.handle({
      method: 'POST',
      pathname: `/api/library/instruments/${horn.id}/notes`,
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { notes: [60] },
      now: 4,
    })
    expect(urls.status).toBe(200)
    const body = urls.body as { urls: { key: string; url: string }[] }
    expect(body.urls.length).toBeGreaterThan(0)
    expect(body.urls.length).toBeLessThanOrEqual(24)
    expect(signed.every((key) => key.includes('C4'))).toBe(true)
    expect(JSON.stringify(body)).not.toContain(env.R2_SECRET_ACCESS_KEY)
    const foreign = await api.handle({
      method: 'POST',
      pathname: `/api/library/instruments/${horn.id}/notes`,
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: ['Other/secret.wav'] },
      now: 5,
    })
    expect(foreign.status).toBe(400)
    const tooMany = await api.handle({
      method: 'POST',
      pathname: `/api/library/instruments/${horn.id}/notes`,
      ip: '1.1.1.1',
      accessKey: 'owner-pass',
      body: { keys: Array.from({ length: 25 }, (_, index) => horn.layers[index % horn.layers.length]!.key) },
      now: 6,
    })
    expect(tooMany.status).toBe(400)
    const closed = createLibraryApi({ env: () => ({ ...env, R2_BUCKET: '' }), sign: async () => { signed.push('nope'); return 'https://signed.example/nope' }, instruments: { async search() { return searchInstruments(instruments, { text: '', category: '', pack: '', offset: 0, limit: 10 }) }, async get() { return horn } } })
    const hidden = await closed.handle({ method: 'GET', pathname: '/api/library/instruments', ip: '1.1.1.1', accessKey: 'owner-pass', body: null, now: 7 })
    expect(hidden.status).toBe(503)
    expect(signed).not.toContain('nope')
  })
})

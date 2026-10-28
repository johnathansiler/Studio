import { describe, expect, it } from 'vitest'
import { MemoryBank, SampleCache } from '../audio/multisample/cache'
import { SamplerInstrument, renderSampler } from '../audio/multisample/engine'
import { importInstrument } from '../audio/multisample/import'
import { importSfz } from '../audio/multisample/sfz'
import { fetchCatalog, fetchInstrument, STARTER_CATALOG } from '../audio/multisample/library'
import { selectLayers } from '../audio/multisample/map'
import { importSoundFont } from '../audio/multisample/sf2'
import { assertHuggingFaceUrl, libraryFileUrl, setLibraryBaseUrl } from '../audio/multisample/source'
import { makeProgram, makeSample, makeZone, midiVelocity, type SamplerProgram } from '../audio/multisample/types'
import { encodeWav } from '../model/wav'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'

const SFZ = `
<control> default_path=Samples/
<group> seq_length=2 sw_last=36 sw_label=sustain
<region> sample=a.wav key=c4 seq_position=1 lovel=1 hivel=80
<region> sample=b.wav key=c4 seq_position=2 lovel=1 hivel=80
<region> sample=loud.wav key=c4 lovel=81 hivel=127 seq_length=1
<region> sample=rel.wav key=c4 trigger=release seq_length=1
<group> sw_last=37 sw_label=staccato
<region> sample=stac.wav key=c4
<group> mic=room
<region> sample=room.wav lokey=c3 hikey=c5 pitch_keycenter=c4
`

function program(): SamplerProgram {
  return importInstrument('piano.sfz', SFZ).program
}

function ids(note: number, velocity: number, keyswitch: number | null, roundRobin: Record<number, number>, trigger: 'attack' | 'release' = 'attack') {
  const mapped = selectLayers(program(), {
    note,
    velocity,
    keyswitch,
    roundRobin,
    trigger,
  })
  return mapped.layers.map((layer) => layer.sample.url).sort()
}

describe('zone mapping', () => {
  const piano = program()

  it('maps a key to the zone that contains it', () => {
    expect(piano.zones.find((zone) => zone.sampleId && piano.samples.find((sample) => sample.id === zone.sampleId)?.url.endsWith('a.wav'))?.lokey).toBe(60)
    expect(ids(60, 40, 36, {})).toEqual(['Samples/a.wav', 'Samples/room.wav'])
    expect(ids(48, 40, 36, {})).toEqual(['Samples/room.wav'])
    expect(ids(84, 40, 36, {})).toEqual([])
  })

  it('picks the velocity layer and cycles round-robins', () => {
    expect(midiVelocity(0.5)).toBe(64)
    const group = piano.zones.find((zone) => zone.seqLength > 1)?.rrGroup ?? 0
    expect(ids(60, 40, 36, { [group]: 0 })).toEqual(['Samples/a.wav', 'Samples/room.wav'])
    expect(ids(60, 40, 36, { [group]: 1 })).toEqual(['Samples/b.wav', 'Samples/room.wav'])
    expect(ids(60, 40, 36, { [group]: 2 })).toEqual(['Samples/a.wav', 'Samples/room.wav'])
    expect(ids(60, 100, 36, {})).toEqual(['Samples/loud.wav', 'Samples/room.wav'])
  })

  it('latches keyswitches and keeps release samples off the attack', () => {
    expect(piano.keyswitches.map((item) => item.key).sort()).toEqual([36, 37])
    expect(ids(60, 40, 37, {})).toEqual(['Samples/room.wav', 'Samples/stac.wav'])
    expect(ids(60, 40, 36, {}, 'release')).toEqual(['Samples/rel.wav'])
    expect(ids(60, 40, 36, {}, 'attack')).not.toContain('Samples/rel.wav')
    const instrument = new SamplerInstrument(48000, new MemoryBank())
    instrument.setProgram(piano)
    expect(instrument.noteOn(36, 0.9)).toEqual([])
    expect(instrument.keyswitch()).toBe(36)
  })
})

describe('importers', () => {
  it('reads an SFZ with includes, note names, and mic positions', () => {
    const files = new Map<string, string>([['extra.sfz', '<region> sample=extra.wav key=d4\n']])
    const text = '#define $PATH Samples\n#include "extra.sfz"\n<region> sample=$PATH/c4.wav key=c4\n'
    const imported = { program: importSfz(text, 'keys', files) }
    expect(imported.program.samples.map((sample) => sample.url).sort()).toEqual(['Samples/c4.wav', 'extra.wav'])
    expect(imported.program.zones).toHaveLength(2)
  })

  it('reads a DecentSampler preset with round-robins, mics, and release', () => {
    const xml = `<?xml version="1.0"?>
<DecentSampler>
  <groups>
    <group seqMode="round_robin" mic="close">
      <sample path="rr1.wav" rootNote="60" loNote="59" hiNote="61" loVel="0" hiVel="1"/>
      <sample path="rr2.wav" rootNote="60" loNote="59" hiNote="61" loVel="0" hiVel="1"/>
    </group>
    <group mic="room">
      <sample path="room.wav" rootNote="60" loNote="59" hiNote="61" loVel="0" hiVel="1"/>
    </group>
    <group trigger="release">
      <sample path="rel.wav" rootNote="60" loNote="0" hiNote="127" loVel="0" hiVel="1"/>
    </group>
  </groups>
</DecentSampler>`
    const preset = importInstrument('guitar.dspreset', xml).program
    expect(preset.mics.map((mic) => mic.id).sort()).toEqual(['close', 'main', 'room'])
    const group = preset.zones.find((zone) => zone.seqLength > 1)?.rrGroup ?? 0
    const first = selectLayers(preset, { note: 60, velocity: 100, keyswitch: null, roundRobin: { [group]: 0 }, trigger: 'attack' })
    const second = selectLayers(preset, { note: 60, velocity: 100, keyswitch: null, roundRobin: { [group]: 1 }, trigger: 'attack' })
    expect(first.layers.map((layer) => layer.sample.url).sort()).toEqual(['room.wav', 'rr1.wav'])
    expect(second.layers.map((layer) => layer.sample.url).sort()).toEqual(['room.wav', 'rr2.wav'])
    expect(first.advance).toContain(group)
    const release = selectLayers(preset, { note: 60, velocity: 100, keyswitch: null, roundRobin: {}, trigger: 'release' })
    expect(release.layers.map((layer) => layer.sample.url)).toEqual(['rel.wav'])
  })

  it('reads a SoundFont and decodes only the zone that plays', () => {
    const font = importSoundFont(soundFont())
    expect(font.programs).toHaveLength(1)
    expect(font.programs[0].name).toBe('Piano')
    const zones = font.programs[0].zones
    expect(zones.map((zone) => [zone.lovel, zone.hivel]).sort((a, b) => a[0] - b[0])).toEqual([[1, 64], [65, 127]])
    expect(zones.every((zone) => zone.root === 60 && zone.lokey === 58 && zone.hikey === 62)).toBe(true)
    const cache = new SampleCache()
    cache.holdPack(font.pack)
    const instrument = new SamplerInstrument(48000, cache)
    instrument.setProgram(font.programs[0])
    instrument.noteOn(60, 0.4)
    const quiet = instrument.render(1500)
    expect(cache.loadedIds()).toHaveLength(1)
    instrument.noteOff(60)
    instrument.render(1000)
    instrument.noteOn(60, 0.9)
    const loud = instrument.render(1500)
    expect(cache.loadedIds()).toHaveLength(2)
    expect(mean(quiet[0].slice(400, 1200))).toBeGreaterThan(mean(loud[0].slice(400, 1200)))
    expect(Math.abs(mean(quiet[0].slice(400, 1200)))).toBeGreaterThan(0.15)
  })
})

describe('playback and streaming', () => {
  it('keeps a root sample on pitch and mixes mics', () => {
    const rate = 48000
    const tone = sine(rate, 440, rate)
    const close = makeSample({ id: 'close', sampleRate: rate })
    const room = makeSample({ id: 'room', sampleRate: rate })
    const bank = new MemoryBank()
    bank.put('close', { sampleRate: rate, channels: [tone] })
    bank.put('room', { sampleRate: rate, channels: [tone.map((sample) => sample * 0.5)] })
    const instrument = new SamplerInstrument(rate, bank)
    instrument.setProgram(makeProgram({
      name: 'Tone',
      mics: [
        { id: 'close', name: 'Close', gain: 1, pan: 0, mute: false },
        { id: 'room', name: 'Room', gain: 0, pan: 0, mute: false },
      ],
      samples: [close, room],
      zones: [
        makeZone({ id: 'z1', sampleId: 'close', root: 69, lokey: 0, hikey: 127, mic: 'close', loopMode: 'loop', loopStart: 0, loopEnd: tone.length, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.05 } }),
        makeZone({ id: 'z2', sampleId: 'room', root: 69, lokey: 0, hikey: 127, mic: 'room', loopMode: 'loop', loopStart: 0, loopEnd: tone.length, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.05 } }),
      ],
    }))
    instrument.noteOn(69, 1)
    const rendered = instrument.render(rate / 4)
    expect(cents(measureHz(rendered[0], rate), 440)).toBeLessThan(15)
    const closeOnly = rms(rendered[0])
    instrument.setMicGain('room', 1)
    const both = instrument.render(rate / 4)
    expect(rms(both[0])).toBeGreaterThan(closeOnly)
    instrument.setMicMute('close', true)
    const roomOnly = instrument.render(rate / 4)
    expect(rms(roomOnly[0])).toBeLessThan(closeOnly)
    for (const sample of rendered[0]) {
      expect(Number.isFinite(sample)).toBe(true)
      expect(sample === 0 || Math.abs(sample) >= 1e-15).toBe(true)
    }
  })

  it('fires a release sample when the note ends', () => {
    const rate = 48000
    const attack = new Float32Array(rate).fill(0.05)
    const release = new Float32Array(rate).fill(0.7)
    const bank = new MemoryBank()
    bank.put('a', { sampleRate: rate, channels: [attack] })
    bank.put('r', { sampleRate: rate, channels: [release] })
    const withRelease = makeProgram({
      name: 'Rel',
      samples: [makeSample({ id: 'a' }), makeSample({ id: 'r' })],
      zones: [
        makeZone({ id: 'atk', sampleId: 'a', ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.01 } }),
        makeZone({ id: 'rel', sampleId: 'r', trigger: 'release', ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.2 } }),
      ],
    })
    const events = [{ sample: 0, pitch: 60, vel: 0.8 }, { sample: 2000, pitch: 60, vel: 0 }]
    const played = renderSampler(withRelease, events, rate, 5000, bank)
    expect(rms(played[0].slice(2500, 4000))).toBeGreaterThan(0.2)
  })

  it('streams one sample from Hugging Face and refuses other hosts', async () => {
    expect(() => setLibraryBaseUrl('https://cueharbor.onrender.com/samples')).toThrow(/Hugging Face/)
    expect(() => assertHuggingFaceUrl('https://cdn.cloudflare.com/piano.wav')).toThrow(/Hugging Face/)
    expect(() => assertHuggingFaceUrl('http://huggingface.co/piano.wav')).toThrow(/HTTPS/)
    const base = 'https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main'
    setLibraryBaseUrl(base)
    const calls: { url: string; range?: string }[] = []
    const wav = encodeWav([sine(480, 440, 48000)], 48000)
    const cache = new SampleCache(async (url, init) => {
      calls.push({ url, range: init?.headers?.Range })
      if (url.endsWith('slice.pcm')) return new Response(new Uint8Array([0, 16, 0, 32]).buffer, { status: 206 })
      return new Response(wav)
    })
    const sample = makeSample({
      id: 'remote',
      url: `${base}/piano/c4.wav`,
      format: 'wav',
    })
    const other = makeSample({ id: 'other', url: `${base}/piano/d4.wav`, format: 'wav' })
    const instrument = new SamplerInstrument(48000, cache)
    instrument.setProgram(makeProgram({
      name: 'Remote',
      samples: [sample, other],
      zones: [
        makeZone({ id: 'c', sampleId: 'remote', lokey: 60, hikey: 60, root: 60 }),
        makeZone({ id: 'd', sampleId: 'other', lokey: 62, hikey: 62, root: 62 }),
      ],
    }))
    instrument.noteOn(60, 0.8)
    instrument.render(32)
    expect(calls.map((call) => call.url)).toEqual([sample.url])
    const ranged = makeSample({
      id: 'slice',
      url: `${base}/piano/slice.pcm`,
      format: 'pcm-s16le',
      sampleRate: 48000,
      byteOffset: 4,
      byteLength: 4,
    })
    const decoded = await cache.load(ranged)
    expect(calls.some((call) => call.range === 'bytes=4-7')).toBe(true)
    expect(decoded?.channels[0].length).toBeGreaterThan(0)
    await expect(cache.load(makeSample({ id: 'bad', url: 'https://example.com/a.wav' }))).rejects.toThrow(/Hugging Face/)
  })

  it('downloads a catalog and one preset, not the sample files', async () => {
    const base = 'https://huggingface.co/datasets/cueharbor/starter-instruments/resolve/main'
    const urls: string[] = []
    const fetchImpl = async (url: string) => {
      urls.push(url)
      if (url.endsWith('catalog.json')) {
        return new Response(JSON.stringify({
          instruments: [
            ...STARTER_CATALOG,
            { id: 'nope', name: 'No', license: 'CC-BY-4.0', path: 'nope/a.sfz', bytes: 1, description: '' },
          ],
        }))
      }
      return new Response('<region> sample=Samples/c4.wav key=c4\n')
    }
    const catalog = await fetchCatalog(base, fetchImpl)
    expect(catalog.some((entry) => entry.id === 'upright-piano')).toBe(true)
    expect(catalog.some((entry) => entry.id === 'nope')).toBe(false)
    const missing = await fetchCatalog(base, async () => new Response('', { status: 404 }))
    expect(missing.map((entry) => entry.id)).toEqual(STARTER_CATALOG.map((entry) => entry.id))
    urls.length = 0
    const entry = STARTER_CATALOG[1]
    const imported = await fetchInstrument(base, entry, fetchImpl)
    expect(urls).toEqual([libraryFileUrl(base, entry.path)])
    expect(imported.program.samples[0].url).toBe(`${base}/string-section/Samples/c4.wav`)
    expect(imported.program.license).toBe('CC0-1.0')
  })

  it('adds a playable library instrument on a MIDI track', () => {
    const store = new ProjectStore(createEmptyProject())
    const idsMade = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    const track = store.track(idsMade[0])!
    expect(track.instrument).toBe('library')
    expect(track.name).toMatch(/Library/)
    expect(store.rackTrackId).toBe(track.id)
    const rate = 48000
    const tone = sine(rate, 330, rate)
    const sample = makeSample({ id: 'tone', sampleRate: rate, bufferId: 'tone' })
    store.adoptLibrary(track.id, makeProgram({
      name: 'Held',
      samples: [sample],
      zones: [makeZone({ id: 'z', sampleId: 'tone', root: 60, loopMode: 'loop', loopStart: 0, loopEnd: tone.length, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.02 } })],
    }), [{ id: 'tone', name: 'tone.wav', sampleRate: rate, channels: [tone] }])
    const bank = new MemoryBank()
    bank.put('tone', { sampleRate: rate, channels: [tone] })
    const played = renderSampler(store.track(track.id)!.library!, [{ sample: 0, pitch: 60, vel: 0.9 }, { sample: rate / 2, pitch: 60, vel: 0 }], rate, rate, bank)
    expect(rms(played[0].slice(0, rate / 4))).toBeGreaterThan(0.05)
    store.setLibraryMic(track.id, 'main', 0.25)
    expect(store.track(track.id)!.library!.mics[0].gain).toBe(0.25)
  })
})

function sine(length: number, freq: number, sampleRate: number) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.5
  return out
}

function rms(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += sample * sample
  return Math.sqrt(sum / Math.max(1, channel.length))
}

function mean(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += Math.abs(sample)
  return sum / Math.max(1, channel.length)
}

function measureHz(channel: Float32Array, sampleRate: number) {
  const start = Math.min(channel.length - 2, Math.round(sampleRate * 0.02))
  let prev = channel[start] || 0
  let last = -1
  const periods: number[] = []
  for (let i = start + 1; i < channel.length; i++) {
    const value = channel[i] || 0
    if (prev <= 0 && value > 0) {
      const at = i - 1 + prev / (prev - value)
      if (last >= 0) periods.push(at - last)
      last = at
    }
    prev = value
  }
  const window = periods.slice(1, 12)
  const average = window.reduce((sum, period) => sum + period, 0) / window.length
  return sampleRate / average
}

function cents(hz: number, target: number) {
  return Math.abs(1200 * Math.log2(hz / target))
}

function soundFont() {
  const frames = 4000
  const pad = 46
  const pcm = new Int16Array(frames + pad + frames + pad)
  pcm.fill(20000, 0, frames)
  pcm.fill(5000, frames + pad, frames + pad + frames)
  const gensA = concat([
    genRange(43, 58, 62),
    genRange(44, 1, 64),
    gen(53, 0),
    gen(58, 60),
    gen(34, -12000),
    gen(37, 0),
    gen(38, -12000),
    gen(54, 1),
  ])
  const gensB = concat([
    genRange(43, 58, 62),
    genRange(44, 65, 127),
    gen(53, 1),
    gen(58, 60),
    gen(34, -12000),
    gen(37, 0),
    gen(38, -12000),
    gen(54, 1),
  ])
  const igens = concat([gensA, gensB, gen(0, 0)])
  const pgens = concat([genRange(43, 0, 127), genRange(44, 0, 127), gen(41, 0), gen(0, 0)])
  const body = list('INFO', [chunk('ifil', concat([u16(2), u16(1)]))])
  const sdta = list('sdta', [chunk('smpl', new Uint8Array(pcm.buffer))])
  const pdta = list('pdta', [
    chunk('phdr', concat([
      preset('Piano', 0, 0, 0),
      preset('EOP', 0, 0, 1),
    ])),
    chunk('pbag', concat([bag(0, 0), bag(3, 0)])),
    chunk('pmod', mod()),
    chunk('pgen', pgens),
    chunk('inst', concat([instrument('Piano', 0), instrument('EOI', 2)])),
    chunk('ibag', concat([bag(0, 0), bag(8, 0), bag(16, 0)])),
    chunk('imod', mod()),
    chunk('igen', igens),
    chunk('shdr', concat([
      shdr('soft', 0, frames, 0, frames),
      shdr('hard', frames + pad, frames + pad + frames, frames + pad, frames + pad + frames),
      shdr('EOS', 0, 0, 0, 0),
    ])),
  ])
  const data = concat([four('sfbk'), body, sdta, pdta])
  return chunk('RIFF', data).buffer
}

function preset(name: string, program: number, bank: number, bagIndex: number) {
  return concat([name20(name), u16(program), u16(bank), u16(bagIndex), u32(0), u32(0), u32(0)])
}

function instrument(name: string, bagIndex: number) {
  return concat([name20(name), u16(bagIndex)])
}

function bag(genIndex: number, modIndex: number) {
  return concat([u16(genIndex), u16(modIndex)])
}

function mod() {
  return new Uint8Array(10)
}

function shdr(name: string, start: number, end: number, loopStart: number, loopEnd: number) {
  return concat([
    name20(name),
    u32(start),
    u32(end),
    u32(loopStart),
    u32(loopEnd),
    u32(48000),
    new Uint8Array([60, 0]),
    u16(0),
    u16(1),
  ])
}

function gen(op: number, amount: number) {
  return concat([u16(op), i16(amount)])
}

function genRange(op: number, lo: number, hi: number) {
  const data = new Uint8Array(4)
  const view = new DataView(data.buffer)
  view.setUint16(0, op, true)
  view.setUint8(2, lo)
  view.setUint8(3, hi)
  return data
}

function name20(text: string) {
  const out = new Uint8Array(20)
  out.set(new TextEncoder().encode(text).slice(0, 20))
  return out
}

function four(id: string) {
  return new TextEncoder().encode(id)
}

function u16(value: number) {
  const data = new Uint8Array(2)
  new DataView(data.buffer).setUint16(0, value, true)
  return data
}

function u32(value: number) {
  const data = new Uint8Array(4)
  new DataView(data.buffer).setUint32(0, value, true)
  return data
}

function i16(value: number) {
  const data = new Uint8Array(2)
  new DataView(data.buffer).setInt16(0, value, true)
  return data
}

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(size)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function chunk(id: string, data: Uint8Array) {
  const pad = data.length % 2 ? new Uint8Array(1) : new Uint8Array(0)
  return concat([four(id), u32(data.length), data, pad])
}

function list(type: string, parts: Uint8Array[]) {
  return chunk('LIST', concat([four(type), ...parts]))
}

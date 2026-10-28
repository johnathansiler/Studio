import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AudioEngine } from '../audio/engine'
import { SampleCache } from '../audio/multisample/cache'
import { SamplerInstrument } from '../audio/multisample/engine'
import { bindLocalSamples, importInstrument } from '../audio/multisample/import'
import { importSfz } from '../audio/multisample/sfz'
import { roundRobinIndex, selectLayers } from '../audio/multisample/map'
import { isPackAsset, packFromAsset } from '../audio/multisample/persist'
import { importSoundFont } from '../audio/multisample/sf2'
import { makeProgram, makeSample, makeZone, type SamplePack } from '../audio/multisample/types'
import { PatchEngine } from '../instruments/patch/engine'
import {
  addRoute,
  destinationsFor,
  editLayer,
  editRoute,
  emptyOmni,
  morphedPatch,
  setLayerKind,
  setPerformance,
} from '../instruments/patch/model'
import { decodeWavPCM, encodeWav } from '../model/wav'
import { migrateProject } from '../model/schema'
import { referencedBufferIds } from '../model/sessionSync'
import { createEmptyProject } from '../model/types'
import { ProjectStore } from '../state/store'
import { LibraryPanel } from '../ui/LibraryPanel'

function rms(channel: Float32Array, from = 0, to = channel.length) {
  let sum = 0
  let count = 0
  const end = Math.min(channel.length, to)
  for (let i = from; i < end; i++) {
    sum += channel[i] * channel[i]
    count += 1
  }
  return Math.sqrt(sum / Math.max(1, count))
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

function brightness(channel: Float32Array) {
  const start = Math.round(channel.length * 0.2)
  let sum = 0
  for (let i = start + 1; i < channel.length; i++) sum += Math.abs(channel[i] - channel[i - 1])
  return sum / Math.max(1, channel.length - start)
}

function sinePcm(frames: number, freq: number, rate: number, from = 0, to = frames) {
  const pcm = new Int16Array(frames)
  const end = Math.min(frames, to)
  for (let i = from; i < end; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 16000)
  return pcm
}

function playProgram(program: ReturnType<typeof makeProgram>, pack: SamplePack | null, note: number, frames: number, rate = 48000) {
  const cache = new SampleCache()
  if (pack) cache.holdPack(pack)
  const instrument = new SamplerInstrument(rate, cache)
  instrument.setProgram(program)
  instrument.noteOn(note, 0.9)
  const audio = instrument.render(frames)
  return { audio, cache }
}

describe('instrument engine gaps', () => {
  it('picks random round-robins and keeps a saved keyswitch default', () => {
    const cycle = Array.from({ length: 8 }, (_, counter) => roundRobinIndex(4, counter, 7, 'cycle'))
    const random = Array.from({ length: 8 }, (_, counter) => roundRobinIndex(4, counter, 7, 'random'))
    expect(random.join(',')).not.toBe(cycle.join(','))
    expect(new Set(random).size).toBeGreaterThan(1)

    const xml = `<?xml version="1.0"?>
<DecentSampler>
  <groups>
    <group seqMode="random">
      <sample path="a.wav" rootNote="60" loNote="60" hiNote="60" loVel="0" hiVel="1"/>
      <sample path="b.wav" rootNote="60" loNote="60" hiNote="60" loVel="0" hiVel="1"/>
      <sample path="c.wav" rootNote="60" loNote="60" hiNote="60" loVel="0" hiVel="1"/>
      <sample path="d.wav" rootNote="60" loNote="60" hiNote="60" loVel="0" hiVel="1"/>
    </group>
  </groups>
</DecentSampler>`
    const preset = importInstrument('guitar.dspreset', xml).program
    const group = preset.zones[0].rrGroup
    const names = Array.from({ length: 8 }, (_, counter) => {
      const mapped = selectLayers(preset, { note: 60, velocity: 100, keyswitch: null, roundRobin: { [group]: counter }, trigger: 'attack' })
      return mapped.layers.map((layer) => layer.sample.url).join(',')
    })
    expect(new Set(names).size).toBeGreaterThan(1)
    expect(names.join('|')).not.toBe(['a.wav', 'b.wav', 'c.wav', 'd.wav', 'a.wav', 'b.wav', 'c.wav', 'd.wav'].join('|'))

    const sfz = importSfz('<control> sw_default=37\n<group> sw_last=36 sw_label=sustain\n<region> sample=a.wav key=c4\n<group> sw_last=37 sw_label=staccato\n<region> sample=b.wav key=c4\n', 'keys')
    expect(sfz.defaultSwitch).toBe(37)
    expect(sfz.keyswitches.map((item) => item.key).sort()).toEqual([36, 37])
  })

  it('streams a long packed sample in chunks and a long float in place', () => {
    const rate = 48000
    const frames = rate * 3
    const pcm = sinePcm(frames, 440, rate)
    const pack: SamplePack = { id: 'long-pack', pcm: pcm.buffer, channels: 1 }
    const sample = makeSample({
      id: 'long',
      packId: pack.id,
      format: 'pcm-s16le',
      sampleRate: rate,
      channels: 1,
      frameOffset: 0,
      frameCount: frames,
    })
    const program = makeProgram({
      name: 'Long',
      samples: [sample],
      zones: [makeZone({
        id: 'z',
        sampleId: 'long',
        root: 69,
        loopMode: 'loop',
        loopStart: 0,
        loopEnd: frames,
        ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.05 },
      })],
    })
    const played = playProgram(program, pack, 69, rate / 2, rate)
    expect(cents(measureHz(played.audio[0], rate), 440)).toBeLessThan(20)
    expect(played.cache.fullResidentIds()).not.toContain('long')
    expect(played.cache.playbackFloatFrames()).toBeGreaterThan(0)
    expect(played.cache.playbackFloatFrames()).toBeLessThan(rate)

    const burstAt = rate * 2
    const burst = sinePcm(frames, 330, rate, burstAt, burstAt + rate)
    const burstPack: SamplePack = { id: 'burst-pack', pcm: burst.buffer, channels: 1 }
    const burstSample = makeSample({
      id: 'burst',
      packId: burstPack.id,
      format: 'pcm-s16le',
      sampleRate: rate,
      channels: 1,
      frameOffset: 0,
      frameCount: frames,
    })
    const late = makeProgram({
      name: 'Late',
      samples: [burstSample],
      zones: [makeZone({
        id: 'late',
        sampleId: 'burst',
        root: 69,
        offset: burstAt,
        ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.2 },
      })],
    })
    const tail = playProgram(late, burstPack, 69, rate / 4, rate)
    expect(rms(tail.audio[0], 200, rate / 5)).toBeGreaterThan(0.05)
    expect(tail.cache.playbackFloatFrames()).toBeLessThan(rate)
    const early = makeProgram({
      name: 'Early',
      samples: [burstSample],
      zones: [makeZone({ id: 'early', sampleId: 'burst', root: 69, offset: 0, end: 4000, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.01 } })],
    })
    const head = playProgram(early, burstPack, 69, 4000, rate)
    expect(rms(head.audio[0])).toBeLessThan(0.01)

    const view = new Float32Array(frames)
    for (let i = burstAt; i < burstAt + rate; i++) view[i] = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.5
    const cache = new SampleCache()
    cache.holdAudio('view', { sampleRate: rate, channels: [view] })
    const instrument = new SamplerInstrument(rate, cache)
    instrument.setProgram(makeProgram({
      name: 'View',
      samples: [makeSample({ id: 'view', sampleRate: rate, frameCount: frames })],
      zones: [makeZone({ id: 'vz', sampleId: 'view', root: 69, offset: burstAt, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.2 } })],
    }))
    instrument.noteOn(69, 1)
    const heard = instrument.render(rate / 4)
    expect(rms(heard[0], 200, rate / 5)).toBeGreaterThan(0.05)
    expect(cache.fullResidentIds()).not.toContain('view')
    expect(cache.playbackFloatFrames()).toBe(0)
  })

  it('keeps an imported SoundFont, SFZ, and DecentSampler after a refresh', () => {
    const store = new ProjectStore(createEmptyProject())
    const [trackId] = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    const font = importSoundFont(soundFont())
    store.adoptLibrary(trackId, font.programs[0], [], font.pack)
    store.setLibrarySwitch(trackId, 36)
    const wav = encodeWav([sineFloat(4800, 440, 48000)], 48000)
    const sfz = importInstrument('piano.sfz', '<region> sample=c4.wav key=60\n')
    const bound = bindWav(sfz.program, wav)
    const [otherId] = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    store.adoptLibrary(otherId, bound.program, bound.assets)
    const preset = importInstrument('pad.dspreset', `<?xml version="1.0"?><DecentSampler><groups><group><sample path="pad.wav" rootNote="60" loNote="60" hiNote="60" loVel="0" hiVel="1"/></group></groups></DecentSampler>`)
    const pad = bindWav(preset.program, wav)
    const [padId] = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    store.adoptLibrary(padId, pad.program, pad.assets)

    const buffers = new Map<string, { id: string; name: string; sampleRate: number; channels: Float32Array[] }>()
    for (const asset of store.buffers.values()) {
      const decoded = decodeWavPCM(encodeWav(asset.channels, asset.sampleRate || 48000, { bits: 32 }))
      buffers.set(asset.id, { ...asset, sampleRate: decoded.sampleRate || asset.sampleRate, channels: decoded.channels })
    }
    const restored = new ProjectStore(migrateProject(JSON.parse(JSON.stringify(store.project))), buffers)
    const library = restored.track(trackId)!.library!
    expect(library.name).toBe('Piano')
    expect(library.defaultSwitch).toBe(36)
    expect(referencedBufferIds(restored.project)).toContain(font.pack.id)
    const packAsset = buffers.get(font.pack.id)!
    expect(isPackAsset(packAsset)).toBe(true)
    const pack = packFromAsset(packAsset)!
    const cache = new SampleCache()
    cache.holdPack(pack)
    const instrument = new SamplerInstrument(48000, cache)
    instrument.setProgram(library)
    instrument.noteOn(60, 0.4)
    const quiet = instrument.render(1500)
    instrument.noteOff(60)
    instrument.render(800)
    instrument.noteOn(60, 0.95)
    const loud = instrument.render(1500)
    expect(Math.abs(mean(quiet[0].slice(400, 1200)))).toBeGreaterThan(0.1)
    expect(mean(quiet[0].slice(400, 1200))).toBeGreaterThan(mean(loud[0].slice(400, 1200)))

    const sampleId = restored.track(otherId)!.library!.samples[0].id
    const audio = buffers.get(sampleId)!
    expect(audio.channels[0].length).toBeGreaterThan(1000)
    const again = new SampleCache()
    again.holdAudio(sampleId, { sampleRate: audio.sampleRate, channels: audio.channels })
    const player = new SamplerInstrument(48000, again)
    player.setProgram(restored.track(otherId)!.library!)
    player.noteOn(60, 0.9)
    expect(rms(player.render(4000)[0], 200)).toBeGreaterThan(0.02)
    expect(restored.track(padId)!.library!.samples[0].bufferId).toBeTruthy()

    restored.retargetSampleRate(44100)
    const kept = packFromAsset(restored.buffers.get(font.pack.id)!)
    expect(kept?.pcm.byteLength).toBe(pack.pcm.byteLength)
  })

  it('sends macros to any parameter and morphs those parameters', () => {
    const dull = emptyOmni()
    setLayerKind(dull, dull.layers[0].id, 'fm')
    editLayer(dull, dull.layers[0].id, { cutoff: 14000, resonance: 0, params: { index: 0, ratio: 1, feedback: 0, algo: 0, attack: 1, sustain: 1 } })
    const route = addRoute(dull)!
    editRoute(dull, route.id, { source: 'macro1', target: 'layer:0:param:index', depth: 1 })
    setPerformance(dull, { macro1: 0 })
    const bright = emptyOmni()
    setLayerKind(bright, bright.layers[0].id, 'fm')
    editLayer(bright, bright.layers[0].id, { cutoff: 14000, resonance: 0, params: { index: 0, ratio: 1, feedback: 0, algo: 0, attack: 1, sustain: 1 } })
    const other = addRoute(bright)!
    editRoute(bright, other.id, { source: 'macro1', target: 'layer:0:param:index', depth: 1 })
    setPerformance(bright, { macro1: 1 })
    expect(brightness(renderPatch(bright))).toBeGreaterThan(brightness(renderPatch(dull)) * 1.4)
    const targets = destinationsFor(bright).map((item) => item.id)
    expect(targets).toContain('layer:0:param:index')
    editLayer(bright, bright.layers[0].id, { params: { shine: 0.2 } })
    expect(destinationsFor(bright).some((item) => item.id === 'layer:0:param:shine')).toBe(true)

    const pad = emptyOmni()
    editLayer(pad, pad.layers[0].id, { params: { shine: 0 } })
    pad.morph.corners.forEach((corner, index) => {
      corner.captured = true
      corner.values.layers[0].params.shine = index * 10
    })
    pad.morph.x = 1
    pad.morph.y = 0
    expect(morphedPatch(pad).layers[0].params.shine).toBeCloseTo(10)

    const cloud = emptyOmni()
    setLayerKind(cloud, cloud.layers[0].id, 'granular')
    const tone = new Float32Array(48000)
    for (let i = 36000; i < tone.length; i++) tone[i] = 0.7 * Math.sin((2 * Math.PI * 220 * i) / 48000)
    editLayer(cloud, cloud.layers[0].id, {
      bufferId: 'tone',
      root: 60,
      cutoff: 14000,
      resonance: 0,
      granular: { position: 0, size: 80, density: 24, spray: 0, pitch: 0, freeze: true },
    })
    const grainRoute = addRoute(cloud)!
    editRoute(cloud, grainRoute.id, { source: 'macro2', target: 'layer:0:position', depth: 0.9 })
    setPerformance(cloud, { macro2: 0 })
    const quiet = renderPatch(cloud, tone)
    setPerformance(cloud, { macro2: 1 })
    const moved = renderPatch(cloud, tone)
    expect(rms(quiet)).toBeLessThan(0.02)
    expect(rms(moved, 1000)).toBeGreaterThan(0.03)
  })

  it('describes keyswitches, mics, and import on the instrument panel', () => {
    const store = new ProjectStore(createEmptyProject())
    const [trackId] = store.addTracks({ kind: 'midi', count: 1, instrument: 'library', input: 'mic', channels: 1, armed: false })
    store.setLibrary(trackId, makeProgram({
      name: 'Keys',
      defaultSwitch: 36,
      keyswitches: [{ key: 36, label: 'Sustain', articulation: 'sustain' }],
      mics: [{ id: 'close', name: 'Close', gain: 0.8, pan: 0, mute: false }],
    }))
    const html = renderToStaticMarkup(createElement(LibraryPanel, { store, engine: {} as AudioEngine, trackId }))
    expect(html).toContain('Sustain')
    expect(html).toContain('Play the Sustain samples')
    expect(html).toContain('Close')
    expect(html).toContain('Mute the Close microphone')
    expect(html).toContain('this device')
    expect(html).toContain('SoundFont')
  })
})

function renderPatch(patch: ReturnType<typeof emptyOmni>, buffer?: Float32Array) {
  const engine = new PatchEngine(48000)
  engine.setPatch(patch)
  if (buffer) engine.setBuffer('tone', buffer)
  engine.noteOn(60, 0.9)
  const audio = engine.render(12000)
  engine.dispose()
  return audio.left
}

function sineFloat(length: number, freq: number, rate: number) {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5
  return out
}

function mean(channel: Float32Array) {
  let sum = 0
  for (const sample of channel) sum += Math.abs(sample)
  return sum / Math.max(1, channel.length)
}

function bindWav(program: ReturnType<typeof makeProgram>, wav: ArrayBuffer) {
  const files = new Map<string, ArrayBuffer>()
  for (const sample of program.samples) if (sample.url) files.set(sample.url, wav)
  return bindLocalSamples(program, files)
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
    chunk('phdr', concat([preset('Piano', 0, 0, 0), preset('EOP', 0, 0, 1)])),
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
  return chunk('RIFF', concat([four('sfbk'), body, sdta, pdta])).buffer
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
  const out = concat([
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
  return out
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

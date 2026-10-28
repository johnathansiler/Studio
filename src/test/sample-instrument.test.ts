import { describe, expect, it } from 'vitest'
import { CHUNK_FRAMES, createMemoryDisk, createStreamBank } from '../instruments/engine/bank'
import { controlsFor } from '../instruments/engine/controls'
import { loadInstrument, renderSampleProgram } from '../instruments/engine/load'
import { selectZones, velocityLayerGain } from '../instruments/engine/map'
import { emptySampleProgram, programFromDef } from '../instruments/engine/program'
import type { SampleZone } from '../instruments/engine/types'
import { createSampleZoneVoice } from '../instruments/engine/voice'
import { makeZone } from '../instruments/engine/zone'
import { importInstrument, type LocalFile } from '../instruments/import'
import { parseSfz } from '../instruments/import/sfz'
import { arrangementDigest } from '../model/sessionSync'
import { createEmptyProject } from '../model/types'
import { encodeWav } from '../model/wav'
import { ProjectStore } from '../state/store'

const rate = 48000

function dc(length: number, value: number) {
  return new Float32Array(length).fill(value)
}

function sine(freq: number, frames: number, sampleRate = rate, amp = 0.55) {
  const out = new Float32Array(frames)
  for (let i = 0; i < frames; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate)
  return out
}

function wavFile(name: string, channel: Float32Array): LocalFile {
  return { name, path: name, bytes: new Uint8Array(encodeWav([channel], rate, { bits: 16 })) }
}

function mid(left: Float32Array, right: Float32Array, index: number) {
  return ((left[index] || 0) + (right[index] || 0)) / Math.SQRT2
}

function estimateHz(channel: Float32Array, sampleRate: number) {
  const marks: number[] = []
  const start = Math.floor(channel.length * 0.2)
  const end = Math.floor(channel.length * 0.85)
  for (let i = start + 1; i < end; i++) {
    if ((channel[i - 1] || 0) <= 0 && (channel[i] || 0) > 0) marks.push(i)
  }
  if (marks.length < 4) return 0
  const periods: number[] = []
  for (let i = 1; i < marks.length; i++) periods.push(marks[i] - marks[i - 1])
  periods.sort((a, b) => a - b)
  return sampleRate / periods[Math.floor(periods.length / 2)]
}

async function resident(id: string, channels: Float32Array[], sampleRate = rate) {
  const disk = createMemoryDisk()
  const bank = createStreamBank(disk)
  await bank.store({ id, sampleRate, channels })
  await bank.prefetch(id, 0, channels[0]?.length ?? 0)
  return { disk, bank }
}

const flat = { level: 1, attack: 0, decay: 0, sustain: 1, release: 40, tune: 0, velXfade: 0, rrMode: 0, loopXfade: 0 }

function loopZone(partial: Partial<SampleZone> & Pick<SampleZone, 'id' | 'sampleId'>, frames: number) {
  return makeZone({
    root: 60,
    loKey: 0,
    hiKey: 127,
    end: frames,
    loopStart: 0,
    loopEnd: frames,
    loopMode: 'forward',
    ...partial,
  })
}

describe('sample instrument engine', () => {
  it('describes every control', () => {
    const program = emptySampleProgram()
    expect(program.def.controls.length).toBeGreaterThan(5)
    for (const control of program.def.controls) {
      expect(control.description.trim().length).toBeGreaterThan(12)
      expect(control.name.length).toBeGreaterThan(0)
    }
    const withMic = controlsFor({
      mics: [{ id: 'room', name: 'Room', gain: 0.5, description: 'Level of the Room microphone.' }],
      controls: [],
    })
    expect(withMic.find((control) => control.id === 'mic:room')?.description).toMatch(/Room/)
  })

  it('crossfades velocity layers with equal power', () => {
    const low = makeZone({ id: 'low', sampleId: 'low', loVel: 0, hiVel: 80 })
    const high = makeZone({ id: 'high', sampleId: 'high', loVel: 48, hiVel: 127 })
    const state = { articulation: '', rrMode: 'sequential' as const, rr: new Map<string, number>(), velFade: 32, mics: {}, held: 0, random: () => 0 }
    const power = (vel: number) => {
      const picks = selectZones([low, high], 60, vel, 'attack', state)
      const layers = picks.map((pick) => pick.gain / (vel / 127))
      return Math.hypot(...layers)
    }
    expect(velocityLayerGain(20, 0, 80, 0, 0)).toBe(1)
    expect(power(20)).toBeCloseTo(1, 5)
    expect(power(64)).toBeCloseTo(1, 1)
    expect(power(110)).toBeCloseTo(1, 5)
    expect(selectZones([low, high], 60, 20, 'attack', state).map((pick) => pick.zone.id)).toEqual(['low'])
    expect(selectZones([low, high], 60, 110, 'attack', state).map((pick) => pick.zone.id)).toEqual(['high'])
  })

  it('cycles round-robins in order and avoids repeating a random one', async () => {
    const frames = 64
    const { bank } = await resident('a', [dc(frames, 0.4)])
    await bank.store({ id: 'b', sampleRate: rate, channels: [dc(frames, -0.4)] })
    await bank.prefetch('b', 0, frames)
    const zones = [
      loopZone({ id: 'a', sampleId: 'a', seqPosition: 1, seqLength: 2 }, frames),
      loopZone({ id: 'b', sampleId: 'b', seqPosition: 2, seqLength: 2 }, frames),
    ]
    const sequential = loadInstrument({ id: 'rr', name: 'RR', zones, articulations: [], mics: [], defaultArticulation: '', controls: [] }, {
      sampleRate: rate,
      bank,
      controls: flat,
    })
    await sequential.prepare()
    sequential.noteOn(60, 1)
    let [left, right] = sequential.render(32)
    expect(mid(left, right, 8)).toBeGreaterThan(0.2)
    sequential.noteOff(60)
    sequential.allOff()
    sequential.render(800)
    sequential.noteOn(60, 1)
    ;[left, right] = sequential.render(32)
    expect(mid(left, right, 8)).toBeLessThan(-0.2)

    let roll = 0
    const rolls = [0, 0]
    const random = loadInstrument({ id: 'rand', name: 'Rand', zones, articulations: [], mics: [], defaultArticulation: '', controls: [] }, {
      sampleRate: rate,
      bank,
      controls: { ...flat, rrMode: 1 },
      random: () => rolls[roll++] ?? 0,
    })
    await random.prepare()
    random.noteOn(60, 1)
    ;[left, right] = random.render(16)
    const first = mid(left, right, 4)
    random.noteOff(60)
    random.allOff()
    random.render(800)
    random.noteOn(60, 1)
    ;[left, right] = random.render(16)
    expect(first * mid(left, right, 4)).toBeLessThan(0)
  })

  it('selects an articulation from a keyswitch and mixes microphones', async () => {
    const frames = 48
    const { bank } = await resident('sus', [dc(frames, 0.45)])
    for (const [id, value] of [['stacc', 0.15], ['close', 0.4], ['room', 0.2]] as const) {
      await bank.store({ id, sampleRate: rate, channels: [dc(frames, value)] })
      await bank.prefetch(id, 0, frames)
    }
    const instrument = loadInstrument({
      id: 'keys',
      name: 'Keys',
      defaultArticulation: 'sustain',
      controls: [],
      mics: [
        { id: 'close', name: 'Close', gain: 1, description: 'Level of the Close microphone.' },
        { id: 'room', name: 'Room', gain: 1, description: 'Level of the Room microphone.' },
      ],
      articulations: [
        { id: 'sustain', name: 'Sustain', keyswitch: 36, description: 'Held samples.' },
        { id: 'staccato', name: 'Staccato', keyswitch: 24, description: 'Short samples.' },
      ],
      zones: [
        loopZone({ id: 'sus', sampleId: 'sus', articulation: 'sustain' }, frames),
        loopZone({ id: 'stacc', sampleId: 'stacc', articulation: 'staccato' }, frames),
        loopZone({ id: 'close', sampleId: 'close', mic: 'close', loKey: 72, hiKey: 72 }, frames),
        loopZone({ id: 'room', sampleId: 'room', mic: 'room', loKey: 72, hiKey: 72 }, frames),
      ],
    }, { sampleRate: rate, bank, controls: { ...flat, 'mic:room': 0 } })
    await instrument.prepare()
    instrument.noteOn(60, 1)
    let [left, right] = instrument.render(24)
    expect(mid(left, right, 6)).toBeGreaterThan(0.3)
    instrument.noteOff(60)
    instrument.allOff()
    instrument.render(rate / 8)
    instrument.noteOn(24, 1)
    ;[left, right] = instrument.render(16)
    expect(instrument.articulation()).toBe('staccato')
    expect(Math.max(...left.map((sample) => Math.abs(sample)))).toBeLessThan(0.02)
    instrument.noteOn(60, 1)
    ;[left, right] = instrument.render(24)
    expect(mid(left, right, 6)).toBeGreaterThan(0.05)
    expect(mid(left, right, 6)).toBeLessThan(0.25)
    instrument.allOff()
    instrument.render(rate / 8)
    instrument.setControl('mic:room', 0)
    instrument.setControl('mic:close', 1)
    instrument.noteOn(72, 1)
    ;[left, right] = instrument.render(16)
    const closeOnly = mid(left, right, 6)
    instrument.noteOff(72)
    instrument.render(8)
    instrument.setControl('mic:room', 1)
    instrument.noteOn(72, 1)
    ;[left, right] = instrument.render(16)
    expect(closeOnly).toBeGreaterThan(0.25)
    expect(mid(left, right, 6)).toBeGreaterThan(closeOnly + 0.1)
  })

  it('fires a release sample and chokes the previous group', async () => {
    const frames = 128
    const { bank } = await resident('body', [dc(frames, 0.35)])
    await bank.store({ id: 'rel', sampleRate: rate, channels: [dc(80, 0.8)] })
    await bank.store({ id: 'hat', sampleRate: rate, channels: [dc(frames, 0.12)] })
    await bank.prefetch('rel', 0, 80)
    await bank.prefetch('hat', 0, frames)
    const instrument = loadInstrument({
      id: 'rel',
      name: 'Release',
      defaultArticulation: '',
      controls: [],
      mics: [],
      articulations: [],
      zones: [
        loopZone({ id: 'body', sampleId: 'body', loKey: 60, hiKey: 60, group: 1, offBy: 2 }, frames),
        makeZone({ id: 'rel', sampleId: 'rel', loKey: 60, hiKey: 60, trigger: 'release', end: 80, loopMode: 'oneshot' }),
        loopZone({ id: 'hat', sampleId: 'hat', loKey: 62, hiKey: 62, group: 2 }, frames),
      ],
    }, { sampleRate: rate, bank, controls: { ...flat, release: 5 } })
    await instrument.prepare()
    instrument.noteOn(60, 1)
    let [left, right] = instrument.render(32)
    expect(mid(left, right, 8)).toBeGreaterThan(0.2)
    instrument.noteOff(60, 0.9)
    ;[left, right] = instrument.render(64)
    expect(Math.max(...left.map((_sample, index) => Math.abs(mid(left, right, index))))).toBeGreaterThan(0.5)
    instrument.allOff()
    instrument.render(64)
    instrument.noteOn(60, 1)
    instrument.render(16)
    instrument.noteOn(62, 1)
    ;[left, right] = instrument.render(rate / 5)
    const tail = mid(left, right, left.length - 8)
    expect(tail).toBeGreaterThan(0.05)
    expect(tail).toBeLessThan(0.25)
  })

  it('crossfades loop points and keeps the pitch in tune', async () => {
    const ramp = new Float32Array(1000)
    for (let i = 0; i < ramp.length; i++) ramp[i] = -1 + (2 * i) / (ramp.length - 1)
    const { bank } = await resident('ramp', [ramp])
    const bare = createSampleZoneVoice(makeZone({
      id: 'bare',
      sampleId: 'ramp',
      root: 60,
      end: ramp.length,
      loopStart: 0,
      loopEnd: ramp.length,
      loopMode: 'forward',
    }), 60, 1, { sampleRate: rate, bank, gain: 0.8, attack: 0, decay: 0, sustain: 1, loopCrossfade: 0 })
    const faded = createSampleZoneVoice(makeZone({
      id: 'fade',
      sampleId: 'ramp',
      root: 60,
      end: ramp.length,
      loopStart: 0,
      loopEnd: ramp.length,
      loopMode: 'forward',
    }), 60, 1, { sampleRate: rate, bank, gain: 0.8, attack: 0, decay: 0, sustain: 1, loopCrossfade: 80 })
    const jump = (voice: ReturnType<typeof createSampleZoneVoice>) => {
      const left = new Float32Array(1400)
      voice.render(left, new Float32Array(left.length))
      let peak = 0
      for (let i = 1; i < left.length; i++) peak = Math.max(peak, Math.abs(left[i] - left[i - 1]))
      return peak
    }
    const raw = jump(bare)
    const smooth = jump(faded)
    expect(raw).toBeGreaterThan(0.8)
    expect(smooth).toBeLessThan(raw * 0.25)

    const tone = sine(440, Math.round(rate * 0.35))
    const pitched = await resident('tone', [tone])
    const root = createSampleZoneVoice(makeZone({ id: 'root', sampleId: 'tone', root: 69, end: tone.length }), 69, 1, {
      sampleRate: rate, bank: pitched.bank, gain: 0.7, attack: 0, decay: 0, sustain: 1,
    })
    const octave = createSampleZoneVoice(makeZone({ id: 'oct', sampleId: 'tone', root: 69, end: tone.length }), 81, 1, {
      sampleRate: rate, bank: pitched.bank, gain: 0.7, attack: 0, decay: 0, sustain: 1,
    })
    const low = new Float32Array(rate / 6)
    const high = new Float32Array(low.length)
    root.render(low, new Float32Array(low.length))
    octave.render(high, new Float32Array(high.length))
    expect(estimateHz(low, rate)).toBeGreaterThan(430)
    expect(estimateHz(low, rate)).toBeLessThan(450)
    expect(estimateHz(high, rate)).toBeGreaterThan(860)
    expect(estimateHz(high, rate)).toBeLessThan(900)
    for (const sample of low) expect(Number.isFinite(sample)).toBe(true)
  })

  it('loads the sample head first and fetches the rest from the cache', async () => {
    const frames = CHUNK_FRAMES + 80
    const channel = new Float32Array(frames)
    channel.fill(0.75, CHUNK_FRAMES + 20)
    const disk = createMemoryDisk()
    const bank = createStreamBank(disk)
    await bank.store({ id: 'long', sampleRate: rate, channels: [channel] })
    await bank.store({ id: 'long', sampleRate: rate, channels: [channel] })
    expect(disk.puts).toBe(1)
    await bank.open('long')
    expect(bank.read('long', 0, 8)).not.toBeNull()
    expect(bank.read('long', CHUNK_FRAMES + 16, 8)).toBeNull()
    const reads = disk.reads
    await bank.prefetch('long', CHUNK_FRAMES, 40)
    expect(disk.reads).toBe(reads + 1)
    expect(bank.read('long', CHUNK_FRAMES + 20, 1)?.[0][0]).toBeCloseTo(0.75)
    await bank.prefetch('long', CHUNK_FRAMES, 40)
    expect(disk.reads).toBe(reads + 1)
    const again = createStreamBank(disk)
    await again.open('long')
    expect(again.info('long')?.frames).toBe(frames)
    expect(disk.puts).toBe(1)

    const zone = makeZone({ id: 'tail', sampleId: 'long', root: 60, start: CHUNK_FRAMES + 20, end: frames, loopMode: 'none' })
    const voice = createSampleZoneVoice(zone, 60, 1, { sampleRate: rate, bank: again, gain: 1, attack: 0, decay: 0, sustain: 1 })
    const quiet = new Float32Array(8)
    voice.render(quiet, new Float32Array(8))
    expect(Math.max(...quiet.map((sample) => Math.abs(sample)))).toBeLessThan(0.05)
    await again.prefetch('long', CHUNK_FRAMES, 80)
    const heard = new Float32Array(8)
    voice.render(heard, new Float32Array(8))
    expect(Math.max(...heard.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.4)
  })

  it('imports SFZ, SoundFont, and DecentSampler files from local bytes', async () => {
    const low = wavFile('low.wav', dc(120, 0.3))
    const high = wavFile('high.wav', dc(120, 0.6))
    const rel = wavFile('rel.wav', dc(40, 0.2))
    const sfz = `<control>
default_path=samples/
sw_default=36

<group>
sw_last=36
sw_label=sustain
lokey=60
hikey=72
pitch_keycenter=60
loop_mode=loop_continuous
loop_start=0
loop_end=100

<region>
sample=low.wav
lovel=0
hivel=70

<group>
sw_last=24
sw_label=staccato

<region>
sample=high.wav
lovel=0
hivel=127
trigger=attack

<region>
sample=rel.wav
trigger=release
lovel=0
hivel=127
`
    const parsed = parseSfz(sfz, 'Piano')
    expect(parsed.def.articulations.map((item) => item.keyswitch).sort()).toEqual([24, 36])
    expect(parsed.def.defaultArticulation).toBe('sustain')
    expect(parsed.def.zones.some((zone) => zone.trigger === 'release')).toBe(true)
    const imported = await importInstrument([
      { name: 'piano.sfz', path: 'piano.sfz', bytes: new TextEncoder().encode(sfz) },
      { ...low, path: 'samples/low.wav' },
      { ...high, path: 'samples/high.wav' },
      { ...rel, path: 'samples/rel.wav' },
    ])
    expect(imported.warnings).toEqual([])
    expect(imported.samples).toHaveLength(3)
    expect(imported.def.zones.every((zone) => zone.sampleId.length > 8)).toBe(true)
    const missing = await importInstrument([
      { name: 'piano.sfz', bytes: new TextEncoder().encode(sfz) },
    ])
    expect(missing.warnings.length).toBeGreaterThan(0)
    expect(missing.def.zones).toHaveLength(0)

    const disk = createMemoryDisk()
    const bank = createStreamBank(disk)
    for (const sample of imported.samples) await bank.store(sample)
    const program = programFromDef(imported.def, 3)
    program.values = { ...program.values, ...flat }
    const [left] = await renderSampleProgram(program, [
      { sample: 0, pitch: 60, vel: 0.4 },
      { sample: 400, pitch: 60, vel: 0 },
    ], rate, 800, bank)
    expect(Math.max(...left.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.05)

    const ds = `<?xml version="1.0"?>
<DecentSampler>
  <ui><tab>
    <labeled-knob label="Tone" minValue="0" maxValue="1" value="0.4"/>
  </tab></ui>
  <groups>
    <group name="sustain" keyswitch="36" seqMode="round_robin">
      <sample path="a.wav" rootNote="60" loNote="58" hiNote="62" loVel="1" hiVel="127" loopEnabled="1" loopStart="4" loopEnd="40" seqPosition="1"/>
      <sample path="b.wav" rootNote="60" loNote="58" hiNote="62" loVel="1" hiVel="127" seqPosition="2"/>
    </group>
    <group name="room" mic="room">
      <sample path="room.wav" rootNote="60" loNote="0" hiNote="127" loVel="0" hiVel="127" trigger="release"/>
    </group>
  </groups>
</DecentSampler>`
    const decent = await importInstrument([
      { name: 'kit.dspreset', bytes: new TextEncoder().encode(ds) },
      wavFile('a.wav', sine(220, 80)),
      wavFile('b.wav', sine(330, 80)),
      wavFile('room.wav', dc(50, 0.2)),
    ])
    expect(decent.def.mics.map((mic) => mic.id)).toContain('room')
    expect(decent.def.zones.filter((zone) => zone.seqLength === 2)).toHaveLength(2)
    expect(decent.def.articulations[0]?.keyswitch).toBe(36)
    expect(decent.def.zones.some((zone) => zone.trigger === 'release')).toBe(true)
    const tone = controlsFor(decent.def).find((control) => control.id === 'ui:tone')
    expect(tone?.description).toMatch(/Tone/)
    expect(tone?.default).toBeCloseTo(0.4)

    const sf2 = buildSf2(sine(440, 256, rate, 0.4))
    const font = await importInstrument([{ name: 'piano.sf2', bytes: sf2 }])
    expect(font.def.zones.length).toBeGreaterThan(0)
    expect(font.def.zones[0]?.loopMode).toBe('forward')
    expect(font.def.zones[0]?.root).toBe(60)
    expect(font.samples[0]?.channels[0]?.length).toBeGreaterThan(8)
    for (const sample of font.samples) await bank.store(sample)
    const fontProgram = programFromDef(font.def, 4)
    fontProgram.values = { ...fontProgram.values, ...flat, release: 80 }
    const [fontLeft] = await renderSampleProgram(fontProgram, [
      { sample: 0, pitch: 60, vel: 0.9 },
      { sample: 2000, pitch: 60, vel: 0 },
    ], rate, 3000, bank)
    expect(Math.max(...fontLeft.map((sample) => Math.abs(sample)))).toBeGreaterThan(0.05)
    for (const sample of fontLeft) expect(Number.isFinite(sample)).toBe(true)
  })

  it('is an instrument a track can keep', () => {
    const store = new ProjectStore(createEmptyProject())
    const ids = store.addTracks({ kind: 'midi', count: 1, instrument: 'sample', input: 'mic', channels: 1, armed: false })
    const track = store.project.tracks.find((item) => item.id === ids[0])!
    expect(track.instrument).toBe('sample')
    expect(track.name).toBe('Sample 1')
    expect(track.sampleProgram?.def.zones).toEqual([])
    expect(track.sampleProgram?.def.controls.every((control) => control.description.length > 12)).toBe(true)
    const before = arrangementDigest(store.project)
    const next = programFromDef({
      id: 'piano',
      name: 'Piano',
      zones: [makeZone({ id: 'c', sampleId: 'abc', root: 60, loKey: 60, hiKey: 64 })],
      articulations: [],
      mics: [],
      defaultArticulation: '',
      controls: [],
    }, 9)
    store.setSampleProgram(track.id, next)
    expect(track.sampleProgram?.def.name).toBe('Piano')
    expect(track.name).toBe('Piano')
    expect(arrangementDigest(store.project)).not.toBe(before)
    store.setSampleControl(track.id, 'level', 0.4)
    expect(track.sampleProgram?.values.level).toBe(0.4)
    store.setSampleArticulation(track.id, 'soft')
    expect(track.sampleProgram?.articulation).toBe('soft')
    store.undo()
    store.undo()
    store.undo()
    expect(store.project.tracks.find((item) => item.id === track.id)?.sampleProgram?.def.zones).toEqual([])
  })
})

function text(value: string) {
  return new TextEncoder().encode(value)
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
  const pad = data.length % 2
  const out = new Uint8Array(8 + data.length + pad)
  out.set(text(id), 0)
  new DataView(out.buffer).setUint32(4, data.length, true)
  out.set(data, 8)
  return out
}

function word(value: number) {
  const out = new Uint8Array(2)
  new DataView(out.buffer).setUint16(0, value, true)
  return out
}

function dword(value: number) {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value, true)
  return out
}

function name20(value: string) {
  const out = new Uint8Array(20)
  out.set(text(value).subarray(0, 20))
  return out
}

function gen(oper: number, amount: number) {
  const out = new Uint8Array(4)
  const view = new DataView(out.buffer)
  view.setUint16(0, oper, true)
  view.setUint16(2, amount, true)
  return out
}

function buildSf2(channel: Float32Array) {
  const pcm = new Uint8Array(channel.length * 2)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < channel.length; i++) {
    const code = Math.max(-32767, Math.min(32767, Math.round(channel[i] * 32767)))
    view.setInt16(i * 2, code, true)
  }
  const phdr = concat([
    name20('Piano'), word(0), word(0), word(0), dword(0), dword(0), dword(0),
    name20('EOP'), word(0), word(0), word(1), dword(0), dword(0), dword(0),
  ])
  const pbag = concat([word(0), word(0), word(3), word(0)])
  const pgen = concat([
    gen(43, 0 | (127 << 8)),
    gen(44, 0 | (127 << 8)),
    gen(41, 0),
  ])
  const inst = concat([
    name20('Piano'), word(0),
    name20('EOI'), word(1),
  ])
  const ibag = concat([word(0), word(0), word(7), word(0)])
  const igen = concat([
    gen(43, 0 | (127 << 8)),
    gen(44, 0 | (127 << 8)),
    gen(54, 1),
    gen(58, 60),
    gen(52, 0),
    gen(17, 0),
    gen(53, 0),
  ])
  const header = new Uint8Array(46)
  const sample = new DataView(header.buffer)
  header.set(name20('sine'))
  sample.setUint32(20, 0, true)
  sample.setUint32(24, channel.length, true)
  sample.setUint32(28, 32, true)
  sample.setUint32(32, channel.length - 32, true)
  sample.setUint32(36, rate, true)
  sample.setUint8(40, 60)
  sample.setInt8(41, 0)
  sample.setUint16(42, 0, true)
  sample.setUint16(44, 1, true)
  const shdr = concat([header, new Uint8Array(46)])
  const info = chunk('LIST', concat([text('INFO'), chunk('ifil', concat([word(2), word(1)])), chunk('INAM', text('Piano\0'))]))
  const sdta = chunk('LIST', concat([text('sdta'), chunk('smpl', pcm)]))
  const pdta = chunk('LIST', concat([
    text('pdta'),
    chunk('phdr', phdr),
    chunk('pbag', pbag),
    chunk('pmod', new Uint8Array(10)),
    chunk('pgen', pgen),
    chunk('inst', inst),
    chunk('ibag', ibag),
    chunk('imod', new Uint8Array(10)),
    chunk('igen', igen),
    chunk('shdr', shdr),
  ]))
  return chunk('RIFF', concat([text('sfbk'), info, sdta, pdta]))
}

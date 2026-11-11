import { describe, expect, it } from 'vitest'
import { createPlugin, defaultParams } from '../audio/plugins/catalog'
import { createTune } from '../audio/plugins/tune'
import { renderSamplerSpan } from '../audio/plugins/sampler'
import { yinPitch } from '../audio/plugins/psola'
import { MemoryBank } from '../audio/multisample/cache'
import { renderSampler } from '../audio/multisample/engine'
import { makeProgram, makeSample, makeZone } from '../audio/multisample/types'
import { renderNotes } from '../audio/rack/dsp'
import { makeDevice, nextArp, type DeviceKind } from '../model/rack'
import { emptySampler } from '../audio/sample/engine'
import { renderMpcAudio, padSendGain } from '../instruments/mpc/render'
import { planPads, vintageBitDepth, vintageRateHz } from '../audio/voices/program'
import { FACTORY_VINTAGE, slicesFor, type ChopSetup } from '../model/padChop'
import { createKit, type PadVoice } from '../model/padMachine'
import { shapeVelocity } from '../instruments/mpc/model'
import { BeatRepeat } from '../model/beatRepeat'
import { freshScaler, notesFromTones, scalerChords } from '../instruments/scaler/model'
import { renderArrangeInputs } from '../audio/arrangeSources'
import { createEmptyProject, makeTrack, type AudioAsset } from '../model/types'
import { activeLength, binEnergy, centsOff, measureHz, onsetCount, peak, rms, sine } from './helpers/dsp-measure'

const rate = 48000

function tone(freq: number, seconds: number, amp = 0.6) {
  return sine(rate, freq, Math.floor(rate * seconds), amp)
}

function padWith(bufferId: string, patch: Partial<PadVoice> = {}): PadVoice {
  const pad = createKit().banks[0][0]
  pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId }]
  pad.level = 1
  pad.decay = 1
  pad.filter = 1
  pad.attack = 0
  return { ...pad, ...patch, layers: patch.layers ?? pad.layers }
}

function hit(pad: PadVoice, samples: Float32Array, seconds = 0.35) {
  const buffers = new Map([[pad.layers[0].bufferId || 's', { sampleRate: rate, samples }]])
  return renderMpcAudio({
    sampleRate: rate,
    tempo: 120,
    notes: [{ pitch: pad.pitch, startBeat: 0, durationBeats: 1, velocity: 1 }],
    pads: [pad],
    buffers,
    output: 'audio',
  }).left.subarray(0, Math.floor(rate * seconds))
}

describe('sampler controls', () => {
  function render(params: Record<string, number>, samples: Float32Array, notes: { time: number; pitch: number; vel: number }[], seconds = 0.4, root = 60) {
    const plugin = createPlugin('sampler')
    plugin.params = { ...plugin.params, ...params }
    plugin.sampler = { ...emptySampler(), bufferId: 's', root, loopMode: Math.round(params.loopMode ?? 2) }
    const frames = Math.floor(rate * seconds)
    return renderSamplerSpan(plugin, samples, notes, rate, frames)[0]
  }

  it('raises pitch by 12 semitones to double the frequency', () => {
    const sample = tone(220, 0.2)
    const dry = render({ stretch: 0, pitch: 0, attack: 1, decay: 50, sustain: 1, release: 400 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    const up = render({ stretch: 0, pitch: 12, attack: 1, decay: 50, sustain: 1, release: 400 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    expect(centsOff(measureHz(up, rate, 800), measureHz(dry, rate, 800) * 2)).toBeLessThan(30)
    expect(activeLength(up)).toBeLessThan(activeLength(dry) * 0.7)
  })

  it('keeps the length and doubles the frequency when stretch is on', () => {
    const sample = tone(220, 0.12)
    const dry = render({ stretch: 1, pitch: 0, attack: 1, sustain: 1, release: 200 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.7)
    const up = render({ stretch: 1, pitch: 12, attack: 1, sustain: 1, release: 200 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.7)
    expect(centsOff(measureHz(up, rate, 2000), measureHz(dry, rate, 2000) * 2)).toBeLessThan(80)
    // Both stretches are one beat. The 0.01 floor also counts the 200ms release, where a pitched tail stays audible a little longer.
    expect(Math.abs(activeLength(up, 0.05) - activeLength(dry, 0.05)) / rate).toBeLessThan(0.02)
    expect(Math.abs(activeLength(up) - activeLength(dry)) / rate).toBeLessThan(0.1)
  })

  it('follows the root note', () => {
    const sample = tone(220, 0.2)
    const atRoot = render({ stretch: 0, keys: 1, attack: 1, sustain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.25, 60)
    const lower = render({ stretch: 0, keys: 1, attack: 1, sustain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.25, 72)
    expect(measureHz(lower, rate, 600)).toBeLessThan(measureHz(atRoot, rate, 600) * 0.6)
  })

  it('opens and closes the tone filter', () => {
    const sample = tone(3000, 0.25)
    const open = render({ stretch: 0, cutoff: 16000, attack: 1, sustain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    const dark = render({ stretch: 0, cutoff: 200, attack: 1, sustain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    expect(rms(dark, 1000, 4000)).toBeLessThan(rms(open, 1000, 4000) * 0.35)
  })

  it('sets attack, decay, sustain, release, and gain', () => {
    const sample = tone(220, 0.5)
    const base = { stretch: 0, pitch: 0, cutoff: 16000 }
    const slow = render({ ...base, attack: 180, decay: 40, sustain: 1, release: 40, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    const fast = render({ ...base, attack: 1, decay: 40, sustain: 1, release: 40, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }])
    expect(rms(slow, 0, 400)).toBeLessThan(rms(fast, 0, 400) * 0.5)
    const held = render({ ...base, attack: 1, decay: 30, sustain: 1, release: 300, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }, { time: 0.12, pitch: 60, vel: 0 }], 0.4)
    const dropped = render({ ...base, attack: 1, decay: 30, sustain: 0, release: 300, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }, { time: 0.12, pitch: 60, vel: 0 }], 0.4)
    expect(rms(dropped, 3000, 5000)).toBeLessThan(rms(held, 3000, 5000) * 0.55)
    const long = render({ ...base, attack: 1, decay: 20, sustain: 1, release: 400, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }, { time: 0.08, pitch: 60, vel: 0 }], 0.4)
    const short = render({ ...base, attack: 1, decay: 20, sustain: 1, release: 20, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }, { time: 0.08, pitch: 60, vel: 0 }], 0.4)
    expect(rms(short, 4500, 7000)).toBeLessThan(rms(long, 4500, 7000) * 0.5)
    const quiet = render({ ...base, attack: 1, sustain: 1, gain: 0.2 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.2)
    const loud = render({ ...base, attack: 1, sustain: 1, gain: 1 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.2)
    expect(rms(loud, 500, 3000)).toBeGreaterThan(rms(quiet, 500, 3000) * 2)
  })

  it('loops until once is selected', () => {
    const sample = tone(220, 0.05)
    const looped = render({ stretch: 0, loopMode: 0, attack: 1, sustain: 1, release: 800 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.3)
    const once = render({ stretch: 0, loopMode: 2, attack: 1, sustain: 1, release: 800 }, sample, [{ time: 0, pitch: 60, vel: 1 }], 0.3)
    expect(rms(looped, Math.floor(rate * 0.12), Math.floor(rate * 0.2))).toBeGreaterThan(rms(once, Math.floor(rate * 0.12), Math.floor(rate * 0.2)) * 3)
  })
})

describe('library instrument controls', () => {
  function play(play: { tune?: number; attack?: number; decay?: number; sustain?: number; release?: number; tone?: number; loop?: boolean }, seconds = 0.4) {
    const sample = tone(440, 0.08)
    const bank = new MemoryBank()
    bank.put('a', { sampleRate: rate, channels: [sample] })
    const program = makeProgram({
      name: 'Tone',
      samples: [makeSample({ id: 'a', sampleRate: rate, frameCount: sample.length })],
      zones: [makeZone({
        id: 'z',
        sampleId: 'a',
        root: 69,
        loopMode: 'none',
        ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.05 },
      })],
      play: {
        tune: play.tune ?? 0,
        attack: play.attack ?? 0,
        decay: play.decay ?? 0,
        sustain: play.sustain ?? 1,
        release: play.release ?? 0.2,
        tone: play.tone ?? 20000,
        loop: play.loop,
      },
    })
    const frames = Math.floor(rate * seconds)
    return renderSampler(program, [{ sample: 0, pitch: 69, vel: 1 }, { sample: Math.floor(rate * 0.12), pitch: 69, vel: 0 }], rate, frames, bank)[0]
  }

  it('tunes in semitones', () => {
    const dry = play({ tune: 0, attack: 0, sustain: 1, release: 0.3 })
    const up = play({ tune: 12, attack: 0, sustain: 1, release: 0.3 })
    expect(centsOff(measureHz(up, rate, 400), measureHz(dry, rate, 400) * 2)).toBeLessThan(40)
  })

  it('shapes the envelope and the tone', () => {
    const slow = play({ attack: 0.08, sustain: 1, release: 0.2 })
    const fast = play({ attack: 0, sustain: 1, release: 0.2 })
    expect(rms(slow, 400, 1200)).toBeLessThan(rms(fast, 400, 1200) * 0.7)
    const held = play({ attack: 0, decay: 0.02, sustain: 1, release: 0.25 })
    const dropped = play({ attack: 0, decay: 0.02, sustain: 0, release: 0.25 })
    expect(rms(dropped, 2000, 4000)).toBeLessThan(rms(held, 2000, 4000))
    const bright = tone(3000, 0.2)
    const bank = new MemoryBank()
    bank.put('a', { sampleRate: rate, channels: [bright] })
    const program = (toneHz: number) => makeProgram({
      name: 'Bright',
      samples: [makeSample({ id: 'a', sampleRate: rate })],
      zones: [makeZone({ id: 'z', sampleId: 'a', root: 69, ampeg: { attack: 0, hold: 0, decay: 0, sustain: 1, release: 0.2 } })],
      play: { tune: 0, attack: 0, decay: 0, sustain: 1, release: 0.2, tone: toneHz },
    })
    const open = renderSampler(program(20000), [{ sample: 0, pitch: 69, vel: 1 }], rate, Math.floor(rate * 0.15), bank)[0]
    const dark = renderSampler(program(300), [{ sample: 0, pitch: 69, vel: 1 }], rate, Math.floor(rate * 0.15), bank)[0]
    expect(rms(dark, 400, 2000)).toBeLessThan(rms(open, 400, 2000) * 0.5)
  })

  it('loops the zone when Loop is on', () => {
    const once = play({ loop: false, attack: 0, sustain: 1, release: 0.4 }, 0.3)
    const looped = play({ loop: true, attack: 0, sustain: 1, release: 0.4 }, 0.3)
    expect(rms(looped, Math.floor(rate * 0.12), Math.floor(rate * 0.22))).toBeGreaterThan(rms(once, Math.floor(rate * 0.12), Math.floor(rate * 0.22)) * 2)
  })
})

describe('beat machine controls', () => {
  it('doubles the frequency at +12 and keeps the length in stretch', () => {
    const sample = tone(220, 0.2)
    const vinyl = hit(padWith('s', { tune: 12, pitchMode: 'vinyl' }), sample, 0.25)
    const flat = hit(padWith('s', { tune: 0, pitchMode: 'vinyl' }), sample, 0.25)
    expect(centsOff(measureHz(vinyl, rate, 400), measureHz(flat, rate, 400) * 2)).toBeLessThan(35)
    expect(activeLength(vinyl)).toBeLessThan(activeLength(flat) * 0.7)
    const stretched = hit(padWith('s', { tune: 12, pitchMode: 'stretch' }), sample, 0.3)
    const straight = hit(padWith('s', { tune: 0, pitchMode: 'stretch' }), sample, 0.3)
    expect(centsOff(measureHz(stretched, rate, 800), measureHz(straight, rate, 800) * 2)).toBeLessThan(200)
    expect(Math.abs(activeLength(stretched) - activeLength(straight)) / activeLength(straight)).toBeLessThan(0.2)
  })

  it('moves fine pitch by the cents knob', () => {
    const sample = tone(440, 0.2)
    const up = hit(padWith('s', { tuneCents: 100, pitchMode: 'vinyl' }), sample)
    const flat = hit(padWith('s', { tuneCents: 0, pitchMode: 'vinyl' }), sample)
    expect(centsOff(measureHz(up, rate, 500), measureHz(flat, rate, 500) * 2 ** (100 / 1200))).toBeLessThan(25)
  })

  it('bit crush, sample-rate reduction, wow, crackle, and the vintage low-pass', () => {
    const sample = tone(880, 0.25, 0.8)
    const clean = hit(padWith('s'), sample)
    const crushed = renderVintage(sample, { bits: 1, rate: 0, wow: 0, crackle: 0, lowpass: 0 })
    expect(vintageBitDepth(1)).toBeLessThanOrEqual(4)
    expect(rmsError(crushed, clean)).toBeGreaterThan(0.01)
    const reduced = renderVintage(tone(15000, 0.2, 0.8), { bits: 0, rate: 1, wow: 0, crackle: 0, lowpass: 0 })
    const full = hit(padWith('s'), tone(15000, 0.2, 0.8), 0.2)
    expect(vintageRateHz(1)).toBeLessThan(8000)
    expect(binEnergy(reduced, rate, 15000, 200)).toBeLessThan(binEnergy(full, rate, 15000, 200) * 0.5)
    expect(binEnergy(reduced, rate, 1000, 200)).toBeGreaterThan(binEnergy(full, rate, 1000, 200))
    const wobbled = renderVintage(sample, { bits: 0, rate: 0, wow: 1, crackle: 0, lowpass: 0 })
    expect(rmsError(wobbled, clean)).toBeGreaterThan(0.002)
    const noisy = renderVintage(tone(220, 0.25, 0.2), { bits: 0, rate: 0, wow: 0, crackle: 1, lowpass: 0 })
    const quiet = hit(padWith('s'), tone(220, 0.25, 0.2))
    expect(peak(noisy)).toBeGreaterThan(peak(quiet) + 0.05)
    const dull = renderVintage(tone(6000, 0.2, 0.7), { bits: 0, rate: 0, wow: 0, crackle: 0, lowpass: 1 })
    const bright = hit(padWith('s'), tone(6000, 0.2, 0.7), 0.2)
    expect(rms(dull, 200, 2000)).toBeLessThan(rms(bright, 200, 2000) * 0.6)
    expect(vintageBitDepth(0.85)).toBe(13)
    expect(vintageRateHz(0.8)).toBe(24000)
    expect(FACTORY_VINTAGE[0].name).toBe('SP-1200')
  })

  it('high-pass and low-pass follow their knobs', () => {
    const low = tone(80, 0.25)
    const open = hit(padWith('s', { highpass: 0 }), low)
    const cut = hit(padWith('s', { highpass: 1 }), low)
    expect(rms(cut, 400, 3000)).toBeLessThan(rms(open, 400, 3000) * 0.45)
    const bright = tone(5000, 0.2)
    const wide = hit(padWith('s', { filter: 1 }), bright, 0.2)
    const closed = hit(padWith('s', { filter: 0.05 }), bright, 0.2)
    expect(rms(closed, 200, 2000)).toBeLessThan(rms(wide, 200, 2000) * 0.5)
  })

  it('choke stops the other voice in the group', () => {
    const a = padWith('a', { choke: 1, pitch: 36 })
    const b = padWith('b', { choke: 1, pitch: 38 })
    const buffers = new Map([
      ['a', { sampleRate: rate, samples: tone(220, 0.4) }],
      ['b', { sampleRate: rate, samples: tone(660, 0.2) }],
    ])
    const both = renderMpcAudio({
      sampleRate: rate,
      tempo: 120,
      notes: [
        { pitch: 36, startBeat: 0, durationBeats: 1, velocity: 1 },
        { pitch: 38, startBeat: 0.5, durationBeats: 0.5, velocity: 1 },
      ],
      pads: [a, b],
      buffers,
      output: 'audio',
    }).left
    const at = Math.floor(rate * 0.2)
    const after = Math.floor(rate * 0.28)
    expect(centsOff(measureHz(both, rate, at), 220)).toBeLessThan(40)
    expect(centsOff(measureHz(both, rate, after), 660)).toBeLessThan(50)
    expect(binEnergy(both, rate, 220, after)).toBeLessThan(binEnergy(both, rate, 220, at) * 0.4)
  })

  it('note repeat speaks once per grid division', () => {
    const clock = { originContext: 0, originBeat: 0, tempo: 120, sampleRate: rate, free: true }
    const repeat = new BeatRepeat()
    repeat.arm({ pitch: 36, velocity: 0.9, fromBeat: 0, interval: 0.25, swing: 0, free: true })
    const taken = repeat.take(clock, 0, 1)
    expect(taken.play.length).toBe(8)
    const sample = tone(180, 0.04)
    const pad = padWith('s', { pitch: 36, decay: 0.25 })
    const audio = renderMpcAudio({
      sampleRate: rate,
      tempo: 120,
      notes: taken.play.map((item) => ({ pitch: 36, startBeat: item.beat, durationBeats: 0.05, velocity: item.velocity })),
      pads: [pad],
      buffers: new Map([['s', { sampleRate: rate, samples: sample }]]),
      output: 'audio',
    }).left
    expect(onsetCount(audio, rate, 0.08)).toBeGreaterThanOrEqual(6)
  })

  it('velocity sensitivity and the fixed curve change the hit', () => {
    const soft = shapeVelocity(0.2, { curve: 0, amount: 1, min: 0, max: 1, fixed: 0.9, sensitivity: 1 })
    const hard = shapeVelocity(0.2, { curve: 0, amount: 1, min: 0, max: 1, fixed: 0.9, sensitivity: 0 })
    const fixed = shapeVelocity(0.2, { curve: 3, amount: 1, min: 0, max: 1, fixed: 0.4, sensitivity: 1 })
    expect(hard).toBeGreaterThan(soft + 0.4)
    expect(fixed).toBeCloseTo(0.4)
    const sample = tone(200, 0.1)
    const quiet = hit(padWith('s'), sample, 0.1)
    const loudPad = padWith('s')
    const loud = renderMpcAudio({
      sampleRate: rate,
      tempo: 120,
      notes: [{ pitch: loudPad.pitch, startBeat: 0, durationBeats: 0.2, velocity: hard }],
      pads: [loudPad],
      buffers: new Map([['s', { sampleRate: rate, samples: sample }]]),
      output: 'audio',
    }).left
    const gentle = renderMpcAudio({
      sampleRate: rate,
      tempo: 120,
      notes: [{ pitch: loudPad.pitch, startBeat: 0, durationBeats: 0.2, velocity: soft }],
      pads: [loudPad],
      buffers: new Map([['s', { sampleRate: rate, samples: sample }]]),
      output: 'audio',
    }).left
    expect(rms(loud, 200, 1500)).toBeGreaterThan(rms(gentle, 200, 1500) * 1.5)
    expect(rms(quiet)).toBeGreaterThan(0)
  })

  it('volume, pan, decay, attack, reverse, and loop change the voice', () => {
    const sample = tone(240, 0.3)
    const loud = hit(padWith('s', { level: 1 }), sample, 0.15)
    const quiet = hit(padWith('s', { level: 0.25 }), sample, 0.15)
    expect(rms(loud, 200, 2000)).toBeGreaterThan(rms(quiet, 200, 2000) * 2)
    const left = planPads({
      pads: [padWith('s', { pan: -1 })],
      buffers: [{ id: 's', samples: sample, sampleRate: rate }],
      sampleRate: rate,
      tempo: 120,
    })
    expect(left.slots[0].pan).toBe(-1)
    const short = hit(padWith('s', { decay: 0.2 }), sample, 0.3)
    const full = hit(padWith('s', { decay: 1 }), sample, 0.3)
    expect(activeLength(short)).toBeLessThan(activeLength(full) * 0.55)
    const slow = hit(padWith('s', { attack: 1, decay: 1 }), sample, 0.2)
    const snap = hit(padWith('s', { attack: 0, decay: 1 }), sample, 0.2)
    expect(rms(slow, 0, 400)).toBeLessThan(rms(snap, 0, 400) * 0.5)
    const ramp = new Float32Array(Math.floor(rate * 0.2))
    for (let i = 0; i < ramp.length; i++) ramp[i] = (i / ramp.length) * 0.8
    const forward = hit(padWith('s', { region: { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: false } }), ramp, 0.12)
    const back = hit(padWith('s', { region: { start: 0, end: 1, loop: false, loopStart: 0, loopEnd: 1, reverse: true } }), ramp, 0.12)
    expect(rms(forward, 200, 800)).toBeLessThan(rms(back, 200, 800) * 0.7)
    const once = hit(padWith('s', { decay: 1, region: { start: 0, end: 0.15, loop: false, loopStart: 0, loopEnd: 1, reverse: false } }), sample, 0.4)
    const looped = hit(padWith('s', { decay: 1, region: { start: 0, end: 0.15, loop: true, loopStart: 0, loopEnd: 1, reverse: false } }), sample, 0.4)
    expect(rms(looped, Math.floor(rate * 0.15), Math.floor(rate * 0.3))).toBeGreaterThan(rms(once, Math.floor(rate * 0.15), Math.floor(rate * 0.3)) * 2)
  })

  it('sends the pad to the bus by the send amount', async () => {
    expect(padSendGain(0, 1)).toBe(0)
    expect(padSendGain(1, 0.5)).toBeCloseTo(0.5)
    const sample = tone(200, 0.12)
    const song = (send: number) => {
      const kit = createKit()
      const pad = kit.banks[0][0]
      pad.layers = [{ velocityLo: 0, velocityHi: 1, tune: 0, bufferId: 's' }]
      pad.send = send
      pad.level = 1
      pad.decay = 1
      const pads = makeTrack({
        id: 'pads',
        name: 'Pads',
        type: 'midi',
        volume: 1,
        pan: 0,
        input: 'none',
        instrument: 'pads',
        padKit: kit,
        sends: [{ id: 'send', busId: 'bus', gain: 1, preFader: false, enabled: true }],
      })
      pads.midiClips = [{ id: 'c', name: 'c', startBeat: 0, durationBeats: 1, notes: [{ id: 'n', pitch: pad.pitch, startBeat: 0, durationBeats: 0.5, velocity: 1 }] }]
      const bus = makeTrack({ id: 'bus', name: 'Bus', type: 'bus', volume: 1, pan: 0, input: 'none' })
      const project = createEmptyProject(rate, 'Send')
      project.tracks = [pads, bus]
      project.masterPlugins = []
      return project
    }
    const asset: AudioAsset = { id: 's', name: 's', sampleRate: rate, channels: [sample] }
    const dry = await renderArrangeInputs(song(0), new Map([['s', asset]]), 0, Math.floor(rate * 0.2))
    const wet = await renderArrangeInputs(song(1), new Map([['s', asset]]), 0, Math.floor(rate * 0.2))
    expect(rms(dry.get('bus')![0])).toBeLessThan(0.001)
    expect(rms(wet.get('bus')![0], 200, 2000)).toBeGreaterThan(0.02)
  })

  it('even chop puts a later slice on the next pad', () => {
    const data = new Float32Array(rate)
    for (let i = rate / 2; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 330 * i) / rate) * 0.7
    const setup: ChopSetup = {
      bufferId: 's', name: 'Chop', mode: 'even', even: 4, sensitivity: 0.5, grid: 'quarter',
      tempoSource: 'project', sampleBpm: 120, sliceStart: 'start', markers: [], root: 0, modeName: 'minor',
      semitones: 0, cents: 0, pitchMode: 'vinyl', highpass: 0,
    }
    const slices = slicesFor(setup, data, rate, 120)
    expect(slices.length).toBe(4)
    const first = padWith('s', { pitch: 36, region: { start: slices[0].start / data.length, end: slices[0].end / data.length, loop: false, loopStart: 0, loopEnd: 1, reverse: false } })
    const later = padWith('s', { pitch: 37, region: { start: slices[2].start / data.length, end: slices[2].end / data.length, loop: false, loopStart: 0, loopEnd: 1, reverse: false } })
    const early = hit(first, data, 0.2)
    const late = hit(later, data, 0.2)
    expect(rms(early, 100, 1500)).toBeLessThan(0.02)
    expect(rms(late, 100, 1500)).toBeGreaterThan(0.05)
  })
})

describe('synth controls', () => {
  function voice(kind: DeviceKind, params: Record<string, number>, frames = 6000, notes: { sample: number; pitch: number; vel: number }[] = [{ sample: 0, pitch: 69, vel: 0.9 }]) {
    const device = makeDevice(kind)
    Object.assign(device.params, params)
    return renderNotes({ devices: [device], cables: [], polyphony: 4 }, notes, rate, 120, frames)[0]
  }

  it('analog cutoff, resonance, drive, and mod mix the oscillators', () => {
    const open = voice('sub', { wave1: 4, mix2: 0, mix3: 0, cutoff: 14000, res: 0, attack: 1, sustain: 1, uni: 1 })
    const dark = voice('sub', { wave1: 4, mix2: 0, mix3: 0, cutoff: 200, res: 0, attack: 1, sustain: 1, uni: 1 })
    expect(rms(dark, 800, 3000)).toBeLessThan(rms(open, 800, 3000))
    const driven = voice('sub', { wave1: 0, mix2: 0, mix3: 0, cutoff: 14000, res: 0, famt: 0, drive: 1, attack: 1, sustain: 1, uni: 1 })
    const clean = voice('sub', { wave1: 0, mix2: 0, mix3: 0, cutoff: 14000, res: 0, famt: 0, drive: 0, attack: 1, sustain: 1, uni: 1 })
    expect(rms(driven, 400, 3000)).not.toBeCloseTo(rms(clean, 400, 3000), 2)
    const second = voice('sub', { wave1: 4, mix1: 0, mix2: 1, mix3: 0, detune: 40, cutoff: 14000, res: 0, famt: 0, attack: 1, sustain: 1, uni: 1 })
    const alone = voice('sub', { wave1: 4, mix1: 1, mix2: 0, mix3: 0, detune: 0, cutoff: 14000, res: 0, famt: 0, attack: 1, sustain: 1, uni: 1 })
    let diff = 0
    for (let i = 800; i < 3000; i++) diff += Math.abs((second[i] || 0) - (alone[i] || 0))
    expect(diff).toBeGreaterThan(20)
  })

  it('FM mod mix adds the modulator', () => {
    const plain = voice('fm', { mode: 0, index: 0, ratio: 2, algo: 0, attack: 1, sustain: 1, feedback: 0 })
    const mixed = voice('fm', { mode: 1, index: 0, ratio: 2, algo: 0, attack: 1, sustain: 1, feedback: 0 })
    expect(rms(mixed, 400, 3000)).not.toBeCloseTo(rms(plain, 400, 3000), 2)
    const indexed = voice('fm', { mode: 0, index: 4, ratio: 3, algo: 0, attack: 1, sustain: 1 })
    const bare = voice('fm', { mode: 0, index: 0, ratio: 1, algo: 0, attack: 1, sustain: 1 })
    expect(binEnergy(indexed, rate, 440, 800)).not.toBeCloseTo(binEnergy(bare, rate, 440, 800), 2)
  })

  it('wavetable position and filter move the tone', () => {
    const start = voice('wave', { table: 1, position: 0, warp: 0, cutoff: 14000, attack: 1, sustain: 1, uni: 1 })
    const later = voice('wave', { table: 1, position: 1, warp: 0, cutoff: 14000, attack: 1, sustain: 1, uni: 1 })
    expect(rms(start, 400, 3000)).not.toBeCloseTo(rms(later, 400, 3000), 2)
    const open = voice('wave', { table: 1, position: 1, cutoff: 12000, attack: 1, sustain: 1, uni: 1 })
    const dark = voice('wave', { table: 1, position: 1, cutoff: 300, attack: 1, sustain: 1, uni: 1 })
    expect(rms(dark, 800, 3000)).toBeLessThan(rms(open, 800, 3000))
  })

  it('knock decay, tone, and level follow the knobs', () => {
    const long = voice('knock', { decay: 800, sustain: 0.8, cutoff: 8000, level: 0.8, attack: 0, morph: 0.2 }, 8000)
    const short = voice('knock', { decay: 30, sustain: 0, cutoff: 8000, level: 0.8, attack: 0, morph: 0.2 }, 8000)
    expect(activeLength(short, 0.02)).toBeLessThan(activeLength(long, 0.02))
    const bright = voice('knock', { decay: 200, sustain: 0.6, cutoff: 8000, level: 0.8, attack: 0 }, 4000)
    const dark = voice('knock', { decay: 200, sustain: 0.6, cutoff: 200, level: 0.8, attack: 0 }, 4000)
    expect(rms(dark, 400, 2000)).toBeLessThan(rms(bright, 400, 2000))
    const loud = voice('knock', { decay: 200, sustain: 0.5, cutoff: 4000, level: 1, attack: 0 }, 3000)
    const quiet = voice('knock', { decay: 200, sustain: 0.5, cutoff: 4000, level: 0.15, attack: 0 }, 3000)
    expect(rms(loud, 200, 1500)).toBeGreaterThan(rms(quiet, 200, 1500) * 2)
  })

  it('filter high-pass removes lows and the arp direction reverses', () => {
    const device = makeDevice('sub')
    Object.assign(device.params, { wave1: 4, mix2: 0, mix3: 0, cutoff: 400, attack: 1, sustain: 1, uni: 1 })
    const low = makeDevice('filter')
    low.params.cutoff = 200
    low.params.mode = 0
    const high = makeDevice('filter')
    high.params.cutoff = 2000
    high.params.mode = 1
    const lows = renderNotes({ devices: [device, low], cables: [{ id: 'c', from: device.id, fromPort: 'audio', to: low.id, toPort: 'audio', amount: 1 }], polyphony: 2 }, [{ sample: 0, pitch: 45, vel: 0.9 }], rate, 120, 4000)[0]
    const highs = renderNotes({ devices: [device, high], cables: [{ id: 'c', from: device.id, fromPort: 'audio', to: high.id, toPort: 'audio', amount: 1 }], polyphony: 2 }, [{ sample: 0, pitch: 45, vel: 0.9 }], rate, 120, 4000)[0]
    expect(rms(highs, 500, 2500)).toBeLessThan(rms(lows, 500, 2500))
    expect(nextArp([60, 64, 67], 0, 0, 1)).toBe(60)
    expect(nextArp([60, 64, 67], 0, 1, 1)).toBe(67)
  })

  it('keeps factory defaults inside each knob range', () => {
    for (const kind of ['sub', 'fm', 'wave', 'knock'] as DeviceKind[]) {
      const device = makeDevice(kind)
      for (const spec of Object.values(device.params)) void spec
      expect(defaultParams('tune').retune).toBeGreaterThan(0)
    }
  })
})

describe('scaler controls', () => {
  it('plays the notes of the chosen scale and chord', () => {
    const song = createEmptyProject()
    const scale = song.scale!
    scale.root = 0
    scale.scale = 'ionian'
    scale.arp = 'off'
    scale.rate = 0.5
    scale.gate = 0.8
    const major = freshScaler(song)
    major.group = 'triad'
    const chords = scalerChords(major)
    const c = notesFromTones(major, chords[0].tones, 2).notes.map((note) => ((note.pitch % 12) + 12) % 12).sort((a, b) => a - b)
    expect(c).toEqual([0, 4, 7])
    const minor = { ...major, scale: 'aeolian' as const }
    const cm = notesFromTones(minor, scalerChords(minor)[0].tones, 2).notes.map((note) => ((note.pitch % 12) + 12) % 12).sort((a, b) => a - b)
    expect(cm).toContain(3)
    expect(cm).not.toContain(4)
  })

  it('rate and gate change the pattern', () => {
    const paced = createEmptyProject()
    const timing = paced.scale!
    timing.root = 0
    timing.scale = 'ionian'
    timing.arp = 'up'
    timing.rate = 0.5
    timing.gate = 0.8
    const state = freshScaler(paced)
    const tones = scalerChords({ ...state, group: 'triad' })[0].tones
    const slow = notesFromTones({ ...state, arp: 'up', rate: 1, gate: 0.9 }, tones, 2).notes
    const fast = notesFromTones({ ...state, arp: 'up', rate: 0.25, gate: 0.2 }, tones, 2).notes
    expect(fast.length).toBeGreaterThan(slow.length)
    expect(fast[0].durationBeats).toBeLessThan(slow[0].durationBeats)
  })
})

describe('auto-tune controls', () => {
  const major = [0, 2, 4, 5, 7, 9, 11]
  function run(params: Record<string, number>, freq: number, root = 0) {
    const input = tone(freq, 0.7, 0.35)
    const proc = createTune(rate)
    const left = new Float32Array(input.length)
    const block = 128
    for (let offset = 0; offset < input.length; offset += block) {
      const count = Math.min(block, input.length - offset)
      proc.process(
        [input.subarray(offset, offset + count), input.subarray(offset, offset + count)],
        [left.subarray(offset, offset + count), new Float32Array(count)],
        { ...defaultParams('tune'), ...params },
        { sampleRate: rate, tempo: 120, sampleTime: offset, sidechain: null, scaleRoot: root, scaleIntervals: major, scaleCents: major.map((step) => step * 100), quality: 'full', offline: true },
      )
    }
    const skip = Math.floor(rate * 0.35)
    return yinPitch(left.subarray(skip, skip + 4096), rate, 80, 1200).hz
  }

  it('retune speed and the key pull an off-pitch tone onto the scale', () => {
    const target = 440 * 2 ** ((65 - 69) / 12)
    const fast = run({ amount: 1, retune: 1, humanize: 0, flex: 0, formant: 0, mode: 1, root: 0, scaleIndex: 0 }, 360)
    const slow = run({ amount: 1, retune: 0.05, humanize: 0, flex: 0, formant: 0, mode: 1, root: 0, scaleIndex: 0 }, 360)
    const dry = run({ amount: 0, retune: 1, humanize: 0, mode: 1, root: 0, scaleIndex: 0 }, 360)
    expect(centsOff(fast, target)).toBeLessThan(40)
    expect(centsOff(slow, 360)).toBeLessThan(centsOff(fast, 360))
    expect(centsOff(dry, 360)).toBeLessThan(30)
    const a = run({ amount: 1, retune: 1, humanize: 0, flex: 0, mode: 1, root: 9, scaleIndex: 0 }, 360, 9)
    expect(centsOff(a, 440 * 2 ** ((66 - 69) / 12))).toBeLessThan(45)
  })

  it('humanize leaves more of the original pitch', () => {
    const natural = run({ amount: 1, retune: 1, humanize: 1, flex: 0, mode: 1, root: 0, scaleIndex: 0 }, 360)
    const hard = run({ amount: 1, retune: 1, humanize: 0, flex: 0, mode: 1, root: 0, scaleIndex: 0 }, 360)
    expect(centsOff(natural, 360)).toBeLessThan(centsOff(hard, 360))
  })
})

function renderVintage(samples: Float32Array, row: { bits: number; rate: number; wow: number; crackle: number; lowpass: number }) {
  const pad = padWith('s')
  const table = {
    wow: { amount: row.wow, curve: 'linear' as const },
    crackle: { amount: row.crackle, curve: 'linear' as const },
    lowpass: { amount: row.lowpass, curve: 'linear' as const },
    bits: { amount: row.bits, curve: 'linear' as const },
    rate: { amount: row.rate, curve: 'linear' as const },
  }
  return renderMpcAudio({
    sampleRate: rate,
    tempo: 120,
    notes: [{ pitch: pad.pitch, startBeat: 0, durationBeats: 1, velocity: 1 }],
    pads: [pad],
    buffers: new Map([['s', { sampleRate: rate, samples }]]),
    output: 'audio',
    vintage: { macro: 1, table, presetName: '' },
  }).left
}

function rmsError(a: ArrayLike<number>, b: ArrayLike<number>) {
  const n = Math.min(a.length, b.length, 4000)
  let sum = 0
  for (let i = 200; i < n; i++) {
    const delta = (a[i] || 0) - (b[i] || 0)
    sum += delta * delta
  }
  return Math.sqrt(sum / Math.max(1, n - 200))
}
